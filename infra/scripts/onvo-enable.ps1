# Carga las credenciales de Onvo Pay y enciende el cobro con tarjeta.
#
# Onvo es la pasarela: sin esto el cliente paga por deposito bancario, que es un
# flujo completo y no depende de terceros. O sea que apagado no se pierde ninguna
# funcion esencial, pero el cobro con tarjeta no existe.
#
# NINGUN SECRETO VIVE EN ESTE ARCHIVO. Las tres llaves se piden por consola sin
# mostrarlas, o se leen de apps/api/.env con -DesdeEnv (ese archivo esta en el
# .gitignore). Asi no quedan ni en el repositorio ni en el historial de
# PowerShell.
#
# QUE ENTORNO SE TOCA lo decide el PREFIJO DE LA LLAVE, no el modo ni la URL:
# una llave onvo_test_* no toca la red bancaria real; una onvo_live_* cobra de
# verdad. La URL base es la misma para los dos entornos.
#
# EL SECRETO DEL WEBHOOK TIENE QUE SER EL DE LA URL REGISTRADA. Onvo lo manda tal
# cual en la cabecera X-Webhook-Secret; es lo unico que distingue un cobro real de
# un POST falso, y si no coincide, la API responde 401 y NINGUN pago con tarjeta
# se confirma nunca. La URL de callback que hay que tener registrada en el
# dashboard (Developers) es:
#
#   https://www.hsglobal-services.com/api/payments/webhook/onvo
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\onvo-enable.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\onvo-enable.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\onvo-enable.ps1 -DesdeEnv
#
# Con -DesdeEnv las llaves se leen de apps/api/.env (ONVO_PUBLIC_KEY,
# ONVO_SECRET_KEY, ONVO_WEBHOOK_SECRET) y no se pregunta nada. Lo que falte alli
# se sigue pidiendo por consola.

param(
  [string]$BaseUrl = 'https://api.onvopay.com/v1',
  # Ensena lo que haria y se va, sin escribir en Parameter Store.
  [switch]$DryRun,
  # Lee las llaves de apps/api/.env en vez de pedirlas por consola.
  [switch]$DesdeEnv,
  [string]$EnvFile = '',
  # Solo carga las credenciales y NO toca ONVO_MODE. Sirve para rotar llaves sin
  # arriesgarse a encender la pasarela si estaba apagada a proposito.
  [switch]$SoloCredenciales
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Path = '/courier/prod'

# Valores del .env local, solo con -DesdeEnv. Se parsea a mano (NOMBRE=valor, sin
# comillas ni expansiones) porque es lo unico que usa ese archivo.
$EnvValues = @{}
if ($DesdeEnv) {
  if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot '../../apps/api/.env' }
  if (-not (Test-Path $EnvFile)) {
    Write-Error "No existe $EnvFile"
    exit 1
  }
  foreach ($linea in Get-Content $EnvFile) {
    $l = $linea.Trim()
    if (-not $l -or $l.StartsWith('#')) { continue }
    $idx = $l.IndexOf('=')
    if ($idx -lt 1) { continue }
    $EnvValues[$l.Substring(0, $idx).Trim()] = $l.Substring($idx + 1).Trim()
  }
  Write-Host "Llaves leidas de $EnvFile" -ForegroundColor DarkGray
}

# Con -DesdeEnv devuelve el valor del .env si existe; si no, pregunta.
function Read-Secret($etiqueta, $clave = '') {
  if ($DesdeEnv -and $clave -and $EnvValues.ContainsKey($clave) -and $EnvValues[$clave]) {
    Write-Host "  $clave tomada del .env" -ForegroundColor DarkGray
    return $EnvValues[$clave]
  }
  $seguro = Read-Host -Prompt $etiqueta -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Set-Secret($nombre, $valor) {
  # El valor viaja en un archivo temporal (file://) y no en la linea de comandos:
  # PowerShell, al invocar un ejecutable nativo, le quita las comillas dobles al
  # argumento, y las llaves de Onvo llevan guiones y guiones bajos que conviene no
  # dejar a merced del parser. El archivo se borra al terminar, exista o no error.
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmp, $valor, (New-Object System.Text.UTF8Encoding($false)))
    $uri = 'file://' + $tmp.Replace([char]92, '/')
    aws ssm put-parameter --region $Region --name "$Path/$nombre" `
      --value $uri --type SecureString --overwrite --output text | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo escribir $nombre" }
  }
  finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
  Write-Host "  $nombre cargada" -ForegroundColor Green
}

function Set-Plain($nombre, $valor) {
  aws ssm put-parameter --region $Region --name "$Path/$nombre" `
    --value $valor --type String --overwrite --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "No se pudo escribir $nombre" }
  Write-Host "  $nombre = $valor" -ForegroundColor Green
}

# Solo para el resumen: ensena el prefijo y la cola, nunca el cuerpo de la llave.
function Show-Masked($nombre, $valor) {
  $cola = ''
  if ($valor.Length -gt 6) { $cola = $valor.Substring($valor.Length - 4) }
  $prefijo = $valor
  $corte = $valor.LastIndexOf('key_')
  if ($corte -ge 0) { $prefijo = $valor.Substring(0, $corte + 4) }
  elseif ($valor.Length -gt 12) { $prefijo = $valor.Substring(0, 12) }
  Write-Host ("  {0,-21} {1}...{2}  ({3} caracteres)" -f $nombre, $prefijo, $cola, $valor.Length)
}

Write-Host 'Configuracion:' -ForegroundColor Cyan
Write-Host "  ONVO_BASE_URL = $BaseUrl"
Write-Host "  Region        = $Region"
Write-Host "  Ruta SSM      = $Path"
Write-Host ''

