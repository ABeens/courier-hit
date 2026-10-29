# Aplica las migraciones pendientes a la base de datos LOCAL.
#
# Cuando hace falta: despues de traerse un cambio que agrega ficheros en
# apps/api/drizzle/. Lo que hace cada migracion esta en su propio .sql (y en los
# comentarios que lleve dentro); aqui no se lleva la cuenta para que no se
# desactualice.
#
# Que hace: corre drizzle-kit migrate contra la DATABASE_URL de apps/api/.env.
# Es incremental e idempotente: aplica solo lo que falta (segun la tabla
# drizzle.__drizzle_migrations) y no toca lo ya aplicado. Correrlo con la base
# al dia no hace nada.
#
# Los NOTICE de "el esquema drizzle ya existe" y "la relacion
# __drizzle_migrations ya existe" son normales: no son errores.
#
# En la nube NO se corre esto: /opt/courier/deploy.sh aplica las migraciones al
# desplegar (ver infra/scripts/reload-api-env.ps1).
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\infra\scripts\db-migrate-local.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

if (-not (Test-Path 'apps/api/.env')) {
  throw "No existe apps/api/.env. Copia apps/api/.env.example y pon tu DATABASE_URL."
}

# drizzle-kit lee la conexion de process.env (ver apps/api/drizzle.config.ts),
# y el script db:migrate no carga el .env por su cuenta: se carga aqui.
Get-Content 'apps/api/.env' | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq '' -or $line.StartsWith('#')) { return }
  $pair = $line.Split('=', 2)
  if ($pair.Count -ne 2) { return }
  $value = $pair[1].Trim().Trim('"').Trim("'")
  Set-Item -Path ("env:" + $pair[0].Trim()) -Value $value
}

if (-not $env:DATABASE_URL) { throw 'apps/api/.env no define DATABASE_URL.' }

Write-Host 'Aplicando migraciones pendientes...' -ForegroundColor Cyan
pnpm --filter @courier/api db:migrate
if ($LASTEXITCODE -ne 0) { throw 'La migracion fallo.' }

Write-Host 'Listo: la base local esta al dia.' -ForegroundColor Green
