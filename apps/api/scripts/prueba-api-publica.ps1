# Prueba de humo de la API publica para clientes (docs/16-api-publica.md).
#
# Que comprueba: el ciclo entero de una integracion contra la API local, de
# principio a fin y en el orden en que lo vive un cliente real.
#
#   1. Emite una llave desde el portal (con sesion, como haria el cliente).
#   2. Ejerce las cinco operaciones de /api/v1 con esa llave.
#   3. Comprueba los "no": sin llave, llave inventada, casillero ajeno,
#      tracking que no existe, tracking repetido, cuerpo invalido; y las formas
#      de mandar la llave que documenta la pagina (Bearer, x-api-key, y las que
#      no valen: sin Bearer, en la URL, con comillas).
#   4. Comprueba que las dos puertas son excluyentes: la cookie no abre
#      /api/v1 y la llave no abre el portal.
#   5. Rota la llave y verifica que la vieja deja de servir en el acto.
#   6. Revoca la que queda y verifica lo mismo.
#
# Con -ConLimite agrega la prueba del limitador: dispara hasta agotar el cupo y
# comprueba que el 429 llega con Retry-After. Va detras de un interruptor porque
# son ~125 peticiones y deja esa llave sin cupo durante lo que queda del minuto.
#
# Antes de correrlo hace falta la API en marcha y la base sembrada:
#
#   pnpm install
#   pnpm --filter @courier/api db:migrate
#   pnpm --filter @courier/api db:seed        # tarifas y primer admin
#   pnpm --filter @courier/api db:seed:demo   # clientes y paquetes de demo
#   pnpm --filter @courier/api dev            # dejar corriendo en otra consola
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\apps\api\scripts\prueba-api-publica.ps1
#       ... -ConLimite          para probar tambien el limitador
#       ... -Email otro@correo  para usar otro casillero
#
# OJO: deja UN paquete prealertado de prueba en el casillero que use (con
# tracking SMOKE-<fecha>). Se limpia resembrando la demo:
#   pnpm --filter @courier/api db:seed:demo -- --reset

[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:3001',
  [string]$Email = 'laura.jimenez@demo.hsglobal.ltd',
  [string]$Password = 'Demo1234!',
  [switch]$ConLimite
)

$ErrorActionPreference = 'Stop'

$script:ok = 0
$script:fallos = 0

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

# Llama a la API y devuelve SIEMPRE un objeto, tambien cuando responde 4xx o
# 5xx. Invoke-WebRequest lanza excepcion con cualquier codigo que no sea 2xx, y
# aqui la mitad de las comprobaciones SON errores esperados: sin esto, el script
# se caeria justo en los casos que quiere verificar.
function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [Parameter(Mandatory = $true)][string]$Path,
    $Body,
    [hashtable]$Headers = @{},
    $Session
  )

  $params = @{
    Uri             = "$BaseUrl$Path"
    Method          = $Method
    Headers         = $Headers
    UseBasicParsing = $true
    ErrorAction     = 'Stop'
  }
  if ($Session) { $params.WebSession = $Session }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 5 -Compress)
    $params.ContentType = 'application/json'
  }

  try {
    $res = Invoke-WebRequest @params
    $parsed = $null
    if ($res.Content) { try { $parsed = $res.Content | ConvertFrom-Json } catch {} }
    return [pscustomobject]@{
      Status  = [int]$res.StatusCode
      Body    = $parsed
      Raw     = $res.Content
      Headers = $res.Headers
    }
  }
  catch {
    $response = $_.Exception.Response
    # Sin respuesta no hay nada que interpretar: es que no se llego al servidor.
    if ($null -eq $response) { throw }

    # El cuerpo del error se saca de ErrorDetails y NO del stream de la
    # respuesta: en Windows PowerShell 5.1, Invoke-WebRequest ya lo ha leido
    # para armar la excepcion, asi que el stream llega al final y ReadToEnd
    # devuelve cadena vacia. El stream queda como respaldo por si algun dia
    # esto corre en PowerShell 7, donde ErrorDetails puede venir vacio.
    $texto = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $texto = $_.ErrorDetails.Message
    }
    else {
      $stream = $response.GetResponseStream()
      if ($stream) {
        $lector = New-Object System.IO.StreamReader($stream)
        $texto = $lector.ReadToEnd()
        $lector.Close()
      }
    }
    $parsed = $null
    if ($texto) { try { $parsed = $texto | ConvertFrom-Json } catch {} }

    return [pscustomobject]@{
      Status  = [int]$response.StatusCode
      Body    = $parsed
      Raw     = $texto
      Headers = $response.Headers
    }
  }
}

