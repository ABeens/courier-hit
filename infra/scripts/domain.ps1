# Puesta en marcha del dominio: certificado, alias y comprobacion del DNS.
#
# El runbook completo, con el porque de cada decision, esta en
# docs/15-dominio.md. Aqui solo estan los comandos.
#
# Contexto que conviene no olvidar:
#   - El DNS vive en Squarespace y NO se mueve a Route 53: la zona tiene los MX
#     del Google Workspace de la empresa. Los registros se ponen a mano.
#   - Por eso el apex no puede apuntar a CloudFront (un apex no admite CNAME):
#     el host canonico es www y el apex se resuelve con el reenvio del panel.
#   - ACM da 72 HORAS para que aparezcan los CNAME de validacion. Pasadas, el
#     certificado muere y hay que pedir otro.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 status
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 request
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 dns
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 deploy

param(
  [ValidateSet('status', 'request', 'dns', 'deploy', 'records', 'ses')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

# Tienen que coincidir con infra/lib/config.ts. Si cambian ahi, cambian aqui.
$Region = 'us-east-1'
$Domain = 'hsglobal-services.com'
$SiteHost = "www.$Domain"
$ApiHost = "api.$Domain"
# Remitente de los correos. Es una direccion suelta y no el dominio entero
# porque verificar el dominio son tres CNAME en Squarespace (docs/15 §1.3).
$Sender = "servicioalcliente@$Domain"
$AppStack = 'courier-prod-app'
$BaseStack = 'courier-prod-base'

# Resolver publico, no el del equipo: lo que importa es lo que ve internet, no
# lo que tenga cacheado esta maquina.
$Resolver = '8.8.8.8'

# El servidor autoritativo de la zona (Squarespace hereda los NS de Google
# Domains). Sirve para saber si un registro que falta es que no esta creado o es
# que todavia no ha propagado: son dos problemas distintos.
$Authoritative = 'ns-cloud-c1.googledomains.com'

function Get-ConfiguredArn {
  # Sobre el fichero entero y no linea a linea: el ARN es largo y el formateador
  # lo parte en dos lineas, asi que un patron anclado al principio de linea deja
  # de encontrarlo justo cuando ya esta puesto.
  $config = Join-Path $PSScriptRoot '..\lib\config.ts'
  if (-not (Test-Path $config)) { return '' }
  $texto = Get-Content $config -Raw
  $m = [regex]::Match($texto, "CERTIFICATE_ARN\s*=\s*'([^']*)'")
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# La CLI de AWS devuelve el JSON en varias lineas, y PowerShell 5.1 lo entrega
# como string[]. ConvertFrom-Json con un array delante hace cosas raras (junta
# las lineas a su manera y llega a fundir dos objetos en uno), asi que SIEMPRE
# se le pasa una sola cadena.
function ConvertFrom-AwsJson($salida) {
  if (-not $salida) { return $null }
  return (($salida -join "`n") | ConvertFrom-Json)
}

function Get-Certificates {
  $json = aws acm list-certificates --region $Region `
    --query "CertificateSummaryList[?DomainName=='$Domain']" --output json
  $parsed = ConvertFrom-AwsJson $json
  if (-not $parsed) { return @() }
  return @($parsed)
}

function Get-CertificateDetail($arn) {
  $json = aws acm describe-certificate --region $Region --certificate-arn $arn `
    --query 'Certificate' --output json
  return ConvertFrom-AwsJson $json
}

function Show-ValidationRecords($cert) {
  Write-Host ''
  Write-Host 'Registros CNAME de validacion (van en Squarespace):' -ForegroundColor Cyan
  foreach ($opt in $cert.DomainValidationOptions) {
    if (-not $opt.ResourceRecord) { continue }
    # Sin el punto final y sin el sufijo del dominio: Squarespace lo anade solo.
    $name = $opt.ResourceRecord.Name.TrimEnd('.')
    $short = $name -replace "\.$([regex]::Escape($Domain))$", ''
    Write-Host ''
    Write-Host "  $($opt.DomainName)  [$($opt.ValidationStatus)]"
    Write-Host "    Nombre : $short"
    Write-Host '    Tipo   : CNAME'
    Write-Host "    Datos  : $($opt.ResourceRecord.Value.TrimEnd('.'))"

    $resolved = Resolve-DnsName -Name $name -Type CNAME -Server $Resolver -ErrorAction SilentlyContinue
    if ($resolved) {
      Write-Host '    En DNS : si, ya resuelve' -ForegroundColor Green
    }
    else {
      Write-Host '    En DNS : NO resuelve todavia' -ForegroundColor Yellow
    }
  }
}

function Invoke-Status {
  Write-Host "Certificados de $Domain en $Region" -ForegroundColor Cyan
  $certs = Get-Certificates
  if ($certs.Count -eq 0) {
    Write-Host '  No hay ninguno. Siguiente paso: domain.ps1 request'
    return
  }

  foreach ($c in $certs) {
    $detail = Get-CertificateDetail $c.CertificateArn
    $color = 'Yellow'
    if ($detail.Status -eq 'ISSUED') { $color = 'Green' }
    if ($detail.Status -in @('FAILED', 'VALIDATION_TIMED_OUT', 'REVOKED', 'EXPIRED')) { $color = 'Red' }

    Write-Host ''
    Write-Host "  $($detail.CertificateArn)"
    Write-Host "  Estado : $($detail.Status)" -ForegroundColor $color
    Write-Host "  Cubre  : $($detail.SubjectAlternativeNames -join ', ')"
    Write-Host "  Pedido : $($detail.CreatedAt)"

    if ($detail.Status -eq 'PENDING_VALIDATION') {
      $limite = ([datetime]$detail.CreatedAt).AddHours(72)
      Write-Host "  OJO: ACM deja de esperar el $limite. Despues hay que pedir otro." -ForegroundColor Yellow
      Show-ValidationRecords $detail
    }
    elseif ($detail.Status -eq 'ISSUED') {
      if ((Get-ConfiguredArn) -eq $detail.CertificateArn) {
        Write-Host '  Ya esta en CERTIFICATE_ARN (infra/lib/config.ts). Falta desplegar:' -ForegroundColor Green
        Write-Host '    domain.ps1 deploy'
      }
      else {
        Write-Host '  Paso 3: pegar este ARN en CERTIFICATE_ARN (infra/lib/config.ts) y desplegar.'
      }
    }
    else {
      Write-Host '  Inservible. No revive poniendo los registros ahora; hay que pedir uno nuevo.'
    }
  }
}

function Invoke-Request {
  # Antes de pedir: si ya hay uno vivo, no se crea otro. Certificados sueltos en
  # la cuenta solo sirven para confundir sobre cual es el bueno.
  foreach ($c in Get-Certificates) {
    $detail = Get-CertificateDetail $c.CertificateArn
    if ($detail.Status -in @('ISSUED', 'PENDING_VALIDATION')) {
      Write-Host "Ya hay un certificado en estado $($detail.Status):" -ForegroundColor Yellow
      Write-Host "  $($detail.CertificateArn)"
      Write-Host 'No se pide otro. Mira domain.ps1 status.'
      return
    }
  }

  Write-Host "Pidiendo certificado para $Domain y $SiteHost en $Region..."
  $arn = aws acm request-certificate --region $Region `
    --domain-name $Domain `
    --subject-alternative-names $SiteHost `
    --validation-method DNS `
    --query 'CertificateArn' --output text

  Write-Host "Certificado: $arn" -ForegroundColor Green

  # ACM tarda unos segundos en publicar los registros de validacion.
  $detail = $null
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 3
    $detail = Get-CertificateDetail $arn
    $conRegistro = @($detail.DomainValidationOptions | Where-Object { $_.ResourceRecord })
    if ($conRegistro.Count -eq $detail.DomainValidationOptions.Count) { break }
  }

  Show-ValidationRecords $detail
  Write-Host ''
  Write-Host 'Ponlos en Squarespace HOY: ACM espera 72 horas y luego el certificado muere.' -ForegroundColor Yellow
  Write-Host 'Para vigilarlo: domain.ps1 status'
}

function Get-DkimTokens {
  # `--output text` sobre una lista plana: una sola linea con tabuladores, que es
  # lo mas dificil de romper.
  $salida = aws sesv2 get-email-identity --region $Region --email-identity $Domain `
    --query 'DkimAttributes.Tokens[]' --output text 2>$null
  if (-not $salida) { return @() }
  return @(($salida -join ' ') -split '\s+' | Where-Object { $_ })
}

function Invoke-Records {
  # TODO lo que hay que crear en Squarespace, de una vez. La queja que lo motivo
  # era legitima: ir soltando los registros de uno en uno obliga a volver al
  # panel cuatro veces.
  $cdn = aws cloudformation describe-stacks --stack-name $AppStack --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text 2>$null
  $eip = aws cloudformation describe-stacks --stack-name $BaseStack --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='ApiElasticIp'].OutputValue" --output text 2>$null

  Write-Host "Todo lo que va en Squarespace para $Domain" -ForegroundColor Cyan
  Write-Host ''
  Write-Host 'DNS Settings -> Custom records. En "Host" va solo la etiqueta, sin el dominio detras.'
  Write-Host ''
  Write-Host '  Host                Tipo   Datos'
  Write-Host '  ------------------  -----  -----------------------------------------'

  foreach ($c in Get-Certificates) {
    $detail = Get-CertificateDetail $c.CertificateArn
    if ($detail.Status -ne 'ISSUED') { continue }
    foreach ($opt in $detail.DomainValidationOptions) {
      if (-not $opt.ResourceRecord) { continue }
      $short = $opt.ResourceRecord.Name.TrimEnd('.') -replace "\.$([regex]::Escape($Domain))$", ''
      Write-Host ("  {0,-18}  CNAME  {1}   (validacion ACM)" -f $short, $opt.ResourceRecord.Value.TrimEnd('.'))
    }
  }

  Write-Host ("  {0,-18}  CNAME  {1}   (el sitio)" -f 'www', $cdn)
  Write-Host ("  {0,-18}  A      {1}   (origen de la API)" -f 'api', $eip)

  foreach ($t in Get-DkimTokens) {
    Write-Host ("  {0,-18}  CNAME  {1}.dkim.amazonses.com   (DKIM de SES)" -f "$t._domainkey", $t)
  }

  Write-Host ''
  Write-Host 'Y aparte de los registros, en los ajustes del dominio:'
  Write-Host "  Reenvio (Forwarding):  $Domain  ->  https://$SiteHost  con HTTPS"
  Write-Host ''
  Write-Host 'NO se tocan los MX ni el TXT del SPF: ahi vive el correo de Google Workspace.' -ForegroundColor Yellow
}

function Invoke-Ses {
  # Las dos barreras que hay entre "esta configurado" y "los correos llegan":
  # el remitente verificado y la cuenta fuera del sandbox. Con cualquiera de las
  # dos sin cumplir, encender MAIL_ENABLED deja de escribir el correo en el log y
  # no lo entrega a nadie: es peor que tenerlo apagado.
  $cuenta = ConvertFrom-AwsJson (aws sesv2 get-account --region $Region --output json)
  $enProduccion = $cuenta.ProductionAccessEnabled
  $revision = 'sin solicitar'
  if ($cuenta.Details.ReviewDetails.Status) { $revision = $cuenta.Details.ReviewDetails.Status }

  Write-Host 'Cuenta de SES' -ForegroundColor Cyan
  if ($enProduccion) {
    Write-Host '  Fuera del sandbox      : si' -ForegroundColor Green
  }
  else {
    Write-Host "  Fuera del sandbox      : NO (solicitud: $revision)" -ForegroundColor Yellow
    Write-Host '    Dentro del sandbox solo llegan correos a direcciones verificadas.'
  }
  Write-Host "  Cuota 24h              : $($cuenta.SendQuota.Max24HourSend)"

  $remitente = ConvertFrom-AwsJson (aws sesv2 get-email-identity --region $Region --email-identity $Sender --output json 2>$null)
  Write-Host ''
  Write-Host "Remitente $Sender" -ForegroundColor Cyan
  if (-not $remitente) {
    Write-Host '  No existe como identidad en SES.' -ForegroundColor Yellow
  }
  elseif ($remitente.VerifiedForSendingStatus) {
    Write-Host '  Verificado             : si' -ForegroundColor Green
  }
  else {
    Write-Host "  Verificado             : NO ($($remitente.VerificationStatus))" -ForegroundColor Yellow
    Write-Host '    Hay que abrir el enlace que AWS mando a ese buzon. Para reenviarlo:'
    Write-Host "      aws ses verify-email-identity --region $Region --email-address $Sender"
  }

  Write-Host ''
  if ($enProduccion -and $remitente -and $remitente.VerifiedForSendingStatus) {
    Write-Host 'LISTO para encender el correo:' -ForegroundColor Green
    Write-Host "  MAIL_ENABLED: 'true' en infra/lib/app-stack.ts, desplegar y reload-api-env.ps1"
  }
  else {
    Write-Host 'TODAVIA NO se puede encender MAIL_ENABLED: faltan las barreras de arriba.' -ForegroundColor Yellow
  }

  Write-Host ''
  Write-Host "Identidad de dominio $Domain (DKIM)" -ForegroundColor Cyan
  $json = aws sesv2 get-email-identity --region $Region --email-identity $Domain --output json 2>$null
  $identity = ConvertFrom-AwsJson $json
  if (-not $identity) {
    Write-Host '  No existe. Se crea con:'
    Write-Host "    aws sesv2 create-email-identity --region $Region --email-identity $Domain"
    return
  }

  $verificado = $identity.VerifiedForSendingStatus
  $color = 'Yellow'
  if ($verificado) { $color = 'Green' }
  Write-Host "  Verificada para enviar : $verificado" -ForegroundColor $color
  Write-Host "  DKIM                   : $($identity.DkimAttributes.Status)"

  Write-Host ''
  Write-Host '  Registros DKIM (CNAME, en Squarespace):'
  foreach ($t in $identity.DkimAttributes.Tokens) {
    $name = "$t._domainkey.$Domain"
    $enDns = @(
      Resolve-DnsName -Name $name -Type CNAME -Server $Resolver -ErrorAction SilentlyContinue |
      Where-Object { $_.Type -eq 'CNAME' }
    )
    $marca = '[ ]'
    if ($enDns.Count -gt 0) { $marca = '[x]' }
    Write-Host "    $marca $t._domainkey  ->  $t.dkim.amazonses.com"
  }

  Write-Host ''
  Write-Host '  Recordatorio: la verificacion NO saca la cuenta del sandbox. Eso es una'
  Write-Host '  solicitud aparte en la consola de SES y AWS tarda dias.'
}

function Test-Record($label, $name, $type, $expected) {
  # Solo las respuestas del tipo que se pidio: cuando el registro no existe, el
  # resolutor contesta con el SOA de la zona, y eso no es una respuesta.
  $answer = @(
    Resolve-DnsName -Name $name -Type $type -Server $Resolver -ErrorAction SilentlyContinue |
    Where-Object { $_.Type -eq $type }
  )

  $values = @()
  foreach ($r in $answer) {
    if ($r.NameExchange) { $values += $r.NameExchange }
    elseif ($r.NameHost) { $values += $r.NameHost }
    elseif ($r.IPAddress) { $values += $r.IPAddress }
    elseif ($r.Strings) { $values += ($r.Strings -join '') }
  }
  $texto = ($values | Select-Object -Unique | Sort-Object) -join ', '

  if (-not $texto) {
    # Distinguir las dos causas, que se arreglan de forma distinta: si el
    # servidor autoritativo tampoco lo tiene, el registro no esta creado y
    # esperar no sirve de nada; si lo tiene, es cache y solo falta esperar.
    $enZona = @(
      Resolve-DnsName -Name $name -Type $type -Server $Authoritative -ErrorAction SilentlyContinue |
      Where-Object { $_.Type -eq $type }
    )
    if ($enZona.Count -gt 0) {
      Write-Host "  [~] $label : ya esta en la zona, falta propagar" -ForegroundColor Yellow
    }
    else {
      Write-Host "  [ ] $label : NO existe en la zona, hay que crearlo" -ForegroundColor Yellow
    }
    return
  }

  if ($expected -and ($texto -notlike "*$expected*")) {
    Write-Host "  [!] $label : $texto  (se esperaba $expected)" -ForegroundColor Yellow
  }
  else {
    Write-Host "  [x] $label : $texto" -ForegroundColor Green
  }
}

function Invoke-Dns {
  Write-Host "Zona de $Domain, segun $Resolver" -ForegroundColor Cyan
  Write-Host ''

  Write-Host 'Correo (esto NO se toca nunca):'
  Test-Record 'MX ' $Domain 'MX' 'aspmx.l.google.com'
  Test-Record 'SPF' $Domain 'TXT' 'include:_spf.google.com'

  Write-Host ''
  Write-Host 'Validacion del certificado:'
  $certs = Get-Certificates
  if ($certs.Count -eq 0) {
    Write-Host '  (no hay certificado pedido)'
  }
  else {
    # Sin repetir: varios certificados del mismo dominio comparten el mismo
    # registro de validacion, y comprobarlo dos veces solo hace ruido.
    $vistos = @{}
    foreach ($c in $certs) {
      $detail = Get-CertificateDetail $c.CertificateArn
      foreach ($opt in $detail.DomainValidationOptions) {
        if (-not $opt.ResourceRecord) { continue }
        $nombre = $opt.ResourceRecord.Name.TrimEnd('.')
        if ($vistos.ContainsKey($nombre)) { continue }
        $vistos[$nombre] = $true
        Test-Record $opt.DomainName $nombre 'CNAME' ''
      }
    }
  }

  Write-Host ''
  Write-Host 'DKIM de SES:'
  $tokens = Get-DkimTokens
  if ($tokens.Count -eq 0) {
    Write-Host '  (la identidad de SES todavia no existe)'
  }
  else {
    foreach ($t in $tokens) {
      Test-Record "$t._domainkey" "$t._domainkey.$Domain" 'CNAME' 'dkim.amazonses.com'
    }
  }

  Write-Host ''
  Write-Host 'Sitio y API:'
  $cdn = aws cloudformation describe-stacks --stack-name $AppStack --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text 2>$null
  if (-not $cdn -or $cdn -eq 'None') { $cdn = '' }
  Test-Record "$SiteHost" $SiteHost 'CNAME' $cdn

  $eip = aws cloudformation describe-stacks --stack-name $BaseStack --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='ApiElasticIp'].OutputValue" --output text 2>$null
  if (-not $eip -or $eip -eq 'None') { $eip = '' }
  Test-Record "$ApiHost" $ApiHost 'A' $eip

  Write-Host ''
  Write-Host "El apex ($Domain) va por REENVIO en el panel de Squarespace, no por DNS."
  Write-Host '  Se comprueba con:  curl -sI https://' -NoNewline
  Write-Host "$Domain   (tiene que dar 301 hacia www)"
}

function Invoke-Deploy {
  $arn = Get-ConfiguredArn

  if (-not $arn) {
    Write-Host 'CERTIFICATE_ARN esta vacio en infra/lib/config.ts.' -ForegroundColor Yellow
    Write-Host 'Sin el, el despliegue deja la distribucion en su dominio de CloudFront.'
    Write-Host 'Pega ahi el ARN del certificado ya emitido (domain.ps1 status) y vuelve.'
    return
  }

  Write-Host "Desplegando $AppStack con el certificado:" -ForegroundColor Cyan
  Write-Host "  $arn"
  Push-Location (Join-Path $PSScriptRoot '..')
  try {
    pnpm exec cdk deploy $AppStack
  }
  finally {
    Pop-Location
  }

  Write-Host ''
  Write-Host 'Siguiente: el CNAME de www al DistributionDomainName que acaba de imprimir,'
  Write-Host 'el reenvio del apex, y reload-api-env.ps1 para que la API lea el WEB_ORIGIN nuevo.'
}

switch ($Action) {
  'status' { Invoke-Status }
  'request' { Invoke-Request }
  'records' { Invoke-Records }
  'dns' { Invoke-Dns }
  'ses' { Invoke-Ses }
  'deploy' { Invoke-Deploy }
}
