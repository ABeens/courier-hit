# Carga las credenciales de Helga y enciende la integracion.
#
# Helga es el casillero de Miami: sin esto no hay casilleros enlazados ni
# prealertas, o sea que el negocio no opera. Es la integracion mas critica.
#
# HS Global opera VARIAS cuentas de casillero, cada una con su propio login. Van
# todas juntas en `HELGA_ACCOUNTS`, un JSON cifrado, y **la primera es la
# principal**: es bajo la que hoy cuelgan todos los destinatarios. El orden es el
# contrato, no un detalle de presentacion.
#
# La lista blanca de IP con el proveedor YA ESTA CONFIRMADA (30-ago-2026): la
# Elastic IP 54.88.91.248 esta registrada con ellos. Queda anotado porque es el
# primer sospechoso si algun dia todo empieza a responder 403 y los casilleros
# caen en `failed`: esa IP tiene politica de retencion y sobrevive a que se
# recree la instancia, asi que solo cambiaria si se destruye el stack base.
#
# NINGUN SECRETO VIVE EN ESTE ARCHIVO. Las contrasenas, el client secret y el
# app id se piden por consola sin mostrarlos, para que no queden ni en el
# repositorio ni en el historial de PowerShell. Lo que si esta aqui son los
# codigos de casillero, los nombres y los correos de login, que no son secretos.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-enable.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-enable.ps1
#
# Si alguna cuenta cambia de contrasena o abren un casillero nuevo, se edita la
# tabla $Cuentas de abajo y se vuelve a lanzar: reescribe la lista entera.

param(
  [string]$BaseUrl = 'https://lmexpress.helgasys.com',
  [string]$ClientId = '11',
  # Helga valida la cabecera Origin; por defecto es el mismo host que la API.
  [string]$Origin = '',
  # Enseña lo que haria y se va, sin escribir en Parameter Store.
  [switch]$DryRun,
  # Todas las cuentas comparten contrasena hoy. Con este switch se pide una por
  # cuenta, para el dia que dejen de compartirla.
  [switch]$PasswordPorCuenta
)

$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Path = '/courier/prod'

if (-not $Origin) { $Origin = $BaseUrl }

# Las cuentas, EN ORDEN. La primera es la principal.
#
# `clientId` es el `datos.id` de esa cuenta en el proveedor (el `cliente_id` bajo
# el que cuelgan sus destinatarios). Solo se conoce el de SJO008835, resuelto en
# vivo el 2026-07-20 contra GET /api/casillero/clientes. Las demas van en $null
# hasta que se resuelva el suyo; mientras tanto no pueden dar de alta
# destinatarios, que hoy da igual porque solo opera la principal.
$Cuentas = @(
  @{ code = 'SJO008835'; name = 'HS GLOBAL'; username = 'servicioalcliente1@hsglobal-services.com'; clientId = 7536 },
  @{ code = 'SJO009623'; name = 'ZUCA'; username = 'servicioalcliente2@hsglobal-services.com'; clientId = $null },
  @{ code = 'SJO00609300'; name = 'ZUCA ZF'; username = 'zucazf@hsglobal-services.com'; clientId = $null },
  @{ code = 'SJO009805'; name = 'ACTIVE SHOP'; username = 'activeshop@hsglobal-services.com'; clientId = $null },
  @{ code = 'SJO608891'; name = 'ALFA LOGISTICS'; username = 'alfa@hsglobal-services.com'; clientId = $null },
  @{ code = 'SJO609776'; name = 'ADUANERA HC'; username = 'aherrera@hsglobal-services.com'; clientId = $null }
)

function Read-Secret($etiqueta) {
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
  aws ssm put-parameter --region $Region --name "$Path/$nombre" `
    --value $valor --type SecureString --overwrite --output text | Out-Null
  Write-Host "  $nombre cargada" -ForegroundColor Green
}

function Set-Plain($nombre, $valor) {
  aws ssm put-parameter --region $Region --name "$Path/$nombre" `
    --value $valor --type String --overwrite --output text | Out-Null
  Write-Host "  $nombre = $valor" -ForegroundColor Green
}

Write-Host 'Configuracion comun:' -ForegroundColor Cyan
Write-Host "  HELGA_BASE_URL  = $BaseUrl"
Write-Host "  HELGA_CLIENT_ID = $ClientId"
Write-Host "  HELGA_ORIGIN    = $Origin"
Write-Host ''
Write-Host "Cuentas ($($Cuentas.Count)), la primera es la principal:" -ForegroundColor Cyan
$i = 0
foreach ($c in $Cuentas) {
  $i++
  $marca = '  '
  if ($i -eq 1) { $marca = '->' }
  $idTexto = 'cliente_id pendiente'
  if ($null -ne $c.clientId) { $idTexto = "cliente_id $($c.clientId)" }
  Write-Host ("$marca {0,-12} {1,-16} {2,-45} {3}" -f $c.code, $c.name, $c.username, $idTexto)
}
Write-Host ''

