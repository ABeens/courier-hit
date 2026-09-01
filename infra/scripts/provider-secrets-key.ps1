# Carga en Parameter Store la clave con la que se cifran las credenciales de las
# cuentas EXCLUSIVAS del operador de Miami (docs/13 §6).
#
# POR QUE ES UN PASO APARTE. La instancia arma su fichero de entorno leyendo
# `/courier/prod` entero (`get-parameters-by-path --recursive`), asi que un
# parametro nuevo se convierte solo en variable de entorno. Lo que NO puede hacer
# el despliegue es inventarse el valor: la clave se genera una vez, se guarda
# cifrada, y a partir de ahi es la unica que puede leer lo que se guardo con ella.
#
# NO SE ROTA A LA LIGERA. Cambiarla deja ILEGIBLES las credenciales de todas las
# cuentas ya registradas: habria que volver a capturar la contrasena de cada una
# desde la pantalla. Por eso, si el parametro ya existe, este script se niega a
# pisarlo salvo que se lo pidas con -Force.
#
# Despues de correrlo hay que DESPLEGAR (o recargar el entorno): el contenedor no
# relee Parameter Store por su cuenta.
#
#   bash infra/scripts/deploy-local.sh api      (imagen nueva + migraciones)
#   powershell -File infra/scripts/reload-api-env.ps1   (solo recargar el entorno)
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\provider-secrets-key.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\provider-secrets-key.ps1

param(
  # Enseña lo que haria y se va, sin escribir en Parameter Store.
  [switch]$DryRun,
  # Sobreescribe una clave existente. Ver la advertencia de arriba.
  [switch]$Force,
  # Ademas de la clave, deja MIAMI_LINK_ENABLED en true (es la bandera de la que
  # cuelgan las dos pantallas del operador).
  [switch]$ConPantalla
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Path = '/courier/prod'
$Nombre = 'PROVIDER_SECRETS_KEY'

function Test-Session {
  aws sts get-caller-identity --output text 2>$null | Out-Null
  if (-not $?) { throw "Sesion de AWS expirada o sin credenciales. Ejecuta 'aws login' y repite." }
}

Test-Session

# --- ¿Ya existe? ------------------------------------------------------------

$existe = $false
try {
  aws ssm get-parameter --region $Region --name "$Path/$Nombre" --output text 2>$null | Out-Null
  $existe = $?
}
catch { $existe = $false }

if ($existe -and -not $Force) {
  Write-Host "Ya hay una clave en $Path/$Nombre." -ForegroundColor Yellow
  Write-Host 'NO se toca: cambiarla dejaria ilegibles las credenciales ya guardadas de cada cuenta.'
  Write-Host 'Si de verdad hay que rotarla, vuelve a lanzar con -Force y prepárate para volver a'
  Write-Host 'capturar la contrasena de cada cuenta desde la pantalla.'
  if (-not $ConPantalla) { exit 0 }
}
else {
  # 32 bytes aleatorios en base64: es lo que espera core/secrets.ts (AES-256-GCM).
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $clave = [Convert]::ToBase64String($bytes)

  if ($DryRun) {
    Write-Host "[DryRun] Se escribiria $Path/$Nombre como SecureString (32 bytes en base64)."
  }
  else {
    aws ssm put-parameter --region $Region --name "$Path/$Nombre" `
      --value $clave --type SecureString --overwrite --output text | Out-Null
    if (-not $?) { throw "No se pudo escribir $Path/$Nombre." }
    Write-Host "$Nombre cargada en Parameter Store." -ForegroundColor Green
    # El valor NO se imprime: no hace falta en ningun sitio. Vive cifrado en SSM
    # y la instancia lo descifra al armar su fichero de entorno.
  }
}

# --- La bandera de la pantalla ----------------------------------------------

if ($ConPantalla) {
  if ($DryRun) {
    Write-Host "[DryRun] Se escribiria $Path/MIAMI_LINK_ENABLED = true."
  }
  else {
    aws ssm put-parameter --region $Region --name "$Path/MIAMI_LINK_ENABLED" `
      --value 'true' --type String --overwrite --output text | Out-Null
    if (-not $?) { throw "No se pudo escribir $Path/MIAMI_LINK_ENABLED." }
    Write-Host 'MIAMI_LINK_ENABLED = true' -ForegroundColor Green
  }
}

Write-Host ''
Write-Host 'Siguiente paso: desplegar, que es lo que regenera el entorno y aplica las migraciones.' -ForegroundColor Cyan
Write-Host '  bash infra/scripts/deploy-local.sh all'
