<#
  Sube la version actual a AWS y enciende las integraciones que faltaban:
  correo saliente (SES), Helga (casillero de Miami) y el robot de tareas.

  Hace, en este orden:
    1. Comprueba la sesion de AWS, que el repo este alineado con origin/master
       y que Docker este en marcha (lo necesita la imagen de la API).
    2. Despliega la API (imagen arm64 a ECR + deploy en la instancia) y el sitio
       (S3 + CloudFront) con infra/scripts/deploy-local.sh. Si la imagen que ya
       esta en ECR como `latest` corresponde al commit actual, se salta la API.
    3. Correo: verifica que el remitente de MAIL_FROM este verificado en SES,
       avisa si la cuenta sigue en el sandbox y pone MAIL_ENABLED=true.
    4. Robot: pone ROBOT_ENABLED=true (solo hace algo con Helga encendida).
    5. Helga: lanza helga-enable.ps1, que pide los secretos por consola, carga
       las cuentas, pone HELGA_MODE=on y REINICIA la API. Ese reinicio es el que
       aplica todos los parametros anteriores de golpe.
    6. Comprueba /api/health y enseña las lineas de arranque del log.

  Uso:
    powershell -ExecutionPolicy Bypass -File .\infra\scripts\go-live.ps1
    powershell -ExecutionPolicy Bypass -File .\infra\scripts\go-live.ps1 -DryRun

  Opciones:
    -DryRun          Enseña el estado y lo que haria, sin tocar nada.
    -SinDespliegue   No construye ni sube nada; solo enciende integraciones.
    -SinHelga        No toca Helga (ni pide secretos). Reinicia la API igual.
    -SinCorreo       No toca MAIL_ENABLED.
    -ForzarApi       Publica la imagen aunque ECR ya tenga este commit.
    -SecretosDesdeEnv  Helga toma sus secretos de apps/api/.env sin preguntar.

  Requisitos: `aws login` hecho, Docker Desktop corriendo, pnpm, Git Bash.
#>
param(
  [switch]$DryRun,
  [switch]$SinDespliegue,
  [switch]$SinHelga,
  [switch]$SinCorreo,
  [switch]$ForzarApi,
  [switch]$SecretosDesdeEnv
)

$ErrorActionPreference = 'Stop'

$Region      = 'us-east-1'
$Path        = '/courier/prod'
$BaseStack   = 'courier-prod-base'
$AppStack    = 'courier-prod-app'
$LogGroup    = '/courier/prod/api'
$GitBash     = 'C:\Program Files\Git\bin\bash.exe'
$RepoRoot    = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DeployLocal = 'infra/scripts/deploy-local.sh'

function Titulo($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  $t" -ForegroundColor Yellow }
function Falla($t)  { Write-Host "  $t" -ForegroundColor Red; exit 1 }

function Salida($stack, $clave) {
  aws cloudformation describe-stacks --stack-name $stack --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='$clave'].OutputValue" --output text
}

function Parametro($nombre) {
  $v = aws ssm get-parameter --region $Region --name "$Path/$nombre" --with-decryption `
    --query Parameter.Value --output text 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return $v
}

function Set-Plain($nombre, $valor) {
  if ($DryRun) { Aviso "(DryRun) $nombre = $valor"; return }
  aws ssm put-parameter --region $Region --name "$Path/$nombre" `
    --value $valor --type String --overwrite --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { Falla "No pude escribir $nombre" }
  Ok "$nombre = $valor"
}

# ---------------------------------------------------------------- 1. Requisitos
Titulo 'Sesion de AWS'
$quien = aws sts get-caller-identity --output json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $quien) {
  Falla "Sesion caducada. Ejecuta 'aws login' y vuelve a lanzar este script."
}
Ok "Cuenta $($quien.Account), $($quien.Arn)"
if ($quien.Account -ne '632914961265') { Falla 'Esa no es la cuenta de produccion (632914961265).' }

Titulo 'Repositorio'
Push-Location $RepoRoot
try {
  git fetch origin master --quiet
  $head   = (git rev-parse HEAD).Trim()
  $remoto = (git rev-parse origin/master).Trim()
  $sucio  = git status --porcelain --untracked-files=no
  Write-Host "  HEAD          : $head"
  Write-Host "  origin/master : $remoto"
  if ($head -ne $remoto) {
    Aviso 'HEAD no coincide con origin/master. Se despliega lo que hay en HEAD.'
    Aviso 'Si quieres que GitHub y AWS cuenten la misma version, haz push antes.'
  }
  if ($sucio) {
    Aviso 'Hay cambios sin commit en archivos versionados. Iran en la imagen'
    Aviso 'pero no en ningun commit; conviene commitear primero.'
  }
}
finally { Pop-Location }

