# Muestra y escala el disco (EBS) de la instancia de la API.
#
# Sin -Size solo INFORMA: tamano del volumen, uso real del disco y que ocupa
# Docker. Con -Size hace el crecimiento completo en caliente, sin reiniciar
# nada ni cortar el servicio:
#
#   1. aws ec2 modify-volume        (agranda el disco en AWS)
#   2. growpart                     (agranda la particion dentro del disco)
#   3. xfs_growfs / resize2fs       (agranda el sistema de ficheros)
#
# Los tres pasos hacen falta: si solo se hace el 1, el sistema operativo sigue
# viendo el tamano viejo.
#
# Ojo: un volumen solo admite UNA modificacion cada 6 horas. Y el disco solo
# crece, nunca se reduce; para bajar de tamano hay que recrear la instancia.
#
# Despues de escalar hay que dejar el mismo numero en infra/lib/app-stack.ts
# (blockDevices -> BlockDeviceVolume.ebs). Si no, el dia que CloudFormation
# reemplace la instancia volveria a crearla con el tamano viejo.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\ebs-escalar.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\ebs-escalar.ps1 -Size 50

param(
  [int]$Size = 0,
  [string]$Region = 'us-east-1',
  [string]$InstanceTag = 'courier-api'
)

$ErrorActionPreference = 'Stop'

function Invoke-EnLaInstancia {
  param([string]$InstanceId, [string]$Comando, [int]$Intentos = 30)

  # El JSON va por fichero: PowerShell 5.1 destroza las comillas dobles cuando
  # se pasan en linea a un ejecutable nativo, y el script remoto lleva saltos
  # de linea. WriteAllText escribe UTF-8 sin BOM, que es lo que el CLI acepta.
  $payload = @{ commands = @($Comando) } | ConvertTo-Json -Compress
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $payload, (New-Object System.Text.UTF8Encoding($false)))

  try {
    $commandId = aws ssm send-command --region $Region `
      --instance-ids $InstanceId `
      --document-name AWS-RunShellScript `
      --parameters "file://$tmp" `
      --timeout-seconds 600 `
      --query 'Command.CommandId' --output text
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }

  $status = 'Pending'
  for ($i = 0; $i -lt $Intentos; $i++) {
    Start-Sleep -Seconds 5
    $status = aws ssm get-command-invocation --region $Region `
      --command-id $commandId --instance-id $InstanceId `
      --query 'Status' --output text 2>$null
    if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
  }

  $salida = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $InstanceId `
    --query 'StandardOutputContent' --output text
  if ($status -ne 'Success') {
    $err = aws ssm get-command-invocation --region $Region `
      --command-id $commandId --instance-id $InstanceId `
      --query 'StandardErrorContent' --output text
    Write-Host $salida
    Write-Host $err
    Write-Error "El comando remoto termino en estado $status"
    exit 1
  }
  return $salida
}

Write-Host "Buscando la instancia '$InstanceTag' en $Region..."
$instance = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=$InstanceTag" "Name=instance-state-name,Values=running" `
  --query "Reservations[].Instances[].InstanceId" --output text

if (-not $instance -or $instance -eq 'None') {
  Write-Error "No hay ninguna instancia '$InstanceTag' en marcha. Revisa el perfil de AWS y la region."
  exit 1
}

$volumen = aws ec2 describe-volumes --region $Region `
  --filters "Name=attachment.instance-id,Values=$instance" `
  --query "Volumes[0].[VolumeId,Size,VolumeType,Iops,Throughput]" --output text
$campos = $volumen -split "\s+"
$volumeId = $campos[0]
$tamanoActual = [int]$campos[1]

Write-Host ''
Write-Host "Instancia : $instance"
Write-Host "Volumen   : $volumeId"
Write-Host "Tamano    : $tamanoActual GiB ($($campos[2]), $($campos[3]) IOPS, $($campos[4]) MB/s)"
Write-Host ''
Write-Host 'Uso real del disco:'
Invoke-EnLaInstancia -InstanceId $instance -Comando 'df -h /; echo; echo "Docker:"; docker system df 2>/dev/null || true'

if ($Size -le 0) {
  Write-Host ''
  Write-Host "Para escalarlo:  .\infra\scripts\ebs-escalar.ps1 -Size $($tamanoActual + 20)"
  exit 0
}

if ($Size -le $tamanoActual) {
  Write-Error "El disco ya tiene $tamanoActual GiB. Un EBS solo puede crecer, no encoger."
  exit 1
}

Write-Host ''
Write-Host "Agrandando $volumeId de $tamanoActual a $Size GiB..."
aws ec2 modify-volume --region $Region --volume-id $volumeId --size $Size `
  --query 'VolumeModification.ModificationState' --output text | Out-Null

# El volumen es usable en cuanto pasa a 'optimizing'; 'completed' puede tardar
# horas en discos grandes y no hace falta esperarlo para redimensionar.
$estado = 'modifying'
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  $estado = aws ec2 describe-volumes-modifications --region $Region --volume-id $volumeId `
    --query 'VolumesModifications[0].ModificationState' --output text
  Write-Host "  ...$estado"
  if ($estado -in @('optimizing', 'completed')) { break }
  if ($estado -eq 'failed') { Write-Error 'AWS rechazo la modificacion del volumen.'; exit 1 }
}

Write-Host ''
Write-Host 'Agrandando particion y sistema de ficheros dentro de la instancia...'
$remoto = @'
set -e
root=$(findmnt -no SOURCE /)
disco=$(lsblk -no PKNAME "$root")
particion=$(echo "$root" | grep -o "[0-9]*$")
growpart "/dev/$disco" "$particion" || true
if [ "$(findmnt -no FSTYPE /)" = "xfs" ]; then xfs_growfs -d /; else resize2fs "$root"; fi
echo
df -h /
'@
Invoke-EnLaInstancia -InstanceId $instance -Comando $remoto

Write-Host ''
Write-Host "Listo. El disco quedo en $Size GiB."
Write-Host 'Falta un paso manual: pon el mismo numero en infra/lib/app-stack.ts'
Write-Host "  blockDevices -> ec2.BlockDeviceVolume.ebs($Size, { ... })"
Write-Host 'para que una instancia nueva nazca ya con ese tamano.'