# Compara el codigo obtenido con el esperado y lleva la cuenta. Se comprueba el
# CODIGO y no el mensaje: el codigo es la parte estable del contrato de errores.
function Paso {
  param(
    [string]$Titulo,
    [int]$Esperado,
    $Respuesta,
    [string]$Detalle = ''
  )

  if ($Respuesta.Status -eq $Esperado) {
    $script:ok++
    Write-Host ("  OK    [{0}] {1}" -f $Respuesta.Status, $Titulo) -ForegroundColor Green
    if ($Detalle) { Write-Host ("            {0}" -f $Detalle) -ForegroundColor DarkGray }
  }
  else {
    $script:fallos++
    Write-Host ("  FALLO [esperaba {0}, dio {1}] {2}" -f $Esperado, $Respuesta.Status, $Titulo) -ForegroundColor Red
    if ($Respuesta.Raw) { Write-Host ("            {0}" -f $Respuesta.Raw) -ForegroundColor DarkGray }
  }
}

# Codigo de error del contrato { error: { code, message } }, o cadena vacia.
function CodigoDe($Respuesta) {
  if ($Respuesta.Body -and $Respuesta.Body.error) { return $Respuesta.Body.error.code }
  return ''
}

function Titulo([string]$Texto) {
  Write-Host ''
  Write-Host $Texto -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 0. La API tiene que estar en marcha
# ---------------------------------------------------------------------------

Write-Host "Probando la API publica en $BaseUrl" -ForegroundColor White
try {
  $salud = Invoke-Api -Path '/api/health'
  if ($salud.Status -ne 200) { throw 'sonda de salud sin 200' }
}
catch {
  Write-Host ''
  Write-Host "No hay ninguna API respondiendo en $BaseUrl." -ForegroundColor Red
  Write-Host 'Arrancala en otra consola y vuelve a lanzar este script:'
  Write-Host '  pnpm --filter @courier/api dev'
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Sesion del cliente y emision de la llave
# ---------------------------------------------------------------------------

Titulo '1. Portal: iniciar sesion y emitir la llave'

try {
  $login = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method POST `
    -Body (@{ email = $Email; password = $Password } | ConvertTo-Json -Compress) `
    -ContentType 'application/json' -SessionVariable sesion -UseBasicParsing -ErrorAction Stop
}
catch {
  Write-Host ''
  Write-Host "No se pudo entrar como $Email." -ForegroundColor Red
  Write-Host 'Si la base no tiene los datos de demo, siembralos:'
  Write-Host '  pnpm --filter @courier/api db:seed'
  Write-Host '  pnpm --filter @courier/api db:seed:demo'
  exit 1
}

$cuenta = $login.Content | ConvertFrom-Json
Write-Host ("  Casillero {0} ({1})" -f $cuenta.clientCode, $cuenta.role) -ForegroundColor DarkGray

$creada = Invoke-Api -Method POST -Path '/api/api-keys' -Session $sesion -Body @{ name = 'Prueba de humo' }
Paso 'POST /api/api-keys emite una llave' 201 $creada
if ($creada.Status -ne 201) {
  Write-Host 'Sin llave no se puede seguir.' -ForegroundColor Red
  exit 1
}

$token = $creada.Body.token
$llaveId = $creada.Body.id
Write-Host ("            entorno={0}  vista previa={1}" -f $creada.Body.environment, $creada.Body.preview) -ForegroundColor DarkGray

# El token completo se devuelve UNA vez. Que el listado no lo traiga es parte de
# lo que hay que verificar, no un detalle de presentacion.
$listado = Invoke-Api -Path '/api/api-keys' -Session $sesion
$traeToken = $false
foreach ($k in $listado.Body.items) { if ($k.PSObject.Properties.Name -contains 'token') { $traeToken = $true } }
if ($traeToken) {
  $script:fallos++
  Write-Host '  FALLO el listado de llaves devuelve el token completo' -ForegroundColor Red
}
else {
  $script:ok++
  Write-Host '  OK    el listado nunca devuelve el token, solo la vista previa' -ForegroundColor Green
}

$conLlave = @{ Authorization = "Bearer $token" }

# ---------------------------------------------------------------------------
# 2. Las cinco operaciones
# ---------------------------------------------------------------------------

Titulo '2. Las cinco operaciones de /api/v1'

$cliente = Invoke-Api -Path '/api/v1/client' -Headers $conLlave
Paso 'GET /v1/client (consulta por usuario o cliente)' 200 $cliente `
  ("casillero {0}, alta {1}" -f $cliente.Body.clientCode, $cliente.Body.memberSince)

$casillero = Invoke-Api -Path '/api/v1/locker' -Headers $conLlave
Paso 'GET /v1/locker (consulta de casillero)' 200 $casillero `
  ("sub-casillero {0}, {1} lineas de direccion" -f $casillero.Body.subLocker, $casillero.Body.lines.Count)

$paquetes = Invoke-Api -Path '/api/v1/packages?pageSize=5' -Headers $conLlave
Paso 'GET /v1/packages (todos los del cliente)' 200 $paquetes `
  ("{0} paquetes en total" -f $paquetes.Body.total)

$porEstado = Invoke-Api -Path '/api/v1/packages?state=prealertado' -Headers $conLlave
Paso 'GET /v1/packages?state=prealertado (consulta por estado)' 200 $porEstado `
  ("{0} prealertados" -f $porEstado.Body.total)

# El tracking sale del listado, no de una constante: asi la prueba sirve con
# cualquier base sembrada.
if ($paquetes.Body.items.Count -gt 0) {
  $tracking = $paquetes.Body.items[0].tracking
  $porTracking = Invoke-Api -Path "/api/v1/packages/$tracking" -Headers $conLlave
  Paso "GET /v1/packages/$tracking (consulta por tracking)" 200 $porTracking `
    ("{0} en estado '{1}'" -f $porTracking.Body.code, $porTracking.Body.stateLabel)
}
else {
  Write-Host '  (sin paquetes en este casillero: se omite la consulta por tracking)' -ForegroundColor Yellow
}

$trackingNuevo = 'SMOKE-{0}' -f (Get-Date -Format 'yyMMddHHmmss')
$prealerta = Invoke-Api -Method POST -Path '/api/v1/prealerts' -Headers $conLlave -Body @{
  tracking         = $trackingNuevo
  description      = 'Prueba de humo de la API publica'
  store            = 'AMAZON'
  carrier          = 'USPS'
  declaredValueUsd = 12.5
}
Paso 'POST /v1/prealerts (prealerta de paquete)' 201 $prealerta `
  ("creado {0} en estado '{1}'" -f $prealerta.Body.code, $prealerta.Body.state)

# ---------------------------------------------------------------------------
# 3. Los "no"
# ---------------------------------------------------------------------------

Titulo '3. Lo que tiene que fallar'

$repetida = Invoke-Api -Method POST -Path '/api/v1/prealerts' -Headers $conLlave -Body @{
  tracking         = $trackingNuevo
  description      = 'El mismo tracking otra vez'
  store            = 'AMAZON'
  carrier          = 'USPS'
  declaredValueUsd = 12.5
}
Paso 'prealerta con un tracking ya en curso' 409 $repetida (CodigoDe $repetida)

$invalida = Invoke-Api -Method POST -Path '/api/v1/prealerts' -Headers $conLlave -Body @{
  tracking         = 'AB'
  description      = 'x'
  store            = 'NO EXISTE'
  carrier          = 'USPS'
  declaredValueUsd = -1
}
Paso 'prealerta con el cuerpo invalido' 400 $invalida (CodigoDe $invalida)

$ajeno = Invoke-Api -Path '/api/v1/packages?clientCode=HS-0000' -Headers $conLlave
Paso 'consultar el casillero de otro' 403 $ajeno (CodigoDe $ajeno)

$noExiste = Invoke-Api -Path '/api/v1/packages/NOEXISTEESTETRACKING' -Headers $conLlave
Paso 'tracking que no existe (o que es de otro)' 404 $noExiste (CodigoDe $noExiste)

$sinLlave = Invoke-Api -Path '/api/v1/client'
Paso 'peticion sin llave' 401 $sinLlave (CodigoDe $sinLlave)

$inventada = Invoke-Api -Path '/api/v1/client' -Headers @{ Authorization = 'Bearer hsk_live_noesunallave' }
Paso 'llave inventada o mal formada' 401 $inventada (CodigoDe $inventada)

# Las formas de mandar la llave que ensena la documentacion (docs/16 §7). Van
# aqui porque son afirmaciones que la pagina hace en imperativo ("ponla asi",
# "asi no funciona"): si una cambia sin que nadie lo note, la documentacion pasa
# a mandar a integrar mal, que es peor que no documentar.
$porAlterna = Invoke-Api -Path '/api/v1/client' -Headers @{ 'x-api-key' = $token }
Paso 'la llave en x-api-key, sin la palabra Bearer' 200 $porAlterna

$sinBearer = Invoke-Api -Path '/api/v1/client' -Headers @{ Authorization = $token }
Paso 'Authorization con la llave pero sin Bearer' 401 $sinBearer (CodigoDe $sinBearer)

$enLaUrl = Invoke-Api -Path "/api/v1/client?api_key=$token"
Paso 'la llave en la direccion, sin cabecera' 401 $enLaUrl (CodigoDe $enLaUrl)

$conComillas = Invoke-Api -Path '/api/v1/client' -Headers @{ Authorization = "Bearer ""$token""" }
Paso 'la llave pegada con comillas alrededor' 401 $conComillas (CodigoDe $conComillas)

$bearerEnAlterna = Invoke-Api -Path '/api/v1/client' -Headers @{ 'x-api-key' = "Bearer $token" }
Paso 'x-api-key con la palabra Bearer delante' 401 $bearerEnAlterna (CodigoDe $bearerEnAlterna)

# ---------------------------------------------------------------------------
# 4. Las dos puertas son excluyentes (docs/16 5.2)
# ---------------------------------------------------------------------------

Titulo '4. La cookie y la llave no se cruzan'

$cookieEnApi = Invoke-Api -Path '/api/v1/client' -Session $sesion
Paso 'la cookie de sesion NO abre /api/v1' 401 $cookieEnApi (CodigoDe $cookieEnApi)

$llaveEnPortal = Invoke-Api -Path '/api/api-keys' -Headers $conLlave
Paso 'la llave NO abre el portal' 401 $llaveEnPortal (CodigoDe $llaveEnPortal)

$spec = Invoke-Api -Path '/api/v1/openapi.json'
Paso 'el documento OpenAPI se sirve sin credenciales' 200 $spec `
  ("{0} rutas documentadas" -f ($spec.Body.paths.PSObject.Properties.Name).Count)

# ---------------------------------------------------------------------------
# 5. El limitador (opcional: son ~125 peticiones)
# ---------------------------------------------------------------------------

if ($ConLimite) {
  Titulo '5. Limitador de peticiones'

  $limite = [int]$cliente.Headers['X-RateLimit-Limit']
  Write-Host ("  Limite anunciado: {0} peticiones por ventana" -f $limite) -ForegroundColor DarkGray

  $bloqueada = $null
  for ($i = 0; $i -lt ($limite + 10); $i++) {
    $r = Invoke-Api -Path '/api/v1/client' -Headers $conLlave
    if ($r.Status -eq 429) { $bloqueada = $r; break }
  }

  if ($null -eq $bloqueada) {
    $script:fallos++
    Write-Host '  FALLO nunca llego el 429: el limitador no esta cortando' -ForegroundColor Red
  }
  else {
    Paso 'se corta al agotar el cupo' 429 $bloqueada (CodigoDe $bloqueada)
    $reintentar = $bloqueada.Headers['Retry-After']
    if ($reintentar) {
      $script:ok++
      Write-Host ("  OK    el 429 dice cuando reintentar (Retry-After: {0}s)" -f $reintentar) -ForegroundColor Green
    }
    else {
      $script:fallos++
      Write-Host '  FALLO el 429 no trae Retry-After' -ForegroundColor Red
    }
    Write-Host '  (esta llave se queda sin cupo hasta que termine la ventana)' -ForegroundColor Yellow
  }
}
else {
  Write-Host ''
  Write-Host '5. Limitador: omitido. Anade -ConLimite para probarlo.' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 6. Rotacion y revocacion
# ---------------------------------------------------------------------------

Titulo '6. Rotar y revocar'

$rotada = Invoke-Api -Method POST -Path "/api/api-keys/$llaveId/rotate" -Session $sesion -Body @{}
Paso 'POST /api/api-keys/:id/rotate emite la sustituta' 201 $rotada
$tokenNuevo = $rotada.Body.token
$conLlaveNueva = @{ Authorization = "Bearer $tokenNuevo" }

$vieja = Invoke-Api -Path '/api/v1/client' -Headers $conLlave
Paso 'la llave rotada deja de servir en el acto' 401 $vieja (CodigoDe $vieja)

$nueva = Invoke-Api -Path '/api/v1/client' -Headers $conLlaveNueva
Paso 'la llave nueva funciona' 200 $nueva

$revocada = Invoke-Api -Method DELETE -Path ("/api/api-keys/{0}" -f $rotada.Body.id) -Session $sesion
Paso 'DELETE /api/api-keys/:id revoca' 200 $revocada

$despues = Invoke-Api -Path '/api/v1/client' -Headers $conLlaveNueva
Paso 'la llave revocada deja de servir' 401 $despues (CodigoDe $despues)

# ---------------------------------------------------------------------------
# Resumen
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host ('-' * 60)
if ($script:fallos -eq 0) {
  Write-Host ("Todo en orden: {0} comprobaciones." -f $script:ok) -ForegroundColor Green
}
else {
  Write-Host ("{0} comprobaciones bien, {1} MAL." -f $script:ok, $script:fallos) -ForegroundColor Red
}
Write-Host ("Quedo un paquete de prueba con tracking {0}." -f $trackingNuevo) -ForegroundColor DarkGray
Write-Host 'Para dejar la base como estaba:  pnpm --filter @courier/api db:seed:demo -- --reset' -ForegroundColor DarkGray

if ($script:fallos -gt 0) { exit 1 }
