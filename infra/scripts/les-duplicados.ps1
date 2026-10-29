# Lista los LES (HAWB) duplicados en la base de PRODUCCION y los guarda en un CSV.
#
# Duplicado = el mismo `shipments.hawb` (sin distinguir mayusculas ni espacios,
# igual que la busqueda de bodega) en dos o mas paquetes. Los paquetes
# DESCARTADOS no cuentan: ni entran al conteo ni salen en el archivo.
#
# Una fila por paquete, ordenadas por LES y fecha de alta, para ver juntos los
# que comparten guia. Fechas en UTC (ISO 8601). Solo lectura.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\les-duplicados.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\les-duplicados.ps1 -Salida C:\temp\les.csv

param(
  [string]$Salida = (Join-Path (Get-Location) "les-duplicados-$(Get-Date -Format 'yyyyMMdd-HHmm').csv")
)

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

$sql = @"
copy (
  with vivos as (
    select s.*, upper(btrim(s.hawb)) as les
    from shipments s
    where s.hawb is not null and btrim(s.hawb) <> '' and s.discarded_at is null
  ),
  dup as (
    select les, count(*) as veces from vivos group by les having count(*) > 1
  )
  select v.les, d.veces, v.code as paquete, v.tracking, v.state as estado,
    v.shipment_type as tipo, coalesce(c.code, '') as casillero, coalesce(u.name, '') as cliente,
    coalesce(v.provider_account_code, '') as cuenta_proveedor,
    to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as creado_utc
  from vivos v
  join dup d on d.les = v.les
  left join clients c on c.id = v.client_id
  left join users u on u.id = c.user_id
  order by v.les, v.created_at, v.code
) to stdout with (format csv, header true);
"@

# El SQL viaja en base64 y entra a psql por stdin: asi no hay que escapar
# comillas a traves de PowerShell, la CLI de AWS, bash y sh. El CSV vuelve
# comprimido (gzip + base64) porque SSM recorta la salida a 24.000 caracteres.
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sql))
$comando = "echo $b64 | base64 -d | docker run --rm -i --env-file /opt/courier/api.env postgres:16-alpine sh -c 'psql `"`$DATABASE_URL`" -v ON_ERROR_STOP=1 -f -' | gzip -9 | base64 -w0"

$paramsFile = Join-Path $env:TEMP 'les-duplicados.json'
@{ commands = @($comando) } | ConvertTo-Json -Compress |
  Out-File -FilePath $paramsFile -Encoding ascii

Write-Host 'Consultando LES duplicados en produccion (solo lectura)...'
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment 'les-duplicados' `
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

$salidaSsm = aws ssm get-command-invocation --region $Region `
  --command-id $commandId --instance-id $instance `
  --query 'StandardOutputContent' --output text
if ($status -ne 'Success') {
  $errores = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance `
    --query 'StandardErrorContent' --output text
  Write-Host $errores -ForegroundColor Red
  throw "La consulta termino en estado $status."
}

# SSM recorta la salida a 24.000 caracteres: si llega cortada, el gzip no se
# puede abrir y se avisa en vez de guardar un archivo incompleto.
if ($salidaSsm -match 'Output truncated') {
  throw 'La salida de SSM se trunco (demasiados duplicados para una sola consulta).'
}
$gz = [Convert]::FromBase64String($salidaSsm.Trim())
$stream = New-Object System.IO.Compression.GZipStream((New-Object System.IO.MemoryStream(, $gz)), [System.IO.Compression.CompressionMode]::Decompress)
$reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8)
$csv = $reader.ReadToEnd()
$reader.Close()

$lineas = @($csv -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
# UTF-8 con BOM para que Excel respete los acentos.
$lineas | Out-File -FilePath $Salida -Encoding utf8

$filas = [Math]::Max(0, $lineas.Count - 1)
$grupos = @($lineas | Select-Object -Skip 1 | ForEach-Object { ($_ -split ',')[0] } | Sort-Object -Unique).Count
Write-Host ''
if ($filas -eq 0) {
  Write-Host 'No hay LES duplicados (sin contar descartados).' -ForegroundColor Green
} else {
  Write-Host "$grupos LES duplicado(s), $filas paquete(s) en total." -ForegroundColor Cyan
}
Write-Host "Archivo: $Salida"
