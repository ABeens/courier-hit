# Comprueba si la consulta de estado de Helga (op. B) devuelve fotos del paquete.
#
# Por que existe: el manual del proveedor documenta los campos `fotos`,
# `imagenes` y `fotos_externo` en la respuesta de
# POST /api/casillero/consulta-estado/{busqueda}, pero el ejemplo del PDF los
# trae VACIOS y no documenta la forma de cada elemento (URL? base64? objeto?).
# Sin una respuesta real no se puede estimar la pantalla del portal, asi que
# este script consulta paquetes reales de la cuenta para ver que llega.
#
# Sin -Search el script NO necesita que le den un HAWB: pide a la op. E
# (paquetes disponibles) los paquetes reales de la cuenta y prueba los primeros.
# Es la unica fuente fiable de HAWBs, porque los del entorno local son de semilla
# y no existen del lado de Helga.
#
# Requisitos:
#   - Ejecutarlo desde una IP/Origin en la lista blanca de Helga (tipicamente la
#     instancia de la API). Desde un equipo de oficina lo normal es un 403.
#   - Credenciales validas. Si el token responde 401, las credenciales estan
#     caidas y este script no puede concluir nada (que es el estado reportado).
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-photos-check.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-photos-check.ps1 -Take 10 -SaveRaw
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-photos-check.ps1 -Search HAWB12345
#
# `Search` acepta HAWB, referencia, guia transportadora o tracking de tienda.
# Conviene usar un paquete que YA haya pasado por bodega de Miami (un recibido o
# posterior): un prealertado que aun no llega responde 404 y nunca traeria fotos.

param(
  [string]$Search,
  [int]$Take = 5,
  [string]$EnvFile = "$PSScriptRoot\..\..\apps\api\.env",
  [switch]$SaveRaw
)

$ErrorActionPreference = 'Stop'

# --- Configuracion: se lee del .env de la API para no duplicar secretos ---
if (-not (Test-Path $EnvFile)) {
  Write-Error "No encuentro el fichero de entorno: $EnvFile"
  exit 1
}

$cfg = @{}
foreach ($line in Get-Content $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $i = $trimmed.IndexOf('=')
  if ($i -lt 1) { continue }
  $key = $trimmed.Substring(0, $i).Trim()
  $value = $trimmed.Substring($i + 1).Trim().Trim('"')
  $cfg[$key] = $value
}

$baseUrl = $cfg['HELGA_BASE_URL']
$clientId = $cfg['HELGA_CLIENT_ID']
$clientSecret = $cfg['HELGA_CLIENT_SECRET']
$username = $cfg['HELGA_USERNAME']
$password = $cfg['HELGA_PASSWORD']
$origin = $cfg['HELGA_ORIGIN']
$appId = $cfg['HELGA_APP_ID']

# HELGA_ACCOUNTS (multi cuenta) manda sobre la forma antigua de una sola cuenta.
if ($cfg['HELGA_ACCOUNTS']) {
  try {
    $accounts = $cfg['HELGA_ACCOUNTS'] | ConvertFrom-Json
    $first = @($accounts)[0]
    if ($first.username) { $username = $first.username }
    if ($first.password) { $password = $first.password }
    if ($first.oauthClientId) { $clientId = $first.oauthClientId }
    if ($first.oauthClientSecret) { $clientSecret = $first.oauthClientSecret }
    if ($first.appId) { $appId = $first.appId }
    Write-Host "Usando la cuenta $($first.code) de HELGA_ACCOUNTS."
  } catch {
    Write-Host 'HELGA_ACCOUNTS no es JSON valido; sigo con HELGA_USERNAME/HELGA_PASSWORD.'
  }
}

foreach ($pair in @(@('HELGA_BASE_URL', $baseUrl), @('HELGA_CLIENT_ID', $clientId), @('HELGA_CLIENT_SECRET', $clientSecret), @('usuario', $username), @('password', $password))) {
  if (-not $pair[1]) {
    Write-Error "Falta $($pair[0]) en $EnvFile."
    exit 1
  }
}

# --- Op. A: token ---
Write-Host "Pidiendo token a $baseUrl/oauth/token como $username..."
$tokenBody = @{
  grant_type    = 'password'
  client_id     = $clientId
  client_secret = $clientSecret
  username      = $username
  password      = $password
  scope         = ''
} | ConvertTo-Json

try {
  $token = Invoke-RestMethod -Method Post -Uri "$baseUrl/oauth/token" `
    -ContentType 'application/json' -Headers @{ Accept = 'application/json' } `
    -Body $tokenBody -TimeoutSec 30
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  Write-Host ''
  Write-Host "FALLO EL TOKEN (HTTP $status)." -ForegroundColor Red
  if ($status -eq 401) {
    Write-Host 'Credenciales rechazadas: hay que pedirle a Helga que las reactive o las reemita.'
  } elseif ($status -eq 403) {
    Write-Host 'Acceso denegado: esta IP no esta en la lista blanca. Ejecutalo desde la instancia de la API.'
  }
  Write-Host 'Sin token no se puede comprobar si las fotos vienen en la respuesta.'
  exit 1
}

if (-not $token.access_token) {
  Write-Error 'La respuesta del token no trae access_token.'
  exit 1
}
Write-Host "Token OK (expira en $($token.expires_in)s)."

$headers = @{
  Accept        = 'application/json'
  Authorization = "Bearer $($token.access_token)"
}
if ($origin) { $headers['Origin'] = $origin }
if ($appId) { $headers['X-App-Id'] = $appId }

