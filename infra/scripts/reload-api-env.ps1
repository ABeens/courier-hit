# Recarga la configuracion de la API en la instancia y reinicia el servicio.
#
# Cuando hace falta: despues de cambiar cualquier parametro de
# /courier/prod/* en Parameter Store. El contenedor NO relee SSM por su cuenta;
# el fichero /opt/courier/api.env solo se reescribe cuando corre
# /opt/courier/deploy.sh, asi que un `put-parameter` por si solo no cambia nada
# en el proceso que esta corriendo.
#
# Que hace: pide a la instancia que ejecute su propio deploy.sh con la imagen
# que ya tiene (`latest`). Eso regenera el env desde SSM, aplica migraciones si
# las hubiera y reinicia el servicio. No reconstruye ni publica imagen: para eso
# esta infra/scripts/deploy-local.sh api.
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\infra\scripts\reload-api-env.ps1

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$InstanceTag = 'courier-api'

Write-Host "Buscando la instancia '$InstanceTag' en $Region..."
$instance = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=$InstanceTag" "Name=instance-state-name,Values=running" `
  --query "Reservations[].Instances[].InstanceId" --output text

if (-not $instance -or $instance -eq 'None') {
  Write-Error "No hay ninguna instancia '$InstanceTag' en marcha. Revisa el perfil de AWS y la region."
  exit 1
}
Write-Host "Instancia: $instance"

Write-Host 'Lanzando /opt/courier/deploy.sh latest...'
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment 'reload api env desde SSM' `
  --parameters 'commands=["/opt/courier/deploy.sh latest"]' `
  --timeout-seconds 900 `
  --query 'Command.CommandId' --output text

Write-Host "Comando $commandId, esperando (tarda uno o dos minutos)..."

# Se sondea en vez de esperar a ciegas: el reinicio tarda distinto segun si hay
# migraciones que aplicar y segun lo que tarde el pull de la imagen.
$status = 'Pending'
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 10
  $status = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance `
    --query 'Status' --output text 2>$null
  if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
  Write-Host "  ...$status"
}

Write-Host ''
Write-Host "Estado: $status"
aws ssm get-command-invocation --region $Region `
  --command-id $commandId --instance-id $instance `
  --query 'StandardOutputContent' --output text

if ($status -ne 'Success') {
  aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance `
    --query 'StandardErrorContent' --output text
  Write-Error "El despliegue termino en estado $status"
  exit 1
}

Write-Host ''
Write-Host 'Listo. Para comprobar el webhook de Onvo, deja corriendo:'
Write-Host '  aws logs tail /courier/prod/api --region us-east-1 --follow --since 1m'
Write-Host 'y haz un pago de prueba: la linea del webhook tiene que responder 200, no 401.'
