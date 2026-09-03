<#
  Cambia el remitente de los correos (MAIL_FROM) en produccion y manda el correo
  de aprobacion de SES a la nueva direccion.

  Son dos cosas independientes y hacen falta las dos:
    1. Verificar la identidad en SES. AWS manda un correo con un enlace que hay
       que abrir desde la casilla; hasta entonces SES rechaza cualquier envio
       desde esa direccion.
    2. Actualizar /courier/prod/MAIL_FROM en Parameter Store, que es de donde la
       instancia saca sus variables al desplegar.

  El valor tambien esta en infra/lib/app-stack.ts (ya actualizado). Ese es el que
  manda: un `cdk deploy` devuelve el parametro a lo que diga el codigo.

  Uso:
    powershell -ExecutionPolicy Bypass -File scripts/ses-mail-from.ps1
    powershell -ExecutionPolicy Bypass -File scripts/ses-mail-from.ps1 -Aplicar

  -Aplicar reejecuta el despliegue en la instancia para que el valor nuevo entre
  en la maquina. Sin el, el cambio entra en el proximo despliegue normal.
#>
param(
  [string]$Direccion = 'servicioalcliente1@hsglobal-services.com',
  [string]$Nombre    = 'HS Global Services',
  [string]$Region    = 'us-east-1',
  [string]$Parametro = '/courier/prod/MAIL_FROM',
  [string]$Instancia = 'courier-api',
  [switch]$Aplicar
)

$ErrorActionPreference = 'Stop'
$MailFrom = "$Nombre <$Direccion>"

Write-Host "== Sesion AWS =="
$identidad = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "La sesion de AWS no esta activa. Autenticate y vuelve a lanzar el script:" -ForegroundColor Yellow
  Write-Host "  aws login" -ForegroundColor Yellow
  exit 1
}
$identidad

Write-Host ""
Write-Host "== 1. Correo de aprobacion de SES a $Direccion =="
# verify-email-identity crea la identidad si no existe y reenvia el correo de
# verificacion si existe y sigue pendiente. Por eso se usa esta y no
# sesv2 create-email-identity, que falla con AlreadyExists.
aws ses verify-email-identity --email-address $Direccion --region $Region
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "Enviado. Abre el enlace desde la casilla $Direccion." -ForegroundColor Green

Write-Host ""
Write-Host "== 2. Estado de la identidad =="
aws sesv2 get-email-identity --email-identity $Direccion --region $Region `
  --query "{Verificada:VerifiedForSendingStatus,Tipo:IdentityType}" --output table

Write-Host ""
Write-Host "== 3. Parameter Store: $Parametro =="
aws ssm put-parameter --name $Parametro --value $MailFrom --type String --overwrite --region $Region --output text
if ($LASTEXITCODE -ne 0) { exit 1 }
aws ssm get-parameter --name $Parametro --region $Region --query Parameter.Value --output text

if (-not $Aplicar) {
  Write-Host ""
  Write-Host "Hecho. El valor nuevo entra en la instancia en el proximo despliegue." -ForegroundColor Green
  Write-Host "Para aplicarlo ahora, relanza con -Aplicar." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "== 4. Aplicar en la instancia =="
$id = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=$Instancia" "Name=instance-state-name,Values=running" `
  --query "Reservations[0].Instances[0].InstanceId" --output text
if ($LASTEXITCODE -ne 0 -or $id -eq 'None' -or [string]::IsNullOrWhiteSpace($id)) {
  Write-Host "No hay ninguna instancia '$Instancia' en marcha." -ForegroundColor Red
  exit 1
}
Write-Host "Instancia: $id"

# Reescribe api.env con los parametros de la ruta y reinicia el servicio, usando
# la MISMA imagen que ya esta corriendo (la lee de /opt/courier/image.env). No
# despliega version nueva.
$comando = 'set -e; . /opt/courier/image.env; /opt/courier/deploy.sh "${IMAGE##*:}"'
$cmdId = aws ssm send-command --instance-ids $id --region $Region `
  --document-name AWS-RunShellScript `
  --comment "MAIL_FROM" `
  --parameters commands="$comando" `
  --timeout-seconds 900 --query "Command.CommandId" --output text
if ($LASTEXITCODE -ne 0) { exit 1 }

$estado = 'Pending'
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 10
  try {
    $estado = aws ssm get-command-invocation --command-id $cmdId --instance-id $id --region $Region --query Status --output text
  } catch {
    $estado = 'Pending'
  }
  Write-Host "  estado: $estado"
  if ($estado -in @('Success','Failed','Cancelled','TimedOut')) { break }
}

aws ssm get-command-invocation --command-id $cmdId --instance-id $id --region $Region --query StandardOutputContent --output text
if ($estado -ne 'Success') {
  aws ssm get-command-invocation --command-id $cmdId --instance-id $id --region $Region --query StandardErrorContent --output text
  Write-Host "El despliegue termino en estado $estado" -ForegroundColor Red
  exit 1
}
Write-Host "Listo." -ForegroundColor Green