$dockerOk = $true
if (-not $SinDespliegue) {
  Titulo 'Docker'
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    $dockerOk = $false
    Aviso 'Docker no responde. Abre Docker Desktop y espera a que arranque.'
    if (-not $DryRun) { Falla 'Sin Docker no se puede construir la imagen de la API.' }
  } else { Ok 'Docker en marcha' }
  if (-not (Test-Path $GitBash)) { Falla "No encuentro Git Bash en $GitBash" }
}

# ---------------------------------------------------------------- 2. Estado actual
Titulo 'Estado de la infraestructura'
$sitio = Salida $AppStack 'SiteUrl'
$repoUri = Salida $BaseStack 'EcrRepositoryUri'
if (-not $sitio -or $sitio -eq 'None') { Falla "No encuentro el stack $AppStack. Esta desplegado?" }
Write-Host "  Sitio : $sitio"

$repoNombre = $repoUri.Substring($repoUri.IndexOf('/') + 1)
$tagsLatest = aws ecr describe-images --region $Region --repository-name $repoNombre `
  --image-ids imageTag=latest --query 'imageDetails[0].imageTags' --output text 2>$null
$apiAlDia = $false
if ($LASTEXITCODE -eq 0 -and $tagsLatest) {
  $apiAlDia = ($tagsLatest -split '\s+') -contains $head
  if ($apiAlDia) { Ok "ECR latest ya es el commit actual ($($head.Substring(0,7)))" }
  else { Write-Host "  ECR latest: $tagsLatest" }
} else { Aviso 'ECR no tiene imagen latest todavia.' }

$instancia = aws ec2 describe-instances --region $Region `
  --filters 'Name=tag:Name,Values=courier-api' 'Name=instance-state-name,Values=running' `
  --query 'Reservations[].Instances[].InstanceId' --output text
if (-not $instancia -or $instancia -eq 'None') { Falla 'No hay ninguna instancia courier-api en marcha.' }
Write-Host "  Instancia : $instancia"

Write-Host ''
Write-Host '  Interruptores en Parameter Store:'
foreach ($n in 'MAIL_ENABLED','MAIL_FROM','HELGA_MODE','ROBOT_ENABLED','ONVO_MODE','WEB_ORIGIN') {
  $v = Parametro $n
  if ($null -eq $v) { $v = '(no existe)' }
  Write-Host ("    {0,-14} {1}" -f $n, $v)
}
$mailFrom = Parametro 'MAIL_FROM'

# ---------------------------------------------------------------- 3. Correo (SES)
$correoListo = $false
if (-not $SinCorreo) {
  Titulo 'Correo saliente (SES)'
  $cuenta = aws sesv2 get-account --region $Region --output json | ConvertFrom-Json
  if ($cuenta.ProductionAccessEnabled) {
    Ok 'Cuenta fuera del sandbox: se puede escribir a cualquier direccion.'
  } else {
    Aviso 'Cuenta en SANDBOX: SES solo entrega a destinatarios verificados a mano.'
    Aviso "Tope $($cuenta.SendQuota.Max24HourSend) correos/dia. Un cliente que se registre solo NO recibira el codigo."
    Aviso 'Para probar: scripts/ses-destinatarios.ps1 -Agregar correo@...'
    Aviso 'Para salir:  scripts/ses-sandbox-request.ps1 -Enviar'
    if ($cuenta.Details -and $cuenta.Details.ReviewDetails) {
      Aviso "Revision anterior: $($cuenta.Details.ReviewDetails.Status) (caso $($cuenta.Details.ReviewDetails.CaseId))"
    }
  }

  $remitente = $mailFrom
  if ($remitente -match '<([^>]+)>') { $remitente = $Matches[1] }
  $remitente = $remitente.Trim()
  $ident = aws sesv2 get-email-identity --region $Region --email-identity $remitente --output json 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -eq 0 -and $ident.VerifiedForSendingStatus) {
    Ok "Remitente $remitente verificado en SES."
    $correoListo = $true
  } else {
    $dominio = $remitente.Substring($remitente.IndexOf('@') + 1)
    $dom = aws sesv2 get-email-identity --region $Region --email-identity $dominio --output json 2>$null | ConvertFrom-Json
    if ($LASTEXITCODE -eq 0 -and $dom.VerifiedForSendingStatus) {
      Ok "Dominio $dominio verificado en SES; cubre a $remitente."
      $correoListo = $true
    } else {
      Aviso "El remitente $remitente NO esta verificado en SES (ni la direccion ni el dominio)."
      Aviso 'Con MAIL_ENABLED=true cada envio fallaria. No lo enciendo.'
      Aviso 'Verificalo con: scripts/ses-mail-from.ps1 y abre el enlace desde esa casilla.'
    }
  }
}

# ---------------------------------------------------------------- 4. Resumen y confirmacion
Titulo 'Plan'
if ($SinDespliegue)      { Write-Host '  - Despliegue: NO (SinDespliegue)' }
elseif ($apiAlDia -and -not $ForzarApi) { Write-Host '  - Despliegue: solo el sitio (la API ya esta en ECR)' }
else                     { Write-Host '  - Despliegue: API y sitio' }
if ($SinCorreo)          { Write-Host '  - Correo: sin cambios' }
elseif ($correoListo)    { Write-Host '  - Correo: MAIL_ENABLED=true' }
else                     { Write-Host '  - Correo: NO se enciende (remitente sin verificar)' }
Write-Host '  - Robot: ROBOT_ENABLED=true'
if ($SinHelga)           { Write-Host '  - Helga: sin cambios; reinicio de la API para aplicar el resto' }
else                     { Write-Host '  - Helga: helga-enable.ps1 (pide secretos, enciende y reinicia)' }

if ($DryRun) {
  Write-Host ''
  Aviso 'DryRun: nada tocado. Relanza sin -DryRun para ejecutar.'
  exit 0
}

# ---------------------------------------------------------------- 5. Despliegue
if (-not $SinDespliegue) {
  $modo = 'all'
  if ($apiAlDia -and -not $ForzarApi) { $modo = 'web' }
  Titulo "Despliegue ($modo)"
  Push-Location $RepoRoot
  try {
    & $GitBash $DeployLocal $modo
    if ($LASTEXITCODE -ne 0) { Falla "deploy-local.sh $modo termino con error. Nada mas se toca." }
  }
  finally { Pop-Location }
}

# ---------------------------------------------------------------- 6. Interruptores
Titulo 'Parameter Store'
if (-not $SinCorreo -and $correoListo) { Set-Plain 'MAIL_ENABLED' 'true' }
Set-Plain 'ROBOT_ENABLED' 'true'

# ---------------------------------------------------------------- 7. Helga (+ reinicio)
if (-not $SinHelga) {
  Titulo 'Helga'
  if ($SecretosDesdeEnv) {
    & (Join-Path $PSScriptRoot 'helga-enable.ps1') -DesdeEnv
  } else {
    Write-Host '  Ahora se piden los secretos de Helga (no se muestran ni se guardan en el repo).'
    & (Join-Path $PSScriptRoot 'helga-enable.ps1')
  }
  if ($LASTEXITCODE -ne 0) { Falla 'helga-enable.ps1 fallo. Revisa arriba; la API puede estar sin reiniciar.' }
} else {
  Titulo 'Reinicio de la API'
  & (Join-Path $PSScriptRoot 'reload-api-env.ps1')
  if ($LASTEXITCODE -ne 0) { Falla 'El reinicio fallo.' }
}

# ---------------------------------------------------------------- 8. Comprobaciones
Titulo 'Comprobaciones'
$salud = $null
for ($i = 0; $i -lt 12; $i++) {
  try {
    $salud = Invoke-RestMethod -Uri "$sitio/api/health" -TimeoutSec 10
    break
  } catch { Start-Sleep -Seconds 10 }
}
if ($salud -and $salud.ok) { Ok "$sitio/api/health responde ok" }
else {
  Aviso "$sitio/api/health NO responde. Si falta una credencial obligatoria la API no arranca;"
  Aviso 'el motivo esta en el log con el nombre de la variable.'
}

Write-Host ''
Write-Host '  Lineas de arranque del log (ultimos 5 minutos):'
aws logs tail $LogGroup --region $Region --since 5m --format short 2>$null |
  Select-String -Pattern '\[config\]|\[mailer\]|\[helga\]|\[robot\]|\[scheduler\]|Error|error' |
  Select-Object -Last 25 | ForEach-Object { Write-Host "    $_" }

Write-Host ''
Ok 'Listo.'
Write-Host '  Siguiente: registra un cliente de prueba con una direccion verificada en SES y mira'
Write-Host '  que llegue el codigo y que su casillero quede en `synced`. Para seguir el log:'
Write-Host "    aws logs tail $LogGroup --region $Region --follow"
