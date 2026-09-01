# Prepara el entorno para las CUENTAS EXCLUSIVAS del operador de Miami
# (clientes consolidados, docs/13 §6).
#
# Son tres cosas, y en este orden:
#
#   1. generar PROVIDER_SECRETS_KEY, la clave con la que se cifran las
#      credenciales de esas cuentas antes de guardarlas en la base;
#   2. aplicar la migracion 0032, que crea la tabla `provider_accounts` y agrega
#      `shipments.provider_account_code`;
#   3. dejar MIAMI_LINK_ENABLED=true, que es la bandera de la que cuelga la
#      pantalla "Cuentas de Miami" (la misma que "Enlace con Miami").
#
# NO TOCA PRODUCCION. Escribe sobre el `.env` local de la API. En AWS la variable
# se carga cifrada igual que las de Helga: ver `helga-enable.ps1` y
# `reload-api-env.ps1`.
#
# OJO CON LA CLAVE: cambiarla deja ILEGIBLES las credenciales ya guardadas. Si
# alguna vez hay que rotarla, hay que volver a capturar la contrasena de cada
# cuenta desde la pantalla.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\provider-accounts-setup.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\provider-accounts-setup.ps1

param(
  # Muestra lo que haria sin escribir nada ni tocar la base.
  [switch]$DryRun,
  # Ruta del .env de la API.
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\..\apps\api\.env'),
  # Salta la migracion (util si la base ya esta al dia).
  [switch]$SkipMigration
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# --- 1. La clave de cifrado --------------------------------------------------

Write-Step '1/3 · PROVIDER_SECRETS_KEY'

if (-not (Test-Path $EnvFile)) {
  throw "No encuentro el archivo de entorno: $EnvFile. Copia apps/api/.env.example a apps/api/.env y vuelve a lanzar."
}

$envLines = Get-Content $EnvFile
$yaTiene = $envLines | Where-Object { $_ -match '^\s*PROVIDER_SECRETS_KEY\s*=\s*\S' }

if ($yaTiene) {
  Write-Host '   Ya hay una clave configurada. No se toca: cambiarla dejaria ilegibles las credenciales guardadas.' -ForegroundColor Yellow
}
else {
  # 32 bytes aleatorios en base64: es lo que espera core/secrets.ts (AES-256-GCM).
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $clave = [Convert]::ToBase64String($bytes)

  if ($DryRun) {
    Write-Host '   [DryRun] Se generaria una clave nueva de 32 bytes y se escribiria en el .env.'
  }
  else {
    if ($envLines | Where-Object { $_ -match '^\s*PROVIDER_SECRETS_KEY\s*=' }) {
      $envLines = $envLines | ForEach-Object {
        if ($_ -match '^\s*PROVIDER_SECRETS_KEY\s*=') { "PROVIDER_SECRETS_KEY=$clave" } else { $_ }
      }
    }
    else {
      $envLines += "PROVIDER_SECRETS_KEY=$clave"
    }
    Set-Content -Path $EnvFile -Value $envLines -Encoding utf8
    Write-Host '   Clave generada y escrita en el .env.' -ForegroundColor Green
  }
}

# --- 2. La migracion ---------------------------------------------------------

Write-Step '2/3 · Migración 0032 (provider_accounts + shipments.provider_account_code)'

if ($SkipMigration) {
  Write-Host '   Omitida por -SkipMigration.' -ForegroundColor Yellow
}
elseif ($DryRun) {
  Write-Host '   [DryRun] Se ejecutaria: pnpm --filter @courier/api db:migrate'
}
else {
  Push-Location $repoRoot
  try {
    pnpm --filter @courier/api db:migrate
    if ($LASTEXITCODE -ne 0) { throw "La migracion fallo con codigo $LASTEXITCODE." }
    Write-Host '   Migración aplicada.' -ForegroundColor Green
  }
  finally { Pop-Location }
}

# --- 3. La bandera de la pantalla -------------------------------------------

Write-Step '3/3 · MIAMI_LINK_ENABLED'

$envLines = Get-Content $EnvFile
$apagada = $envLines | Where-Object { $_ -match '^\s*MIAMI_LINK_ENABLED\s*=\s*false' }

if (-not $apagada) {
  Write-Host '   Ya esta en true (o no aparece apagada). Nada que hacer.' -ForegroundColor Green
}
elseif ($DryRun) {
  Write-Host '   [DryRun] Se pondria MIAMI_LINK_ENABLED=true.'
}
else {
  # Solo la ULTIMA definicion manda en el .env, asi que se reescriben todas.
  $envLines = $envLines | ForEach-Object {
    if ($_ -match '^\s*MIAMI_LINK_ENABLED\s*=') { 'MIAMI_LINK_ENABLED=true' } else { $_ }
  }
  Set-Content -Path $EnvFile -Value $envLines -Encoding utf8
  Write-Host '   MIAMI_LINK_ENABLED=true.' -ForegroundColor Green
}

Write-Host "`nListo. Reinicia la API y entra como Admin a /app/cuentas-miami." -ForegroundColor Cyan
Write-Host 'El orden de trabajo alli es: registrar la cuenta con sus credenciales y despues crear su cliente consolidado.'
