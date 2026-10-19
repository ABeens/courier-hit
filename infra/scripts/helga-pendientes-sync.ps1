# Lista, en la base de PRODUCCION, los paquetes que el robot va a consultar contra
# Helga (op. B) en sus proximas corridas.
#
# Usa el MISMO criterio que `providerSyncRepo.shipmentsInProviderTramo`
# (apps/api/src/modules/shipments/provider-sync.repo.ts):
#   - tipo `paqueteria` (Transporte y Agenciamiento no se sincronizan);
#   - estado dentro del tramo del proveedor: prealertado, recibido_bodega_miami,
#     preparando_envio, en_transito_costa_rica (en_aduanas ya es manual);
#   - con o sin dueno (los sin dueno solo refrescan datos, no avanzan);
#   - orden: nunca consultados primero, luego el consultado hace mas tiempo.
# Cada corrida toma los primeros 200 (SYNC_BATCH), asi que la columna "#" dice
# en que turno le toca a cada paquete.
#
# Tambien muestra HELGA_MODE y ROBOT_PROVIDER_SYNC_EVERY del api.env de la
# instancia: con HELGA_MODE=off el robot no consulta nada.
#
# Que hace: igual que verificar-sub-casilleros.ps1, pide a la instancia (SSM) un
# contenedor de un solo uso con `psql` y el mismo /opt/courier/api.env de la API.
# Solo SELECT: no escribe nada en la base.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-pendientes-sync.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-pendientes-sync.ps1 -Limit 1000 -Csv .\pendientes.csv

param(
  [int]$Limit = 200,
  [string]$Csv
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$InstanceTag = 'courier-api'
$SyncBatch = 200

aws sts get-caller-identity --output text | Out-Null
if (-not $?) { throw "Sesion de AWS expirada o sin credenciales. Ejecuta 'aws login' y repite." }

Write-Host "Buscando la instancia '$InstanceTag' en $Region..."
$instance = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=$InstanceTag" "Name=instance-state-name,Values=running" `
  --query "Reservations[].Instances[].InstanceId" --output text
if (-not $instance -or $instance -eq 'None') {
  throw "No hay ninguna instancia '$InstanceTag' en marcha. Revisa el perfil de AWS y la region."
}
Write-Host "Instancia: $instance"

# Filtro comun: copia del WHERE de `shipmentsInProviderTramo`.
$tramo = "s.shipment_type = 'paqueteria' and s.state in ('prealertado','recibido_bodega_miami','preparando_envio','en_transito_costa_rica')"

# Las fechas salen en epoch (UTC) y se pasan a hora local aqui, en la presentacion.
$consulta = @(
  "select 'ESTADO|' || s.state || '|' || count(*) || '|' || count(*) filter (where s.provider_checked_at is null) || '|' || count(*) filter (where s.client_id is null) || '|' || count(*) filter (where s.discarded_at is not null) from shipments s where $tramo group by s.state order by s.state",
  "select 'CUENTA|' || coalesce(s.provider_account_code, 'principal') || '|' || count(*) from shipments s where $tramo group by s.provider_account_code order by s.provider_account_code nulls first",
  "select 'PAQ|' || row_number() over (order by s.provider_checked_at asc nulls first, s.updated_at asc) || '|' || s.code || '|' || s.state || '|' || s.tracking || '|' || coalesce(c.code, 'SIN DUENO') || '|' || coalesce(s.provider_account_code, 'principal') || '|' || coalesce(extract(epoch from s.provider_checked_at)::bigint::text, '') || '|' || extract(epoch from s.updated_at)::bigint || '|' || case when s.discarded_at is null then '' else 'si' end from shipments s left join clients c on c.id = s.client_id where $tramo order by s.provider_checked_at asc nulls first, s.updated_at asc limit $Limit"
)
$psqlArgs = ($consulta | ForEach-Object { '-c "' + $_ + '"' }) -join ' '
$interior = "psql `"`$DATABASE_URL`" -At -v ON_ERROR_STOP=1 $psqlArgs".Replace("'", "'\''")
$comandos = @(
  "grep -E '^(HELGA_MODE|ROBOT_PROVIDER_SYNC_EVERY)=' /opt/courier/api.env | sed 's/^/CONFIG|/' || true",
  "docker run --rm --env-file /opt/courier/api.env postgres:16-alpine sh -c '$interior'"
)

$paramsFile = Join-Path $env:TEMP 'helga-pendientes-sync.json'
@{ commands = $comandos } | ConvertTo-Json -Compress |
  Out-File -FilePath $paramsFile -Encoding ascii

Write-Host 'Consultando la base de produccion (solo lectura)...'
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment 'paquetes pendientes de sincronizar con Helga' `
  --parameters "file://$paramsFile" `
  --timeout-seconds 300 `
  --query 'Command.CommandId' --output text
Remove-Item $paramsFile -ErrorAction SilentlyContinue

$status = 'Pending'
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  $status = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance --query 'Status' --output text 2>$null
  if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
}

# SSM recorta la salida en consola a 24.000 caracteres; con muchos paquetes baja -Limit.
$salida = aws ssm get-command-invocation --region $Region `
  --command-id $commandId --instance-id $instance `
  --query 'StandardOutputContent' --output text

if ($status -ne 'Success') {
  $errores = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance `
    --query 'StandardErrorContent' --output text
  Write-Host $salida
  Write-Host $errores -ForegroundColor Red
  throw "La consulta termino en estado $status."
}

