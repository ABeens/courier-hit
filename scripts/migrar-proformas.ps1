# Aplica a la base local la migracion que crea la SERIE DE PROFORMAS
# (`proforma_numbers` + la secuencia `hs_proforma_number_seq`, docs/10 §4.1).
#
# A partir de aqui cada proforma que se emita recibe su propio consecutivo
# (1000, 1001, 1002, ...) en vez de imprimir el del tramite. Las
# proformas ya entregadas antes de esto no se renumeran hacia atras: no hay nada
# guardado de ellas, asi que la primera vez que se vuelvan a abrir tomaran el
# siguiente numero de la serie y ese sera el suyo desde entonces.
#
# En el servidor no hace falta: el despliegue corre las migraciones solo, en su
# contenedor de un uso (docs/12 §6.3). Esto es para la base de desarrollo.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\scripts\migrar-proformas.ps1

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
Write-Host 'Listo. La serie de proformas existe y arranca en la 1000.' -ForegroundColor Green
Write-Host 'Para verlo: Costos -> facturados -> descargar proforma. El numero sale rotulado en la esquina.' -ForegroundColor Green
