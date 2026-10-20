# Prueba si Helga acepta PREALERTAS hechas con una cuenta EXCLUSIVA (cliente
# consolidado, p. ej. Zuca / SJO009623).
#
# Por que existe: la app no prealerta a los clientes consolidados (ver `insert` en
# shipments.service.ts). La op. C cuelga la prealerta de un `destinatario_id`, y
# esos clientes no tienen uno nuestro en la cuenta principal: viven en su propia
# cuenta de Helga. Antes de cambiar la app hay que saber si con el token de SU
# cuenta, y un destinatario de SU cuenta, Helga crea la prealerta.
#
# Corre DENTRO de la instancia (Helga solo acepta su IP/Origin):
#   1. un contenedor `psql` de un solo uso lee la cuenta de `provider_accounts`;
#   2. el contenedor `courier-api` (que ya tiene PROVIDER_SECRETS_KEY y las
#      variables de Helga) descifra la contrasena y llama a Helga.
# Ninguna credencial sale de la instancia ni se imprime.
#
# Dos fases:
#   - Por defecto, SOLO LECTURA: pide el token de la cuenta y lista sus
#     destinatarios (id, sub-casillero, nombre). No crea nada.
#   - Con -Crear -DestinatarioId <id>: crea UNA prealerta de prueba (tracking
#     PRUEBAHS..., contenido "PRUEBA API - NO PROCESAR", valores en 0) y la BORRA
#     enseguida. Con -NoBorrar la deja para verla en la pantalla de Helga; en ese
#     caso anota el id que imprime, porque luego hay que borrarla a mano.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-prealerta-cuenta-exclusiva.ps1
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-prealerta-cuenta-exclusiva.ps1 -Buscar ZUCA
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-prealerta-cuenta-exclusiva.ps1 -Crear -DestinatarioId 12345

param(
  [string]$Cuenta = 'SJO009623',
  # Filtro de Helga sobre los destinatarios (cedula, nombre, sub-casillero, correo).
  [string]$Buscar = '',
  [switch]$Crear,
  [string]$DestinatarioId = '',
  [switch]$NoBorrar
)

$ErrorActionPreference = 'Stop'

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Region = 'us-east-1'
$InstanceTag = 'courier-api'

# Los valores viajan pegados en SQL y en el shell de la instancia: solo se aceptan
# caracteres seguros.
if ($Cuenta -notmatch '^[A-Za-z0-9]{3,32}$') { Write-Error "'$Cuenta' no parece un codigo de cuenta."; exit 1 }
if ($Buscar -notmatch '^[A-Za-z0-9 @._-]{0,64}$') { Write-Error "-Buscar solo admite letras, digitos, espacio y @._-"; exit 1 }
if ($Crear -and $DestinatarioId -notmatch '^[0-9]{1,20}$') {
  Write-Error 'Con -Crear hace falta -DestinatarioId (el id numerico que lista la fase de lectura).'
  exit 1
}

aws sts get-caller-identity --output text | Out-Null
if (-not $?) { throw "Sesion de AWS expirada o sin credenciales. Ejecuta 'aws login' y repite." }

Write-Host "Buscando la instancia '$InstanceTag' en $Region..."
$instance = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=$InstanceTag" "Name=instance-state-name,Values=running" `
  --query "Reservations[].Instances[].InstanceId" --output text
if (-not $instance -or $instance -eq 'None') {
  throw "No hay ninguna instancia '$InstanceTag' en marcha. Revisa el perfil de AWS y la region."
}
Write-Host "Instancia: $instance"

$sql = "select json_build_array(code, name, username, password_encrypted, oauth_client_id, oauth_client_secret_encrypted, app_id)::text from provider_accounts where code = '$Cuenta'"

# Script de Node que corre dentro de courier-api. Solo ASCII: viaja en base64.
$js = @'
import { createDecipheriv } from 'node:crypto';

const env = process.env;
const [code, name, username, passEnc, ocId, ocSecEnc, accAppId] = JSON.parse(
  Buffer.from(env.PA_ROW_B64, 'base64').toString('utf8'),
);