if ($DryRun) {
  Write-Host 'DryRun: no se escribe nada. Vuelve a lanzarlo sin -DryRun cuando cuadre.' -ForegroundColor Yellow
  exit 0
}

$clientSecret = Read-Secret 'HELGA_CLIENT_SECRET'
$appId = Read-Secret 'HELGA_APP_ID (Enter para omitirlo)'

if (-not $clientSecret) {
  Write-Error 'HELGA_CLIENT_SECRET es obligatorio con HELGA_MODE=on. Sin el, la API no arranca.'
  exit 1
}

$comun = $null
if (-not $PasswordPorCuenta) {
  $comun = Read-Secret 'Contrasena comun de las cuentas'
  if (-not $comun) {
    Write-Error 'La contrasena es obligatoria. Con -PasswordPorCuenta se pide una por cuenta.'
    exit 1
  }
}

$lista = @()
foreach ($c in $Cuentas) {
  $clave = $comun
  if ($PasswordPorCuenta) { $clave = Read-Secret "Contrasena de $($c.code) ($($c.name))" }
  if (-not $clave) {
    Write-Error "Falta la contrasena de $($c.code)."
    exit 1
  }
  $lista += [ordered]@{
    code     = $c.code
    name     = $c.name
    username = $c.username
    password = $clave
    clientId = $c.clientId
  }
}

# -Compress no es cosmetica y tiene dos motivos, el segundo grave:
#   1. cabe holgado en el limite de 4 KB de un parametro estandar;
#   2. el arranque de la instancia vuelca cada parametro como una linea
#      `NOMBRE=valor` en /opt/courier/api.env, que el contenedor lee con
#      --env-file. Ese formato es de UNA LINEA por variable: un JSON indentado
#      partiria la variable a la primera linea y la API arrancaria con la lista
#      truncada.
$json = $lista | ConvertTo-Json -Compress -Depth 4

Write-Host ''
Write-Host 'Escribiendo en Parameter Store...' -ForegroundColor Cyan
Set-Plain 'HELGA_BASE_URL' $BaseUrl
Set-Plain 'HELGA_CLIENT_ID' $ClientId
Set-Plain 'HELGA_ORIGIN' $Origin
Set-Secret 'HELGA_CLIENT_SECRET' $clientSecret
if ($appId) { Set-Secret 'HELGA_APP_ID' $appId }
Set-Secret 'HELGA_ACCOUNTS' $json
Write-Host "  HELGA_ACCOUNTS lleva $($lista.Count) cuentas, principal $($lista[0].code)."

# El interruptor va AL FINAL, cuando las credenciales ya estan: con HELGA_MODE=on
# y una credencial obligatoria ausente, la API no arranca. Es deliberado, pero
# aqui el orden lo evita.
#
# Nunca `simulated` en produccion: daria por enlazados casilleros que Helga no
# conoce y por prealertados paquetes que nadie espera en Miami.
Write-Host ''
Write-Host 'Encendiendo la integracion...' -ForegroundColor Cyan
Set-Plain 'HELGA_MODE' 'on'

Write-Host ''
Write-Host 'Reiniciando la API para que lea la configuracion nueva...' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'reload-api-env.ps1')

Write-Host ''
Write-Host 'Comprobaciones:' -ForegroundColor Cyan
Write-Host '  1. La API tiene que responder. Si no responde, falta una credencial y el'
Write-Host '     motivo esta en el log con el nombre de la variable:'
Write-Host "       aws logs tail $Path/api --region $Region --since 5m"
Write-Host '  2. En el arranque, el log dice cuantas cuentas cargo y cual es la principal.'
Write-Host '  3. Registra un cliente de prueba y mira que su casillero quede en `synced`.'
Write-Host '     Si queda en `failed`, el motivo esta en el log.'
Write-Host ''
Write-Host 'Cuando Helga responda bien, el siguiente paso es el robot:' -ForegroundColor Cyan
Write-Host "  aws ssm put-parameter --region $Region --name $Path/ROBOT_ENABLED --value true --type String --overwrite"
Write-Host '  y volver a lanzar reload-api-env.ps1'