$publicKey = Read-Secret 'ONVO_PUBLIC_KEY' 'ONVO_PUBLIC_KEY'
$secretKey = Read-Secret 'ONVO_SECRET_KEY' 'ONVO_SECRET_KEY'
$webhook = Read-Secret 'ONVO_WEBHOOK_SECRET' 'ONVO_WEBHOOK_SECRET'

# Las tres son obligatorias con ONVO_MODE=on: si falta alguna, la API NO ARRANCA
# (core/config.ts). Mejor pararlo aqui que dejar el servicio caido.
foreach ($par in @(@('ONVO_PUBLIC_KEY', $publicKey), @('ONVO_SECRET_KEY', $secretKey), @('ONVO_WEBHOOK_SECRET', $webhook))) {
  if (-not $par[1]) {
    Write-Error "$($par[0]) es obligatoria con ONVO_MODE=on. Sin ella la API no arranca."
    exit 1
  }
}

# Avisos de prefijo. No se aborta: los prefijos son del proveedor y podrian
# cambiar, pero una llave pegada en el campo equivocado es el error tipico y este
# es el ultimo momento para verlo.
if ($publicKey -notmatch 'publishable_key_') {
  Write-Host 'AVISO: ONVO_PUBLIC_KEY no parece una llave publicable (falta publishable_key_).' -ForegroundColor Yellow
}
if ($secretKey -notmatch 'secret_key_') {
  Write-Host 'AVISO: ONVO_SECRET_KEY no parece una llave secreta (falta secret_key_).' -ForegroundColor Yellow
}
if ($webhook -notmatch '^webhook_secret_') {
  Write-Host 'AVISO: ONVO_WEBHOOK_SECRET no empieza por webhook_secret_.' -ForegroundColor Yellow
}

$esLive = $publicKey -match 'onvo_live_' -or $secretKey -match 'onvo_live_'

Write-Host ''
Write-Host 'Llaves a cargar:' -ForegroundColor Cyan
Show-Masked 'ONVO_PUBLIC_KEY' $publicKey
Show-Masked 'ONVO_SECRET_KEY' $secretKey
Show-Masked 'ONVO_WEBHOOK_SECRET' $webhook
Write-Host ''
if ($esLive) {
  Write-Host 'Son llaves LIVE: a partir del reinicio se cobran tarjetas DE VERDAD.' -ForegroundColor Yellow
}
else {
  Write-Host 'Son llaves de prueba: no tocan la red bancaria real.' -ForegroundColor DarkGray
}

if ($DryRun) {
  Write-Host ''
  Write-Host 'DryRun: no se escribe nada. Vuelve a lanzarlo sin -DryRun cuando cuadre.' -ForegroundColor Yellow
  exit 0
}

Write-Host ''
Write-Host 'Escribiendo en Parameter Store...' -ForegroundColor Cyan
Set-Secret 'ONVO_BASE_URL' $BaseUrl
Set-Secret 'ONVO_PUBLIC_KEY' $publicKey
Set-Secret 'ONVO_SECRET_KEY' $secretKey
Set-Secret 'ONVO_WEBHOOK_SECRET' $webhook

# El interruptor va AL FINAL, cuando las credenciales ya estan: con ONVO_MODE=on y
# una credencial obligatoria ausente, la API no arranca. Es deliberado, pero aqui
# el orden lo evita.
#
# Nunca `simulated` en produccion: la API se niega a arrancar (config.ts), porque
# la pasarela simulada deja que el propio cliente apruebe su cobro.
#
# OJO: ONVO_MODE tambien esta en infra/lib/app-stack.ts, y ESO es lo que manda. Lo
# de aqui es para no tener que desplegar el stack; si alli dijera otra cosa, el
# siguiente `cdk deploy` lo devolveria a ese valor.
if ($SoloCredenciales) {
  Write-Host ''
  Write-Host '-SoloCredenciales: no se toca ONVO_MODE.' -ForegroundColor DarkGray
}
else {
  Write-Host ''
  Write-Host 'Encendiendo la pasarela...' -ForegroundColor Cyan
  Set-Plain 'ONVO_MODE' 'on'
}

# El contenedor no relee SSM por su cuenta: hasta que no se regenere
# /opt/courier/api.env y se reinicie el servicio, sigue con las llaves viejas.
Write-Host ''
Write-Host 'Reiniciando la API para que lea la configuracion nueva...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'reload-api-env.ps1')

Write-Host ''
Write-Host 'Comprobaciones:' -ForegroundColor Cyan
Write-Host '  1. La API tiene que responder. Si no responde, falta una credencial y el'
Write-Host '     motivo esta en el log con el nombre de la variable:'
Write-Host "       aws logs tail $Path/api --region $Region --since 5m"
Write-Host '  2. En el dashboard de Onvo, la URL de callback tiene que ser'
Write-Host '     https://www.hsglobal-services.com/api/payments/webhook/onvo'
Write-Host '     y su secreto el mismo que se acaba de cargar.'
Write-Host '  3. Haz un pago con tarjeta y mira el webhook en vivo:'
Write-Host "       aws logs tail $Path/api --region $Region --follow --since 1m"
Write-Host '     La linea del webhook tiene que responder 200, no 401. Un 401 significa'
Write-Host '     que el secreto cargado no es el de la URL registrada.'
if ($esLive) {
  Write-Host '  4. Con llaves LIVE el pago de prueba es un cobro real: usa un monto minimo'
  Write-Host '     y devuelvelo desde el dashboard de Onvo.'
}
