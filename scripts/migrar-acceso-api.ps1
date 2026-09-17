# Aplica a la base local la migracion que agrega `clients.api_access_enabled`,
# la bandera que decide si un casillero puede usar la API (docs/16 §3.0).
#
# La columna nace en `false` para TODOS los casilleros existentes: despues de
# correr esto nadie tiene API hasta que un administrador se la habilite desde la
# pantalla de Clientes. Eso es lo buscado, no un efecto secundario.
#
# En el servidor no hace falta: el despliegue corre las migraciones solo, en su
# contenedor de un uso (docs/12 §6.3). Esto es para la base de desarrollo.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\scripts\migrar-acceso-api.ps1

$ErrorActionPreference = 'Stop'

# El script se llama desde la raiz o desde cualquier sitio: se ubica solo.
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

if (-not (Test-Path (Join-Path $raiz 'apps\api\.env'))) {
  Write-Host 'No encuentro apps\api\.env, que es de donde sale DATABASE_URL.' -ForegroundColor Red
  exit 1
}

Write-Host 'Aplicando migraciones pendientes a la base local...' -ForegroundColor Cyan
pnpm --filter @courier/api db:migrate
if ($LASTEXITCODE -ne 0) {
  Write-Host 'La migracion fallo. Revisa que Postgres este arriba y que DATABASE_URL apunte a el.' -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Listo. La columna api_access_enabled existe y esta apagada en todos los casilleros.' -ForegroundColor Green
Write-Host 'Para habilitarle la API a un cliente: portal de admin -> Clientes -> boton de la llave.' -ForegroundColor Green
