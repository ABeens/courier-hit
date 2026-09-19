<#
  BORRA TODOS LOS TRAMITES. Es irreversible y no hay "deshacer".

  Que se lleva por delante:
    shipments, shipment_events, shipment_costs, delivery_attempts, payments,
    payment_groups, proforma_numbers y los adjuntos de todo eso (documentos de
    tramite, fotos de entrega y comprobantes de deposito). Ademas devuelve a 1000
    los consecutivos de TRAMITE y de PROFORMA.

  Que NO toca:
    usuarios, casilleros (y su consecutivo), tarifas, servicios de costo, rutas,
    configuracion, claves de API y cuentas del proveedor. Se va el movimiento; se
    queda el catalogo, que es lo que cuesta volver a montar.

  Quien borra de verdad: apps/api/src/clean-shipments.ts. Este script solo decide
  DONDE corre, para que la lista de tablas no viva en dos sitios. Los adjuntos se
  borran por su CLAVE, leida de la base, y no arrasando prefijos del bucket.

  Local y AWS son dos caminos distintos porque la base de produccion vive en
  subredes privadas y NO es alcanzable desde aqui: en la nube el borrado se
  ejecuta dentro de la instancia, por SSM, con la misma imagen que corre la API
  (el mismo mecanismo con el que se aplican las migraciones al desplegar).

  En AWS hace falta que la instancia tenga una imagen con el rediseño de estados
  ya desplegado: `dist/clean-shipments.js` nacio con el. Si el comando falla con
  "Cannot find module", despliega primero.

  Uso:
    powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-tramites.ps1 -Entorno local -Simular
      Cuenta lo que se borraria en la base LOCAL y no toca nada.

    powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-tramites.ps1 -Entorno local
      Borra en la base LOCAL. Ensena el recuento y pide confirmacion escrita.

    powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-tramites.ps1 -Entorno aws -Simular
      Cuenta lo que se borraria en PRODUCCION. No toca nada.

    powershell -ExecutionPolicy Bypass -File .\scripts\limpiar-tramites.ps1 -Entorno aws
      Borra en PRODUCCION. Pide escribir la frase completa.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('local', 'aws')]
  [string]$Entorno,

  [switch]$Simular,

  [string]$Region = 'us-east-1',
  [string]$InstanceTag = 'courier-api'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# ---------------------------------------------------------------------------
# Ejecutores. Los dos corren el MISMO entry point; cambia donde y con que env.
# ---------------------------------------------------------------------------

function Invoke-Local {
  param([bool]$DryRun)

  if (-not (Test-Path 'apps/api/.env')) {
    throw "No existe apps/api/.env. Copia apps/api/.env.example y pon tu DATABASE_URL."
  }

  # tsx carga apps/api/.env (la base y el almacen); CLEAN_DRY_RUN viaja desde
  # aqui por el entorno del proceso hijo.
  if ($DryRun) { $env:CLEAN_DRY_RUN = '1' } else { Remove-Item env:CLEAN_DRY_RUN -ErrorAction SilentlyContinue }

  Push-Location 'apps/api'
  try {
    pnpm exec tsx --env-file=.env src/clean-shipments.ts
    if ($LASTEXITCODE -ne 0) { throw "La limpieza local termino con codigo $LASTEXITCODE." }
  }
  finally {
    Pop-Location
    Remove-Item env:CLEAN_DRY_RUN -ErrorAction SilentlyContinue
  }
}

function Get-ApiInstance {
  $instance = aws ec2 describe-instances --region $Region `
    --filters "Name=tag:Name,Values=$InstanceTag" "Name=instance-state-name,Values=running" `
    --query "Reservations[].Instances[].InstanceId" --output text

  if (-not $instance -or $instance -eq 'None') {
    throw "No hay ninguna instancia '$InstanceTag' en marcha. Revisa el perfil de AWS y la region."
  }
  return $instance.Trim()
}

