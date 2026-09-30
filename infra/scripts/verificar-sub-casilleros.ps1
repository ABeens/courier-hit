# Comprueba, en la base de PRODUCCION, que la migracion 0046 va a poder entrar.
#
# La 0046 (0046_unique_helga_sub_locker.sql) crea un indice UNICO sobre
# `clients.helga_sub_locker`: un sub-casillero de Miami, un solo cliente. Si en la
# base ya hay dos clientes con el mismo sub-casillero, el indice no se puede crear,
# la migracion falla y el despliegue se detiene (el servicio viejo sigue en pie,
# docs/12 §6.3). Mejor saberlo ANTES de desplegar.
#
# En desarrollo paso justo eso, por datos de un seed viejo que recortaba el numero
# a tres digitos (HS-2567 y HS-3567 quedaban los dos como SJO008835S567).
#
# Que hace: pide a la instancia que lance un contenedor de un solo uso con `psql`,
# con el mismo /opt/courier/api.env de la API, y ejecuta dos consultas de SOLO
# LECTURA:
#   1. cuantas migraciones tiene anotadas la base (el repo tiene 48, 0000 a 0047);
#   2. que sub-casilleros estan repetidos y en que clientes.
# No escribe nada en la base.
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\infra\scripts\verificar-sub-casilleros.ps1

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$InstanceTag = 'courier-api'

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

# El comando es para bash en LINUX. `$DATABASE_URL` va entre comillas simples
# para que no lo expanda la instancia sino el `sh` del contenedor, que es donde
# existe (sale del --env-file).
$consulta = @(
  'select ''MIGRACIONES_ANOTADAS='' || count(*) from drizzle.__drizzle_migrations',
  'select helga_sub_locker || '' -> '' || count(*) || '' clientes: '' || string_agg(code, '', '' order by code) from clients where helga_sub_locker is not null group by helga_sub_locker having count(*) > 1 order by count(*) desc limit 100'
)
$psqlArgs = ($consulta | ForEach-Object { '-c "' + $_ + '"' }) -join ' '
# Las comillas simples del SQL van dentro de un `sh -c '...'`: se cierran y se
# reabren con '\'' para que lleguen intactas.
$interior = "psql `"`$DATABASE_URL`" -At -v ON_ERROR_STOP=1 $psqlArgs".Replace("'", "'\''")
$comando = "docker run --rm --env-file /opt/courier/api.env postgres:16-alpine sh -c '$interior'"

# Los parametros viajan en un fichero JSON: pasar comillas anidadas por la linea
# de comandos de PowerShell a la CLI de AWS es una fuente segura de errores.
$paramsFile = Join-Path $env:TEMP 'verificar-sub-casilleros.json'
@{ commands = @($comando) } | ConvertTo-Json -Compress |
  Out-File -FilePath $paramsFile -Encoding ascii

Write-Host 'Consultando la base de produccion (solo lectura)...'
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment 'verificar sub-casilleros duplicados (0046)' `
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
$anotadas = ($lineas | Where-Object { $_ -like 'MIGRACIONES_ANOTADAS=*' }) -replace 'MIGRACIONES_ANOTADAS=', ''
$duplicados = @($lineas | Where-Object { $_ -notlike 'MIGRACIONES_ANOTADAS=*' })

Write-Host ''
Write-Host "Migraciones anotadas en produccion: $anotadas de 48 que tiene el repo."

if ($duplicados.Count -eq 0) {
  Write-Host 'Sin sub-casilleros repetidos. La 0046 entra sin problema: puedes desplegar.' -ForegroundColor Green
  exit 0
}

Write-Host "Hay $($duplicados.Count) sub-casillero(s) repetido(s) (se muestran hasta 100):" -ForegroundColor Yellow
$duplicados | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host 'NO despliegues todavia: la 0046 fallaria. Hay que decidir, cliente por cliente,' -ForegroundColor Yellow
Write-Host 'cual es el duenio real de cada sub-casillero (docs/13) y corregir los demas.' -ForegroundColor Yellow
exit 2
