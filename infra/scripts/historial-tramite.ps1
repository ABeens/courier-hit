# Muestra el historial de un tramite en PRODUCCION y dice que movimientos hizo el
# robot de Helga y cuales una persona desde el panel.
#
# El historial no lo distingue a simple vista: el robot escribe eventos con
# `created_by`, que es una FK a un usuario real, asi que firma con el nombre del
# staff activo mas antiguo (ver resolveSystemSession en core/scheduler/jobs.ts).
# "Registrado por Administrador HS" puede ser una persona o el robot. Lo que si
# los separa:
#   - ROBOT sync:        la nota fija 'Actualizado desde el operador en Miami.'
#                        (provider-sync.service.ts, avance por el tramo del proveedor).
#   - ROBOT alta:        el PRIMER evento ya nace en un estado del proveedor y sin
#                        nota. Es el descubrimiento de paquetes (provider-discovery),
#                        que importa el paquete en el estado que trae Helga. Un alta
#                        manual nace en Prealertado, y el paquete sin dueno de la sala
#                        de control nace con nota.
#   - MANUAL:            el resto de eventos con autor.
#
# Que hace: pide a la instancia que lance un contenedor de un solo uso con `psql`,
# con el mismo /opt/courier/api.env de la API, y ejecuta consultas de SOLO LECTURA.
# No escribe nada en la base.
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\infra\scripts\historial-tramite.ps1 -Code HSX000002334
#       (tambien acepta el tracking)

param(
  [Parameter(Mandatory = $true)][string]$Code
)

$ErrorActionPreference = 'Stop'

# Las notas pueden traer caracteres fuera del codepage de la consola (p. ej. la
# flecha de una correccion). La CLI de AWS es Python y, sin esto, imprime con
# 'charmap', falla al escribir la salida y la consulta parece vacia.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Region = 'us-east-1'
$InstanceTag = 'courier-api'

# El valor va pegado dentro del SQL: solo se aceptan letras, digitos y guiones.
$Code = $Code.Trim()
if ($Code -notmatch '^[A-Za-z0-9-]{3,64}$') {
  Write-Error "'$Code' no parece un codigo ni un tracking valido."
  exit 1
}

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

$robotNote = 'Actualizado desde el operador en Miami.'
$providerStates = "'recibido_bodega_miami','preparando_envio','en_transito_costa_rica','en_aduanas'"
$match = "(s.code = '$Code' or s.tracking = '$Code')"

$consulta = @(
  "select 'ROBOT_FIRMA=' || name from users where principal = 'staff' and status = 'activo' order by created_at asc limit 1",
  "select 'TRAMITE=' || s.code || ' | tracking ' || s.tracking || ' | estado ' || s.state || ' | prealerta Helga ' || coalesce(s.helga_prealert_status::text, '-') || ' | cuenta ' || coalesce(s.provider_account_code, 'principal') from shipments s where $match",
  # Por que la prealerta llego (o no) a Helga. `prealerta null` + cuenta exclusiva
  # = cliente consolidado: no se replica por diseno (shipments.service insert).
  "select 'PREALERTA=' || s.code || ' | id en Helga ' || coalesce(s.helga_prealert_id, '-') || ' | intentos ' || s.helga_prealert_attempts || ' | error ' || coalesce(s.helga_prealert_error, '-') || ' | casillero ' || coalesce(c.code, 'SIN DUENO') || ' | enlace Helga ' || coalesce(c.helga_sync_status::text, '-') || ' destinatario ' || coalesce(c.helga_client_id, '-') || ' | cuenta exclusiva ' || coalesce(pa.code || ' (' || pa.name || ')', 'no') from shipments s left join clients c on c.id = s.client_id left join provider_accounts pa on pa.consolidated_client_id = s.client_id where $match",
  "select 'EVENTO=' || to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC (' || to_char(e.created_at at time zone 'America/Costa_Rica', 'DD Mon HH24:MI') || ' CR) | ' || e.state || ' | ' || case when e.note = '$robotNote' then 'ROBOT sync' when e.n = 1 and e.note is null and e.state::text in ($providerStates) then 'ROBOT alta (descubrimiento)' when e.created_by is null then 'sin autor' else 'MANUAL (panel)' end || ' | firma ' || coalesce(u.name, '-') || ' | nota ' || coalesce(e.note, '-') from (select ev.*, row_number() over (order by ev.created_at) n from shipment_events ev join shipments s on s.id = ev.shipment_id where $match) e left join users u on u.id = e.created_by order by e.created_at"
)
$psqlArgs = ($consulta | ForEach-Object { '-c "' + $_ + '"' }) -join ' '
# Las comillas simples del SQL van dentro de un `sh -c '...'`: se cierran y se
# reabren con '\'' para que lleguen intactas.
$interior = "psql `"`$DATABASE_URL`" -At -v ON_ERROR_STOP=1 $psqlArgs".Replace("'", "'\''")
$comando = "docker run --rm --env-file /opt/courier/api.env postgres:16-alpine sh -c '$interior'"

# Los parametros viajan en un fichero JSON: pasar comillas anidadas por la linea
# de comandos de PowerShell a la CLI de AWS es una fuente segura de errores.
$paramsFile = Join-Path $env:TEMP 'historial-tramite.json'
@{ commands = @($comando) } | ConvertTo-Json -Compress |
  Out-File -FilePath $paramsFile -Encoding ascii

Write-Host 'Consultando la base de produccion (solo lectura)...'
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment "historial de $Code" `
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

$lineas = @($salida -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
# La primera consulta siempre devuelve la firma del robot: si no esta, la salida
# no se pudo leer y decir "no existe el tramite" seria mentir.
if (-not ($lineas | Where-Object { $_ -like 'ROBOT_FIRMA=*' })) {
  throw 'No se pudo leer la salida de la consulta (revisa el mensaje de arriba).'
}
$robot = ($lineas | Where-Object { $_ -like 'ROBOT_FIRMA=*' }) -replace '^ROBOT_FIRMA=', ''
$tramites = @($lineas | Where-Object { $_ -like 'TRAMITE=*' } | ForEach-Object { $_ -replace '^TRAMITE=', '' })
$prealertas = @($lineas | Where-Object { $_ -like 'PREALERTA=*' } | ForEach-Object { $_ -replace '^PREALERTA=', '' })
$eventos = @($lineas | Where-Object { $_ -like 'EVENTO=*' } | ForEach-Object { $_ -replace '^EVENTO=', '' })

Write-Host ''
if ($tramites.Count -eq 0) {
  Write-Host "No hay ningun tramite con codigo o tracking '$Code' en produccion." -ForegroundColor Yellow
  exit 0
}

Write-Host "El robot firma como: $robot" -ForegroundColor Cyan
$tramites | ForEach-Object { Write-Host $_ }
$prealertas | ForEach-Object { Write-Host $_ -ForegroundColor Cyan }
Write-Host ''
foreach ($e in $eventos) {
  $color = if ($e -like '*| ROBOT*') { 'Yellow' } elseif ($e -like '*| MANUAL*') { 'Green' } else { 'Gray' }
  Write-Host "  $e" -ForegroundColor $color
}
