# Lista los destinatarios de la cuenta principal de Helga con su id y sub-casillero.
#
# Por que existe: cuando el alta de un casillero se rechaza por duplicado ("ya
# existe un destinatario casillero con el nombre y/o numero de identificacion"),
# la correccion manual del enlace pide el id del destinatario, y la interfaz web
# de Helga no lo muestra. Este listado si lo trae.
#
# Ruta usada (no documentada en el manual, verificada en vivo el 2026-09-28):
#   POST /api/casillero/clientes/destinatarios  { pageSize, str_busqueda?, page? }
# Es de solo lectura. Paginador estilo Laravel (datos.data[] + last_page/total).
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-destinatarios.ps1 -Search 112345678
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-destinatarios.ps1 -Search "PEREZ"
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-destinatarios.ps1          # todos
#
# `Search` filtra del lado de Helga (cedula, nombre, sub-casillero, correo).

param(
  [string]$Search,
  [string]$EnvFile = "$PSScriptRoot\..\..\apps\api\.env"
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
  $cfg[$trimmed.Substring(0, $i).Trim()] = $trimmed.Substring($i + 1).Trim().Trim('"')
}

$baseUrl = $cfg['HELGA_BASE_URL']
$clientId = $cfg['HELGA_CLIENT_ID']
$clientSecret = $cfg['HELGA_CLIENT_SECRET']
$username = $cfg['HELGA_USERNAME']
$password = $cfg['HELGA_PASSWORD']
$origin = $cfg['HELGA_ORIGIN']
$appId = $cfg['HELGA_APP_ID']

# HELGA_ACCOUNTS (multi cuenta) manda: la primera es la principal, que es donde
# cuelgan los destinatarios que da de alta el registro.
if ($cfg['HELGA_ACCOUNTS']) {
  try {
    $first = @($cfg['HELGA_ACCOUNTS'] | ConvertFrom-Json)[0]
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
  Write-Host "FALLO EL TOKEN (HTTP $status)." -ForegroundColor Red
  exit 1
}

$headers = @{
  Accept        = 'application/json'
  Authorization = "Bearer $($token.access_token)"
}
if ($origin) { $headers['Origin'] = $origin }
if ($appId) { $headers['X-App-Id'] = $appId }

# --- Listado paginado ---
$rows = @()
$page = 1
do {
  $body = @{ pageSize = 50 }
  if ($Search) { $body['str_busqueda'] = $Search }
  try {
    $res = Invoke-RestMethod -Method Post -Uri "$baseUrl/api/casillero/clientes/destinatarios?page=$page" `
      -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 30
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    Write-Host "Fallo el listado (HTTP $status)." -ForegroundColor Red
    if ($status -eq 403) { Write-Host 'Acceso denegado: revisa HELGA_ORIGIN o la lista blanca.' }
    exit 1
  }
  $rows += @($res.datos.data)
  $lastPage = [int]$res.datos.last_page
  $page += 1
} while ($page -le $lastPage)

if ($rows.Count -eq 0) {
  Write-Host 'Ningun destinatario coincide.' -ForegroundColor Yellow
  exit 0
}

Write-Host ''
Write-Host "$($rows.Count) destinatario(s):"
$rows | Sort-Object created_at | ForEach-Object {
  [pscustomobject]@{
    Id           = $_.id
    SubCasillero = $_.sub_casillero
    Nombre       = $_.nombre_completo
    Cedula       = $_.numero_de_identificacion
    Correo       = $_.email
    Activo       = $_.activo
    Creado       = $_.created_at
  }
} | Format-Table -AutoSize | Out-String -Width 250 | Write-Host

Write-Host 'Para corregir el enlace: Id -> "Id de destinatario en el operador", SubCasillero -> "Sub-casillero".'
