# Publica en produccion el trabajo de CUENTAS EXCLUSIVAS / clientes consolidados
# (docs/13 §6, docs/cuentas-exclusivas.html).
#
# Es el orquestador de la puesta en produccion: encadena las tres cosas que hay
# que hacer y en el orden correcto, que es lo unico que tiene truco aqui.
#
#   1. comprobaciones previas (sesion de AWS, arbol de git limpio);
#   2. PROVIDER_SECRETS_KEY y MIAMI_LINK_ENABLED en Parameter Store;
#   3. despliegue de API y sitio.
#
# LAS MIGRACIONES NO SE LANZAN AQUI, y no es un olvido: las aplica el propio
# despliegue dentro de la instancia (`/opt/courier/deploy.sh`), con la imagen
# nueva y antes de reiniciar el servicio. Asi el esquema y el codigo que lo usa
# entran juntos, y si la migracion falla el servicio viejo sigue en pie. Correrlas
# desde fuera seria adelantar el esquema al codigo.
#
# EL ARBOL TIENE QUE ESTAR LIMPIO. El despliegue etiqueta la imagen con el SHA de
# HEAD: con cambios sin commitear se publicaria una imagen que dice ser un commit
# que no contiene lo que acabas de escribir.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\release-cuentas-exclusivas.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\release-cuentas-exclusivas.ps1

param(
  # Enseña lo que haria y se va. No escribe en Parameter Store ni despliega.
  [switch]$DryRun,
  # Salta el paso de Parameter Store (la clave ya esta cargada).
  [switch]$SkipSsm,
  # Que desplegar: all (lo normal), api o web.
  [ValidateSet('all', 'api', 'web')]
  [string]$Deploy = 'all'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# --- 1. Comprobaciones previas ----------------------------------------------

Write-Step '1/3 · Comprobaciones previas'

aws sts get-caller-identity --output text | Out-Null
if (-not $?) { throw "Sesion de AWS expirada o sin credenciales. Ejecuta 'aws login' y repite." }
Write-Host '   Sesion de AWS: ok' -ForegroundColor Green

$pendientes = git -C $repoRoot status --porcelain
if ($pendientes) {
  Write-Host '   Hay cambios sin commitear:' -ForegroundColor Yellow
  $pendientes | ForEach-Object { Write-Host "     $_" }
  throw 'Commitea antes de desplegar: la imagen se etiqueta con el SHA de HEAD y si no, la version publicada no corresponde con el codigo.'
}
$sha = (git -C $repoRoot rev-parse HEAD).Trim()
Write-Host "   Arbol limpio. Se desplegara $($sha.Substring(0,7))" -ForegroundColor Green

# `bash` viene con Git para Windows; deploy-local.sh es el mismo camino que usa
# el pipeline, asi que no hay una version PowerShell del despliegue.
Get-Command bash -ErrorAction SilentlyContinue | Out-Null
if (-not $?) { throw 'No encuentro `bash`. Instala Git para Windows o lanza deploy-local.sh desde Git Bash.' }
Write-Host '   bash disponible: ok' -ForegroundColor Green

# --- 2. Parameter Store ------------------------------------------------------

Write-Step '2/3 · PROVIDER_SECRETS_KEY y MIAMI_LINK_ENABLED'

if ($SkipSsm) {
  Write-Host '   Omitido por -SkipSsm.' -ForegroundColor Yellow
}
else {
  $keyScript = Join-Path $PSScriptRoot 'provider-secrets-key.ps1'
  if ($DryRun) {
    & $keyScript -ConPantalla -DryRun
  }
  else {
    & $keyScript -ConPantalla
  }
  if (-not $?) { throw 'Fallo cargando la clave en Parameter Store.' }
}

# --- 3. Despliegue -----------------------------------------------------------

Write-Step "3/3 · Despliegue ($Deploy)"

if ($DryRun) {
  Write-Host "   [DryRun] Se ejecutaria: bash infra/scripts/deploy-local.sh $Deploy"
  Write-Host '   Ese paso construye y publica la imagen, regenera el entorno desde Parameter Store,'
  Write-Host '   aplica la migracion 0032 dentro de la instancia y reinicia el servicio.'
}
else {
  Push-Location $repoRoot
  try {
    bash infra/scripts/deploy-local.sh $Deploy
    if ($LASTEXITCODE -ne 0) { throw "El despliegue termino con codigo $LASTEXITCODE." }
  }
  finally { Pop-Location }
  Write-Host '   Despliegue terminado.' -ForegroundColor Green
}

Write-Host "`nListo. Entra como Admin a /app/cuentas-miami para registrar la primera cuenta." -ForegroundColor Cyan
Write-Host 'El orden alli es: registrar la cuenta con sus credenciales y despues crear su cliente consolidado.'
