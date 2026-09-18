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

# La instancia puede acabar de NACER: un `cdk deploy` la reemplaza cada vez que
# cambia su script de arranque o rota la AMI de Amazon Linux, y entonces esto
# encuentra una maquina recien encendida. El agente de SSM responde antes de que
# cloud-init termine, asi que mandar el comando de una lanza un
# "/opt/courier/deploy.sh: No such file or directory" (exit 127) que parece un
# fallo grave y no lo es: el fichero lo escribe el propio arranque, minutos
# despues. Se espera a que exista.
#
# Y si el arranque acaba de pasar, no hace falta recargar nada: cloud-init
# termina ejecutando ese mismo deploy.sh, o sea que el proceso ya levanto con la
# configuracion nueva. El script lo dice y sale.
Write-Host 'Comprobando que la instancia termino de arrancar...'
$bootCheck = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment 'estado de cloud-init' `
  --parameters 'commands=["cloud-init status 2>/dev/null | head -1","test -x /opt/courier/deploy.sh && echo DEPLOY_SH_OK || echo DEPLOY_SH_MISSING"]' `
  --timeout-seconds 300 `
  --query 'Command.CommandId' --output text

$bootOut = ''
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 10
  $s = aws ssm get-command-invocation --region $Region `
    --command-id $bootCheck --instance-id $instance --query 'Status' --output text 2>$null
  if ($s -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) {
    $bootOut = aws ssm get-command-invocation --region $Region `
      --command-id $bootCheck --instance-id $instance `
      --query 'StandardOutputContent' --output text 2>$null
    break
  }
}

if ($bootOut -match 'DEPLOY_SH_MISSING') {
  Write-Host ''
  Write-Host 'La instancia todavia esta arrancando: /opt/courier/deploy.sh aun no existe.' -ForegroundColor Yellow
  Write-Host 'Eso pasa cuando un `cdk deploy` acaba de reemplazarla. NO hay nada que hacer:'
  Write-Host 'su propio arranque termina ejecutando deploy.sh y levanta con el env nuevo.'
  Write-Host 'Espera dos o tres minutos y comprueba con:'
  Write-Host '  curl -s -I -X OPTIONS https://www.hsglobal-services.com/api/auth/login -H "Origin: https://www.hsglobal-services.com" -H "Access-Control-Request-Method: POST"'
  Write-Host 'La cabecera access-control-allow-origin es el WEB_ORIGIN que tiene cargado.'
  exit 0
}

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