function Invoke-Aws {
  param([bool]$DryRun)

  $instance = Get-ApiInstance
  Write-Host "Instancia: $instance"

  # image.env trae IMAGE=repositorio:tag, la misma que corre la API y la que
  # aplica las migraciones. api.env trae DATABASE_URL y el bucket de adjuntos.
  $dry = if ($DryRun) { '1' } else { '0' }
  $remote = @(
    'set -a; . /opt/courier/image.env; set +a',
    "docker run --rm --env-file /opt/courier/api.env -e CLEAN_DRY_RUN=$dry `"`$IMAGE`" node dist/clean-shipments.js"
  )
  $commands = $remote | ConvertTo-Json -Compress
  $parameters = "commands=$commands"

  $commandId = aws ssm send-command --region $Region `
    --instance-ids $instance `
    --document-name AWS-RunShellScript `
    --comment 'limpiar tramites' `
    --parameters $parameters `
    --timeout-seconds 900 `
    --query 'Command.CommandId' --output text

  Write-Host "Comando $commandId, esperando..."

  $status = 'Pending'
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    $status = aws ssm get-command-invocation --region $Region `
      --command-id $commandId --instance-id $instance `
      --query 'Status' --output text 2>$null
    if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
    Write-Host "  ...$status"
  }

  aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance `
    --query 'StandardOutputContent' --output text

  if ($status -ne 'Success') {
    aws ssm get-command-invocation --region $Region `
      --command-id $commandId --instance-id $instance `
      --query 'StandardErrorContent' --output text
    throw "La limpieza termino en estado $status"
  }
}

function Invoke-Clean {
  param([bool]$DryRun)
  if ($Entorno -eq 'local') { Invoke-Local -DryRun $DryRun } else { Invoke-Aws -DryRun $DryRun }
}

# ---------------------------------------------------------------------------
# 1) Recuento. Siempre, tambien cuando se va a borrar: nadie deberia confirmar
#    un borrado sin ver antes cuanto se lleva.
# ---------------------------------------------------------------------------
$destino = if ($Entorno -eq 'aws') { 'PRODUCCION (AWS)' } else { 'la base LOCAL' }

Write-Host ''
Write-Host "Contando los tramites de $destino..." -ForegroundColor Cyan
Invoke-Clean -DryRun $true

if ($Simular) {
  Write-Host ''
  Write-Host 'Simulacion: no se toco nada.' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------------------
# 2) Confirmacion escrita. La frase se teclea entera a proposito: un borrado sin
#    vuelta atras no puede quedar a un Enter de distancia.
# ---------------------------------------------------------------------------
$frase = if ($Entorno -eq 'aws') { 'BORRAR PRODUCCION' } else { 'BORRAR' }

Write-Host ''
Write-Host "Esto BORRA esos tramites de $destino. No se puede deshacer." -ForegroundColor Red
if ($Entorno -eq 'aws') {
  Write-Host 'Son los datos reales de los clientes. La copia de seguridad de RDS' -ForegroundColor Red
  Write-Host 'guarda 7 dias, asi que recuperarlos significa restaurar la base entera.' -ForegroundColor Red
}
Write-Host ''
$respuesta = Read-Host "Escribe $frase para continuar (cualquier otra cosa cancela)"

if ($respuesta -cne $frase) {
  Write-Host 'Cancelado. No se borro nada.' -ForegroundColor Yellow
  exit 1
}

# ---------------------------------------------------------------------------
# 3) Borrado.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host "Borrando en $destino..." -ForegroundColor Cyan
Invoke-Clean -DryRun $false

Write-Host ''
Write-Host "Listo: $destino se quedo sin tramites." -ForegroundColor Green
Write-Host 'Los usuarios, casilleros, tarifas, rutas y la configuracion siguen ahi.'
if ($Entorno -eq 'local') {
  Write-Host 'Para volver a tener datos de prueba:'
  Write-Host '  pnpm --filter @courier/api db:seed:demo'
}
