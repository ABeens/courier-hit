# Prueba UNA llave de API contra la API publica, sin Postman de por medio.
#
# Existe por como se depura de verdad un "no me funciona la llave": lo primero es
# saber si el problema es la llave o la peticion. Un cliente de escritorio manda
# cabeceras que no se ven (Postman anade su propio `Authorization` en cuanto hay
# algo en su pestana de autenticacion) y guarda espacios invisibles al final de
# la URL, asi que una prueba que no pase por el sale de dudas en una linea.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\apps\api\scripts\probar-mi-llave.ps1 -Llave hsk_test_...
#   ... -BaseUrl https://mi-dominio.com   para probar contra produccion
#
# No escribe nada: solo consulta (no prealerta).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Llave,
  [string]$BaseUrl = 'http://localhost:3001'
)

$ErrorActionPreference = 'Stop'
$raiz = "$BaseUrl/api/v1"
$llaveLimpia = $Llave.Trim().Trim('"').Trim("'")

if ($llaveLimpia -ne $Llave.Trim()) {
  Write-Host 'Aviso: la llave venia entre comillas. Se prueba sin ellas.' -ForegroundColor Yellow
}
if ($llaveLimpia -notmatch '^hsk_(live|test)_[a-z2-9]{16}_[a-z2-9]{32}$') {
  Write-Host 'Aviso: esta llave no tiene la forma hsk_<entorno>_<16>_<32>.' -ForegroundColor Yellow
  Write-Host 'Puede que se haya copiado a medias. Copiala entera desde el portal.' -ForegroundColor Yellow
}

function Pedir([string]$Ruta) {
  $url = "$raiz$Ruta"
  try {
    $r = Invoke-WebRequest -Uri $url -Headers @{ 'x-api-key' = $llaveLimpia } -UseBasicParsing -ErrorAction Stop
    return [pscustomobject]@{ Status = [int]$r.StatusCode; Cuerpo = $r.Content }
  }
  catch {
    $resp = $_.Exception.Response
    if (-not $resp) { throw }
    $texto = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $texto = $_.ErrorDetails.Message }
    return [pscustomobject]@{ Status = [int]$resp.StatusCode; Cuerpo = $texto }
  }
}

Write-Host ''
Write-Host "Probando la llave contra $raiz" -ForegroundColor White
Write-Host ''

$cliente = Pedir '/client'
if ($cliente.Status -eq 200) {
  $datos = $cliente.Cuerpo | ConvertFrom-Json
  Write-Host ("  OK    La llave sirve. Casillero {0} ({1})." -f $datos.clientCode, $datos.name) -ForegroundColor Green
}
else {
  Write-Host ("  FALLO GET /client respondio {0}" -f $cliente.Status) -ForegroundColor Red
  Write-Host ("        {0}" -f $cliente.Cuerpo) -ForegroundColor DarkGray
  Write-Host ''
  Write-Host 'Que mirar, segun el codigo:' -ForegroundColor White
  Write-Host '  API_KEY_MISSING  la cabecera no llego. Si usas Postman, deja la pestana'
  Write-Host '                   Authorization en "No Auth" y manda x-api-key a mano.'
  Write-Host '  API_KEY_INVALID  la llave llego cortada, con comillas, o es de otro entorno'
  Write-Host '                   (una hsk_test_ contra produccion).'
  Write-Host '  API_KEY_REVOKED  esa llave se roto o se revoco: usa la vigente.'
  Write-Host '  ROUTE_NOT_FOUND  la ruta no es esa. El mensaje dice cual llego al servidor;'
  Write-Host '                   ojo con la barra final y con los espacios al pegar la URL.'
  exit 1
}

foreach ($ruta in @('/locker', '/packages?pageSize=3')) {
  $r = Pedir $ruta
  $color = 'Green'; $etiqueta = 'OK   '
  if ($r.Status -ne 200) { $color = 'Red'; $etiqueta = 'FALLO' }
  Write-Host ("  {0} GET {1} -> {2}" -f $etiqueta, $ruta, $r.Status) -ForegroundColor $color
  if ($r.Status -ne 200) { Write-Host ("        {0}" -f $r.Cuerpo) -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host 'La llave y la ruta estan bien. Si tu herramienta sigue fallando, es ella:' -ForegroundColor White
Write-Host '  - manda una sola credencial (x-api-key, y la pestana de auth en "No Auth");'
Write-Host '  - comprueba que la URL no lleve espacios ni barra final;'
Write-Host '  - la operacion y el metodo, en la documentacion del portal (menu API).'