function ToLocal([string]$epoch) {
  if (-not $epoch) { return 'nunca' }
  [DateTimeOffset]::FromUnixTimeSeconds([long]$epoch).LocalDateTime.ToString('yyyy-MM-dd HH:mm')
}

$lineas = @($salida -split "`r?`n" | Where-Object { $_.Trim() -ne '' })

Write-Host ''
Write-Host 'Configuracion del robot en la instancia:' -ForegroundColor Cyan
$config = @($lineas | Where-Object { $_ -like 'CONFIG|*' })
if ($config.Count -eq 0) { Write-Host '  (sin HELGA_MODE ni ROBOT_PROVIDER_SYNC_EVERY en api.env: valen los defaults, HELGA_MODE=off)' }
$config | ForEach-Object { Write-Host "  $($_.Substring(7))" }
if ($config -contains 'CONFIG|HELGA_MODE=off') {
  Write-Host '  HELGA_MODE=off: el robot NO consulta a Helga.' -ForegroundColor Yellow
}

$porEstado = $lineas | Where-Object { $_ -like 'ESTADO|*' } | ForEach-Object {
  $f = $_.Split('|')
  [pscustomobject]@{ Estado = $f[1]; Total = [int]$f[2]; NuncaConsultados = [int]$f[3]; SinDueno = [int]$f[4]; Descartados = [int]$f[5] }
}
$total = ($porEstado | Measure-Object Total -Sum).Sum
Write-Host ''
Write-Host "Paquetes en el tramo del proveedor: $([int]$total)" -ForegroundColor Cyan
$porEstado | Format-Table -AutoSize | Out-String | Write-Host

Write-Host 'Por cuenta de Helga (decide con que token se consulta):' -ForegroundColor Cyan
$lineas | Where-Object { $_ -like 'CUENTA|*' } | ForEach-Object {
  $f = $_.Split('|')
  [pscustomobject]@{ Cuenta = $f[1]; Paquetes = [int]$f[2] }
} | Format-Table -AutoSize | Out-String | Write-Host

$paquetes = @($lineas | Where-Object { $_ -like 'PAQ|*' } | ForEach-Object {
  $f = $_.Split('|')
  [pscustomobject]@{
    '#'               = [int]$f[1]
    Codigo            = $f[2]
    Estado            = $f[3]
    Tracking          = $f[4]
    Cliente           = $f[5]
    Cuenta            = $f[6]
    UltimaConsulta    = ToLocal $f[7]
    Actualizado       = ToLocal $f[8]
    Descartado        = $f[9]
  }
})

Write-Host "Orden de consulta (los primeros $SyncBatch entran en la proxima corrida; se muestran hasta $Limit):" -ForegroundColor Cyan
$paquetes | Format-Table -AutoSize | Out-String -Width 250 | Write-Host

if ($Csv) {
  $paquetes | Export-Csv -Path $Csv -NoTypeInformation -Encoding UTF8
  Write-Host "CSV guardado en $((Resolve-Path $Csv).Path)" -ForegroundColor Green
}
