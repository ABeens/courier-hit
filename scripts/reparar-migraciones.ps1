# Repara el control de migraciones cuando `db:migrate` falla con un
# "already exists" (la base tiene los objetos, pero la tabla de control de
# drizzle no tiene su fila). Ver apps/api/src/repair-migrations.ts.
#
# Corre primero en modo informativo: prueba todo y lo deshace, para que se vea
# que se saltaria antes de tocar nada. Luego pregunta si se aplica.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\scripts\reparar-migraciones.ps1

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

if (-not (Test-Path (Join-Path $raiz 'apps\api\.env'))) {
  Write-Host 'No encuentro apps\api\.env, que es de donde sale DATABASE_URL.' -ForegroundColor Red
  exit 1
}

Write-Host 'Revisando el desajuste (sin guardar nada)...' -ForegroundColor Cyan
pnpm --filter @courier/api db:repair
if ($LASTEXITCODE -ne 0) {
  Write-Host 'La revision fallo. Revisa el error de arriba.' -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ''
$respuesta = Read-Host 'Aplicar la reparacion? (s/N)'
if ($respuesta -notmatch '^[sSyY]') {
  Write-Host 'Cancelado. La base quedo igual.' -ForegroundColor Yellow
  exit 0
}

pnpm --filter @courier/api db:repair -- --apply
if ($LASTEXITCODE -ne 0) {
  Write-Host 'La reparacion fallo. No se anoto nada.' -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Confirmando con db:migrate...' -ForegroundColor Cyan
pnpm --filter @courier/api db:migrate
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Siguen quedando migraciones que no pasan. Revisa el error.' -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Listo. La base y el journal estan al dia.' -ForegroundColor Green