// Mismo formato que core/secrets.ts: v1.<iv>.<tag>.<datos>, AES-256-GCM.
function decrypt(stored) {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1') throw new Error('secreto con formato inesperado');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(env.PROVIDER_SECRETS_KEY, 'base64'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

const base = env.HELGA_BASE_URL;
const short = (v) => JSON.stringify(v).slice(0, 600);
const unwrap = (p) => (p && typeof p === 'object' && (p.data ?? p.datos)) || p;

console.log(`CUENTA ${code} (${name}), usuario ${username}`);

// --- 1. Token de la cuenta (misma logica que helga.auth.ts) ---
const ownApp = Boolean(ocId && ocSecEnc);
const tokenRes = await fetch(`${base}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    grant_type: 'password',
    client_id: ownApp ? ocId : env.HELGA_CLIENT_ID,
    client_secret: ownApp ? decrypt(ocSecEnc) : env.HELGA_CLIENT_SECRET,
    username,
    password: decrypt(passEnc),
    scope: '',
  }),
});
console.log(`TOKEN -> ${tokenRes.status}`);
if (!tokenRes.ok) process.exit(0);
const { access_token: token } = await tokenRes.json();

const appId = accAppId ?? env.HELGA_APP_ID;
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(env.HELGA_ORIGIN ? { Origin: env.HELGA_ORIGIN } : {}),
      ...(appId ? { 'X-App-Id': appId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

// --- 2. Destinatarios de la cuenta (op. G, solo lectura) ---
const list = await call('POST', '/api/casillero/clientes/destinatarios?page=1', {
  pageSize: 20,
  ...(env.BUSCAR ? { str_busqueda: env.BUSCAR } : {}),
});
const pag = unwrap(list.payload);
const rows = Array.isArray(pag?.data) ? pag.data : [];
console.log(`DESTINATARIOS -> ${list.status}, total ${pag?.total ?? rows.length} (se muestran ${rows.length})`);
for (const r of rows) {
  console.log(`  id ${r.id} | sub ${r.sub_casillero ?? '-'} | ${r.nombre_completo ?? '-'} | activo ${r.activo !== false}`);
}
if (rows.length === 0) console.log(`  respuesta: ${short(list.payload)}`);

if (env.MODE !== 'crear') {
  console.log('Solo lectura: no se creo nada. Para probar la prealerta, relanza con -Crear -DestinatarioId <id>.');
  process.exit(0);
}

// --- 3. Prealerta de prueba (op. C) y borrado (op. F) ---
const tracking = `PRUEBAHS${Date.now()}`;
const created = await call('POST', '/api/v2/prealertas', {
  tracking,
  contenido: 'PRUEBA API - NO PROCESAR',
  tienda: 'POR DEFINIR',
  destinatario_id: env.DEST_ID,
  valor_comercial: 0,
  valor_asegurado: 0,
  retener: false,
  posicion_arancelaria: '98.07.20.00.00',
});
console.log(`PREALERTA ${tracking} -> ${created.status}`);
console.log(`  respuesta: ${short(created.payload)}`);
const d = unwrap(created.payload);
const id = d?.Id ?? d?.id ?? d?.prealerta_id;
if (!id) process.exit(0);
console.log(`  id de la prealerta: ${id}`);

if (env.NO_BORRAR === '1') {
  console.log('  -NoBorrar: la prealerta queda en Helga. Borrala a mano cuando la hayas visto.');
  process.exit(0);
}
const del = await call('DELETE', `/api/casillero/prealertas/${encodeURIComponent(id)}`);
console.log(`BORRADO ${id} -> ${del.status} ${short(del.payload)}`);
'@

$b64 = { param($s) [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s)) }
$sqlB64 = & $b64 $sql
$jsB64 = & $b64 $js
$mode = if ($Crear) { 'crear' } else { 'leer' }
# Nombre distinto del parametro: PowerShell no distingue mayusculas y `$noBorrar`
# seria el mismo switch -NoBorrar, que no acepta una cadena.
$keepFlag = if ($NoBorrar) { '1' } else { '0' }

# Script de bash para la instancia. El SQL y el JS van en base64 para no pelear
# con comillas anidadas entre PowerShell, JSON, bash y sh.
$bash = @"
set -e
SQL=`$(echo '$sqlB64' | base64 -d)
ROW=`$(docker run --rm --env-file /opt/courier/api.env postgres:16-alpine sh -c 'psql "`$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "`$0"' "`$SQL")
if [ -z "`$ROW" ]; then echo "SIN_CUENTA $Cuenta"; exit 0; fi
echo '$jsB64' | base64 -d > /tmp/prueba-prealerta.mjs
docker cp /tmp/prueba-prealerta.mjs courier-api:/tmp/prueba-prealerta.mjs
rm -f /tmp/prueba-prealerta.mjs
docker exec -e PA_ROW_B64="`$(printf %s "`$ROW" | base64 -w0)" -e MODE=$mode -e DEST_ID=$DestinatarioId -e NO_BORRAR=$keepFlag -e BUSCAR='$Buscar' courier-api node /tmp/prueba-prealerta.mjs || echo "NODE_FALLO"
docker exec -u root courier-api rm -f /tmp/prueba-prealerta.mjs
"@

$paramsFile = Join-Path $env:TEMP 'helga-prealerta-cuenta-exclusiva.json'
@{ commands = @($bash) } | ConvertTo-Json -Compress |
  Out-File -FilePath $paramsFile -Encoding ascii

if ($Crear) {
  Write-Host "Creando una prealerta de PRUEBA en la cuenta $Cuenta para el destinatario $DestinatarioId..." -ForegroundColor Yellow
}
else {
  Write-Host "Consultando la cuenta $Cuenta en Helga (solo lectura)..."
}
$commandId = aws ssm send-command --region $Region `
  --instance-ids $instance `
  --document-name AWS-RunShellScript `
  --comment "prueba prealerta cuenta exclusiva $Cuenta ($mode)" `
  --parameters "file://$paramsFile" `
  --timeout-seconds 300 `
  --query 'Command.CommandId' --output text
Remove-Item $paramsFile -ErrorAction SilentlyContinue

$status = 'Pending'
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  $status = aws ssm get-command-invocation --region $Region `
    --command-id $commandId --instance-id $instance --query 'Status' --output text 2>$null
  if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
}

$salida = aws ssm get-command-invocation --region $Region `
  --command-id $commandId --instance-id $instance `
  --query 'StandardOutputContent' --output text
$errores = aws ssm get-command-invocation --region $Region `
  --command-id $commandId --instance-id $instance `
  --query 'StandardErrorContent' --output text

Write-Host ''
Write-Host $salida
if ($status -ne 'Success' -or $salida -match 'NODE_FALLO') {
  Write-Host $errores -ForegroundColor Red
  throw "La prueba termino en estado $status."
}
