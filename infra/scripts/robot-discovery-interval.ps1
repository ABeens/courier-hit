# Cambia cada cuanto corre el descubrimiento de paquetes de Helga (helga-discovery)
# en produccion y recarga la API para que el cambio aplique.
#
# Por que importa: la op. E solo lista paquetes en DIGITADO. Lo que Helga pase a
# AGRUPADA entre dos corridas no se vuelve a ver y toca cargarlo a mano, asi que
# este intervalo tiene que ser mas corto que ese salto.
#
# Costo: cada corrida hace una llamada por cuenta de Helga (paginas de 100), y
# comparte el cupo de 55 por minuto con el resto del robot y con las personas.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\robot-discovery-interval.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\robot-discovery-interval.ps1 -Every 3m
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\robot-discovery-interval.ps1 -SinRecargar

param(
  # Duracion legible: "2m", "90s", "15m".
  [string]$Every = '2m',
  # Solo escribe en SSM; el cambio aplicara en el proximo despliegue.
  [switch]$SinRecargar
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Name = '/courier/prod/ROBOT_PACKAGE_DISCOVERY_EVERY'

if ($Every -notmatch '^(\d+[smhd])+$') {
  Write-Error "Duracion invalida: '$Every'. Usa algo como 2m, 90s o 15m."
  exit 1
}

$actual = aws ssm get-parameters --region $Region --names $Name --query 'Parameters[0].Value' --output text
if ($LASTEXITCODE -ne 0) {
  Write-Error 'No se pudo leer SSM. Revisa la sesion de AWS (aws login).'
  exit 1
}
if ($actual -eq 'None') { $actual = '(no existe; la API usa el default del codigo)' }
Write-Host "Valor actual: $actual"

aws ssm put-parameter --region $Region --name $Name --value $Every --type String --overwrite | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error 'No se pudo escribir el parametro en SSM.'
  exit 1
}
Write-Host "Nuevo valor: $Every"

if ($SinRecargar) {
  Write-Host 'Sin recargar: aplicara en el proximo despliegue.'
  exit 0
}

& (Join-Path $PSScriptRoot 'reload-api-env.ps1')
