<#
.SYNOPSIS
  Muestra cada cuanto corren las tareas del robot en produccion.

.DESCRIPTION
  Lee de SSM (/courier/prod) SOLO los parametros del robot y de Helga que
  deciden si las tareas se agendan y con que intervalo. Si un intervalo no
  existe en SSM, la API usa el valor por defecto de apps/api/src/core/config.ts,
  y asi se indica en la tabla.

  No pide descifrado: un parametro SecureString saldria cifrado, pero ninguno de
  estos lo es.
#>
param(
  [string]$Region = 'us-east-1',
  [string]$Path = '/courier/prod'
)

$ErrorActionPreference = 'Stop'

# Nombre -> valor por defecto en apps/api/src/core/config.ts
$defaults = [ordered]@{
  'ROBOT_ENABLED'                  = 'false'
  'HELGA_MODE'                     = '(sin default)'
  'ROBOT_PROVIDER_SYNC_EVERY'      = '15m'
  'ROBOT_PACKAGE_DISCOVERY_EVERY'  = '15m'
  'ROBOT_PREALERT_RETRY_EVERY'     = '30m'
  'ROBOT_LOCKER_LINK_RETRY_EVERY'  = '1h'
  'ROBOT_DAILY_DIGEST_CHECK_EVERY' = '5m'
  'HELGA_RATE_LIMIT_PER_MIN'       = '55'
}

$names = $defaults.Keys | ForEach-Object { "$Path/$_" }
$result = aws ssm get-parameters --region $Region --names $names --output json | ConvertFrom-Json

$found = @{}
foreach ($p in $result.Parameters) {
  $found[($p.Name -split '/')[-1]] = $p
}

$rows = foreach ($name in $defaults.Keys) {
  $p = $found[$name]
  [pscustomobject]@{
    Parametro  = $name
    Valor      = if ($p) { $p.Value } else { $defaults[$name] }
    Origen     = if ($p) { 'SSM' } else { 'default' }
    Modificado = if ($p) { ([datetime]$p.LastModifiedDate).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '' }
  }
}

$rows | Format-Table -AutoSize

Write-Host 'Nota: SSM se vuelca a /opt/courier/api.env en cada despliegue (deploy.sh). Un cambio en SSM no aplica hasta el proximo despliegue.'