# --- Op. B sobre un criterio: devuelve $true si el paquete trae algun adjunto ---
function Test-PackagePhotos {
  param([string]$Criterion)

  $encoded = [System.Uri]::EscapeDataString($Criterion)
  $url = "$baseUrl/api/casillero/consulta-estado/$encoded"
  Write-Host ''
  Write-Host "--- consulta-estado/$Criterion ---"

  try {
    $raw = Invoke-WebRequest -Method Post -Uri $url -Headers $headers -TimeoutSec 30 -UseBasicParsing
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 404) {
      Write-Host "Helga no conoce '$Criterion' (404). Prueba con un paquete que ya haya entrado a bodega."
    } elseif ($status -eq 403) {
      Write-Host 'Acceso denegado por lista blanca: ejecutalo desde la instancia de la API.'
    } else {
      Write-Host "Fallo la consulta (HTTP $status)."
    }
    return $false
  }

  $body = $raw.Content | ConvertFrom-Json
  $datos = $body.datos
  if (-not $datos) { $datos = $body.data }
  if (-not $datos) {
    Write-Host "Respuesta vacia. msg: $($body.msg)$($body.message)"
    return $false
  }

  if ($SaveRaw) {
    $out = Join-Path (Get-Location) "helga-consulta-estado-$($Criterion -replace '[^A-Za-z0-9]','_').json"
    $raw.Content | Out-File -FilePath $out -Encoding utf8
    Write-Host "Respuesta cruda guardada en $out"
  }

  Write-Host "Paquete: $($datos.Sello) / tracking $($datos.tracking) / estado '$($datos.Estado_Envio)'"

  $found = $false
  foreach ($field in @('fotos', 'imagenes', 'fotos_externo')) {
    $value = $datos.$field
    if ($null -eq $value) {
      Write-Host "  $field : AUSENTE (el campo ni siquiera viene en la respuesta)"
      continue
    }
    if ($value -is [string]) {
      if ($value -eq '') {
        Write-Host "  $field : cadena vacia (sin contenido)"
      } else {
        $found = $true
        Write-Host "  $field : cadena con contenido -> $value"
      }
      continue
    }
    $items = @($value)
    if ($items.Count -eq 0) {
      Write-Host "  $field : array vacio (el paquete no tiene nada adjunto)"
    } else {
      $found = $true
      Write-Host "  $field : $($items.Count) elemento(s). Forma del primero:"
      $items[0] | ConvertTo-Json -Depth 5 | Write-Host
    }
  }
  return $found
}

# --- Criterios a probar: los que den, o los reales de la cuenta (op. E) ---
$criteria = @()
if ($Search) {
  $criteria = @($Search)
} else {
  Write-Host ''
  Write-Host 'Sin -Search: pidiendo paquetes reales de la cuenta (op. E, paqsdisponibles)...'
  $listUrl = "$baseUrl/api/casillero/despachos/preliquidaciones/paqsdisponibles?page=1"
  try {
    $list = Invoke-RestMethod -Method Post -Uri $listUrl -Headers $headers `
      -ContentType 'application/json' -Body (@{ pageSize = 50 } | ConvertTo-Json) -TimeoutSec 30
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    Write-Host "No pude listar los paquetes disponibles (HTTP $status)." -ForegroundColor Red
    Write-Host 'Vuelve a lanzarlo con -Search <HAWB> si ya tienes uno a mano.'
    exit 1
  }

  $rows = $list.datos.data
  if (-not $rows) { $rows = $list.data.data }
  $rows = @($rows)
  if ($rows.Count -eq 0) {
    Write-Host 'La cuenta no tiene paquetes disponibles ahora mismo; no hay de donde sacar un HAWB.' -ForegroundColor Yellow
    exit 1
  }

  Write-Host "La cuenta tiene $($rows.Count) paquete(s) en la primera pagina. Probando los primeros $($Take):"
  $rows | Select-Object -First $Take | ForEach-Object {
    Write-Host ("  hawb={0}  tracking={1}  estado={2}  recibido={3}" -f $_.hawb, $_.tracking, $_.estado, $_.fecha_recibido)
  }
  $criteria = $rows | Select-Object -First $Take | ForEach-Object {
    if ($_.hawb) { $_.hawb } elseif ($_.tracking) { $_.tracking }
  } | Where-Object { $_ }
}

$withPhotos = @()
foreach ($criterion in $criteria) {
  if (Test-PackagePhotos -Criterion $criterion) { $withPhotos += $criterion }
}

# --- Veredicto ---
Write-Host ''
if ($withPhotos.Count -gt 0) {
  Write-Host "CONCLUSION: $($withPhotos.Count) de $($criteria.Count) paquete(s) SI traen adjuntos ($($withPhotos -join ', '))." -ForegroundColor Green
  Write-Host 'Revisa arriba la forma del elemento (URL absoluta, ruta relativa o base64) para decidir'
  Write-Host 'como servirlas al portal.'
} else {
  Write-Host "CONCLUSION: ninguno de los $($criteria.Count) paquete(s) probados trae adjuntos." -ForegroundColor Yellow
  Write-Host 'Ojo, no prueba que Helga nunca envie fotos: puede que la bodega no le tomara fotos a ESTOS'
  Write-Host 'paquetes. Sube -Take y repite antes de dar el requerimiento por inviable.'
}
