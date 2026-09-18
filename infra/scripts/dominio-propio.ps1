# Pone en produccion el dominio propio: www.hsglobal-services.com en vez de la
# URL de CloudFront.
#
# POR QUE HACE FALTA. `DOMAIN_LIVE` en infra/lib/config.ts ya esta en `true`,
# pero eso solo cambia el codigo. El valor que la API lee de verdad (`WEB_ORIGIN`)
# vive en Parameter Store y solo se reescribe cuando se despliega el stack, y el
# proceso que esta corriendo no relee SSM por su cuenta. Mientras no se corra
# esto, los correos de "restablecer contrasena" e "invitacion de staff" siguen
# saliendo con el enlace de CloudFront.
#
# QUE HACE, en este orden:
#   1. Comprueba que www resuelve y sirve el sitio (si no, no sigue: apuntar ahi
#      los enlaces de los correos sin que el host exista es peor que dejarlo como
#      esta).
#   2. `cdk deploy courier-prod-app`, que reescribe WEB_ORIGIN en Parameter Store.
#   3. Recarga el env de la API y reinicia el servicio.
#   4. Recompila y sube el sitio, porque el canonical y las og:image cambian con
#      `site` en apps/web/astro.config.mjs.
#   5. Vuelve a comprobar el resultado.
#
# Es idempotente: correrlo dos veces no rompe nada.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\dominio-propio.ps1
#
# Solo comprobar, sin desplegar nada:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\dominio-propio.ps1 -CheckOnly
#
# Requisitos: aws cli autenticada, pnpm, y bash (Git Bash) para el paso del sitio.

param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

# Tienen que coincidir con infra/lib/config.ts. Si cambian ahi, cambian aqui.
$Region = 'us-east-1'
$Domain = 'hsglobal-services.com'
$SiteHost = "www.$Domain"
$SiteUrl = "https://$SiteHost"
$AppStack = 'courier-prod-app'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Write-Step($text) {
  Write-Host ''
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Test-SiteHost {
  # Contra el sitio de verdad, no contra el DNS del equipo: lo que importa es lo
  # que ve un cliente con su navegador, incluido el certificado.
  try {
    $res = Invoke-WebRequest -Uri $SiteUrl -Method Head -TimeoutSec 20 -UseBasicParsing
    return [int]$res.StatusCode
  }
  catch {
    return 0
  }
}

Write-Step "Comprobando que $SiteHost sirve el sitio"
$code = Test-SiteHost
if ($code -ne 200) {
  Write-Host "  $SiteUrl no respondio 200 (resultado: $code)." -ForegroundColor Red
  Write-Host '  Falta el CNAME de www en Squarespace, o todavia no ha propagado.'
  Write-Host '  Revisalo con:  .\infra\scripts\domain.ps1 dns'
  Write-Host '  NO se despliega: apuntar los enlaces de los correos a un host que'
  Write-Host '  no responde deja a los clientes sin poder restablecer su contrasena.'
  exit 1
}
Write-Host "  $SiteUrl responde 200 con certificado valido." -ForegroundColor Green

if ($CheckOnly) {
  Write-Step 'Solo comprobacion (-CheckOnly): no se despliega nada.'
  Write-Host 'WEB_ORIGIN que tiene hoy la API en Parameter Store:'
  aws ssm get-parameter --region $Region --name '/courier/prod/WEB_ORIGIN' --query 'Parameter.Value' --output text
  exit 0
}

Write-Step 'Sesion de AWS'
aws sts get-caller-identity --output text | Out-Null
if (-not $?) {
  Write-Error "Sesion de AWS expirada. Ejecuta 'aws login' y repite."
  exit 1
}

Write-Step "Desplegando $AppStack (reescribe WEB_ORIGIN en Parameter Store)"
Push-Location (Join-Path $RepoRoot 'infra')
try {
  pnpm exec cdk deploy $AppStack --require-approval never
  if (-not $?) { throw "Fallo el despliegue de $AppStack." }
}
finally {
  Pop-Location
}

Write-Step 'Recargando el env de la API y reiniciando el servicio'
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'reload-api-env.ps1')
if (-not $?) { throw 'Fallo la recarga del env de la API.' }

Write-Step 'Recompilando y subiendo el sitio (cambia el canonical)'
& bash (Join-Path $RepoRoot 'infra/scripts/deploy-local.sh') web
if (-not $?) { throw 'Fallo el despliegue del sitio.' }

Write-Step 'Resultado'
Write-Host 'WEB_ORIGIN en Parameter Store:'
aws ssm get-parameter --region $Region --name '/courier/prod/WEB_ORIGIN' --query 'Parameter.Value' --output text

# Lo anterior es lo que dice la CONFIGURACION; esto es lo que tiene cargado el
# proceso, que es lo que de verdad importa. El CORS del portal se arma con un
# unico origen (el WEB_ORIGIN), asi que la cabecera lo devuelve tal cual.
Write-Host ''
Write-Host 'WEB_ORIGIN que tiene cargado la API en marcha:'
try {
  $probe = Invoke-WebRequest -Uri "$SiteUrl/api/auth/login" -Method Options -TimeoutSec 20 -UseBasicParsing `
    -Headers @{ 'Origin' = $SiteUrl; 'Access-Control-Request-Method' = 'POST' }
  $allowed = $probe.Headers['Access-Control-Allow-Origin']
  if ($allowed -eq $SiteUrl) {
    Write-Host "  $allowed" -ForegroundColor Green
  }
  else {
    Write-Host "  $allowed  <- todavia no es $SiteUrl" -ForegroundColor Yellow
    Write-Host '  Si la instancia acaba de reiniciarse, espera un par de minutos y repite.'
  }
}
catch {
  Write-Host '  No se pudo comprobar (la API puede estar reiniciandose).' -ForegroundColor Yellow
}

$code = Test-SiteHost
Write-Host ''
if ($code -eq 200) {
  Write-Host "Listo. $SiteUrl responde 200." -ForegroundColor Green
}
else {
  Write-Host "Ojo: $SiteUrl respondio $code despues del despliegue." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Para confirmar de punta a punta: pide un restablecimiento desde'
Write-Host "$SiteUrl/recuperar y comprueba que el enlace del correo empieza por"
Write-Host "$SiteUrl/restablecer?token=..."
