# Cambia el correo de login (username) de la cuenta PRINCIPAL de Helga en AWS.
#
# La principal es la primera de `HELGA_ACCOUNTS` (/courier/prod/HELGA_ACCOUNTS en
# Parameter Store, SecureString). Este script toca SOLO su `username`: la
# contrasena, el cliente_id y el resto de cuentas se conservan tal cual, porque se
# parte del valor que ya esta en SSM y no de la tabla de helga-enable.ps1. Asi no
# hace falta volver a teclear ninguna contrasena.
#
# ANTES DE LANZARLO: el correo nuevo tiene que ser YA el login de esa cuenta en
# Helga. Si no lo es, el /oauth/token de la principal responde 401, los
# casilleros nuevos caen en `failed` y la importacion de la principal se detiene.
# No se puede comprobar desde aqui: Helga solo acepta la IP de la instancia.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-principal-usuario.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-principal-usuario.ps1
#
# Para volver atras, se lanza otra vez con el correo anterior:
#   ... helga-principal-usuario.ps1 -Username servicioalcliente1@hsglobal-services.com

param(
  [string]$Username = 'casillero-hs@hsglobal-services.com',
  # Ensena el cambio y se va, sin escribir en Parameter Store.
  [switch]$DryRun,
  # Escribe en SSM pero no reinicia la API (el cambio no aplica hasta reiniciar).
  [switch]$SinReiniciar
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Name = '/courier/prod/HELGA_ACCOUNTS'

$Username = $Username.Trim()
if ($Username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
  Write-Error "'$Username' no parece un correo valido."
  exit 1
}

Write-Host "Leyendo $Name ($Region)..." -ForegroundColor Cyan
$raw = aws ssm get-parameter --region $Region --name $Name --with-decryption `
  --query 'Parameter.Value' --output text
if ($LASTEXITCODE -ne 0 -or -not $raw) {
  Write-Error "No se pudo leer $Name. Revisa el perfil de AWS."
  exit 1
}
$raw = ($raw | Out-String).Trim()

try {
  $parsed = ConvertFrom-Json -InputObject $raw
}
catch {
  Write-Error "$Name no es JSON valido; no se toca nada."
  exit 1
}
# Lista nueva y no `@($parsed)`: en PowerShell 5.1 ese array envuelto se
# serializa luego como {"value":[...],"Count":n} si hay una sola cuenta.
$lista = New-Object System.Collections.Generic.List[object]
foreach ($c in $parsed) { $lista.Add($c) }
if ($lista.Count -lt 1) {
  Write-Error "$Name no tiene cuentas; no se toca nada."
  exit 1
}

$principal = $lista[0]
$anterior = $principal.username

Write-Host ''
Write-Host "Cuenta principal: $($principal.code) ($($principal.name))"
Write-Host "  username actual: $anterior"
Write-Host "  username nuevo:  $Username" -ForegroundColor Green
Write-Host "  (las otras $($lista.Count - 1) cuentas y todas las contrasenas no cambian)"
Write-Host ''

if ($anterior -eq $Username) {
  Write-Host 'Ya tiene ese correo. No hay nada que hacer.' -ForegroundColor Yellow
  exit 0
}

if ($DryRun) {
  Write-Host 'DryRun: no se escribe nada.' -ForegroundColor Yellow
  exit 0
}

$principal.username = $Username

# -InputObject (y no el pipeline) para que el resultado siga siendo un array
# aunque solo haya una cuenta. -Compress porque el arranque de la instancia
# vuelca cada parametro en UNA linea de /opt/courier/api.env (ver helga-enable.ps1).
$json = ConvertTo-Json -InputObject $lista.ToArray() -Compress -Depth 4

# El valor viaja en un archivo temporal (file://) y no en la linea de comandos:
# PowerShell le quita las comillas dobles al JSON al pasarlo a un ejecutable
# nativo y la API no arrancaria (paso el 2026-09-06).
$tmp = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  $uri = 'file://' + $tmp.Replace([char]92, '/')
  $version = aws ssm put-parameter --region $Region --name $Name `
    --value $uri --type SecureString --overwrite --query 'Version' --output text
  if ($LASTEXITCODE -ne 0) { throw "No se pudo escribir $Name" }
}
finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
Write-Host "  $Name actualizado (version $version)." -ForegroundColor Green

if ($SinReiniciar) {
  Write-Host ''
  Write-Host 'No se reinicio la API: el cambio aplica cuando corra reload-api-env.ps1.' -ForegroundColor Yellow
  exit 0
}

# Reiniciar tambien vacia la cache de tokens en memoria, asi que el siguiente
# /oauth/token de la principal ya sale con el usuario nuevo.
Write-Host ''
Write-Host 'Reiniciando la API para que lea la configuracion nueva...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'reload-api-env.ps1')

Write-Host ''
Write-Host "Comprobacion: en el log no tiene que aparecer '/oauth/token de $($principal.code) ... 401'."
Write-Host "  aws logs tail /courier/prod/api --region $Region --since 10m --filter-pattern oauth"
Write-Host 'Si aparece, el correo nuevo todavia no es el login en Helga. Para volver atras:'
Write-Host "  powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-principal-usuario.ps1 -Username $anterior"
