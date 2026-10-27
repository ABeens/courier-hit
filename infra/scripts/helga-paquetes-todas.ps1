# Lista los paquetes que Helga tiene HOY en TODAS las cuentas (la principal de
# HELGA_ACCOUNTS y las exclusivas de provider_accounts) usando la consulta en lote
# (op. E, POST /api/casillero/despachos/preliquidaciones/paqsdisponibles). Cruza
# cada paquete con nuestros shipments por tracking o HAWB para marcar los que no
# tenemos. Solo lectura. Corre dentro de la instancia.
param([string]$Buscar = '')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Region = 'us-east-1'
if ($Buscar -and $Buscar -notmatch '^[A-Za-z0-9 @._+-]{1,64}$') { Write-Error 'Texto no valido'; exit 1 }

$instance = aws ec2 describe-instances --region $Region `
  --filters "Name=tag:Name,Values=courier-api" "Name=instance-state-name,Values=running" `
  --query "Reservations[].Instances[].InstanceId" --output text
Write-Host "Instancia: $instance"

$sqlAccounts = "select coalesce(json_agg(json_build_array(code, name, username, password_encrypted, oauth_client_id, oauth_client_secret_encrypted, app_id)), '[]')::text from provider_accounts"
$sqlShipments = "select coalesce(json_agg(json_build_array(upper(tracking), upper(hawb), state, discarded_at is not null)), '[]')::text from shipments"

$js = @'
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
const env = process.env;
function decrypt(stored) {
  const [v, iv, tag, data] = stored.split('.');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(env.PROVIDER_SECRETS_KEY, 'base64'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
const accounts = [];
try {
  const p = JSON.parse(env.HELGA_ACCOUNTS || '[]')[0];
  if (p) accounts.push({ code: p.code, name: p.name, username: p.username, password: p.password,
    clientId: p.oauthClientId, clientSecret: p.oauthClientSecret, appId: p.appId, principal: true });
} catch {}
for (const [code, name, username, passEnc, ocId, ocSecEnc, appId] of JSON.parse(readFileSync('/tmp/hp-accounts.json', 'utf8') || '[]')) {
  accounts.push({ code, name, username, password: decrypt(passEnc), clientId: ocId,
    clientSecret: ocId && ocSecEnc ? decrypt(ocSecEnc) : undefined, appId });
}
// Indice de nuestros shipments por tracking y por HAWB (en mayusculas).
const ours = new Map();
for (const [tracking, hawb, state, discarded] of JSON.parse(readFileSync('/tmp/hp-shipments.json', 'utf8') || '[]')) {
  const info = `${state}${discarded ? ' (descartado)' : ''}`;
  if (tracking) ours.set(tracking, info);
  if (hawb) ours.set(hawb, info);
}
const base = env.HELGA_BASE_URL;
let total = 0, missing = 0;
for (const a of accounts) {
  const tag = `${a.code} (${a.name})${a.principal ? ' [principal]' : ''}`;
  const own = Boolean(a.clientId && a.clientSecret);
  const t = await fetch(`${base}/oauth/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'password', client_id: own ? a.clientId : env.HELGA_CLIENT_ID,
      client_secret: own ? a.clientSecret : env.HELGA_CLIENT_SECRET, username: a.username, password: a.password, scope: '' }) });
  if (!t.ok) { console.log(`\n== ${tag}: TOKEN ${t.status}`); continue; }
  const { access_token } = await t.json();
  const appId = a.appId ?? env.HELGA_APP_ID;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${access_token}`,
    ...(env.HELGA_ORIGIN ? { Origin: env.HELGA_ORIGIN } : {}), ...(appId ? { 'X-App-Id': appId } : {}) };
  const rows = [];
  let page = 1, lastPage = 1, status = 0;
  do {
    const r = await fetch(`${base}/api/casillero/despachos/preliquidaciones/paqsdisponibles?page=${page}`, { method: 'POST', headers,
      body: JSON.stringify({ pageSize: 100, ...(env.BUSCAR ? { str_busqueda: env.BUSCAR } : {}) }) });
    status = r.status;
    const body = await r.json().catch(() => ({}));
    const pag = body?.datos ?? body?.data ?? body;
    if (Array.isArray(pag?.data)) rows.push(...pag.data);
    lastPage = pag?.last_page ?? page;
    page += 1;
    await new Promise((s) => setTimeout(s, 300));
  } while (r_ok(status) && page <= lastPage);
  console.log(`\n== ${tag}: ${rows.length} paquete(s) (HTTP ${status}, ${lastPage} pagina(s))`);
  for (const x of rows) {
    const key = [x.tracking, x.hawb].map((s) => (s ?? '').toUpperCase()).find((s) => s && ours.has(s));
    const nuestro = key ? ours.get(key) : 'NO ESTA EN NUESTRA BD';
    if (!key) missing++;
    console.log(`   ${x.hawb ?? '-'} | trk ${x.tracking ?? '-'} | ${x.estado ?? '-'} | dest ${x.destinatario_id ?? '-'} | ${x.peso_lb ?? x.peso ?? '-'} lb | recibido ${x.fecha_recibido ?? '-'} | ${x.tienda ?? '-'} | nuestro: ${nuestro}`);
  }
  total += rows.length;
}
console.log(`\nTOTAL: ${total} paquete(s) en Helga, ${missing} sin shipment nuestro.`);
function r_ok(s) { return s >= 200 && s < 300; }
'@

$b64 = { param($s) [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s)) }
$sqlAccB64 = & $b64 $sqlAccounts
$sqlShipB64 = & $b64 $sqlShipments
$jsB64 = & $b64 $js
$bash = @"
set -e
PSQL() { docker run --rm --env-file /opt/courier/api.env postgres:16-alpine sh -c 'psql "`$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "`$0"' "`$1"; }
PSQL "`$(echo '$sqlAccB64' | base64 -d)" > /tmp/hp-accounts.json
PSQL "`$(echo '$sqlShipB64' | base64 -d)" > /tmp/hp-shipments.json
echo '$jsB64' | base64 -d > /tmp/hp.mjs
for f in hp.mjs hp-accounts.json hp-shipments.json; do docker cp /tmp/`$f courier-api:/tmp/`$f; done
rm -f /tmp/hp.mjs /tmp/hp-accounts.json /tmp/hp-shipments.json
docker exec -e BUSCAR='$Buscar' courier-api node /tmp/hp.mjs || echo "NODE_FALLO"
docker exec -u root courier-api rm -f /tmp/hp.mjs /tmp/hp-accounts.json /tmp/hp-shipments.json
"@

$paramsFile = Join-Path $env:TEMP 'helga-paquetes-todas.json'
@{ commands = @($bash) } | ConvertTo-Json -Compress | Out-File -FilePath $paramsFile -Encoding ascii
$commandId = aws ssm send-command --region $Region --instance-ids $instance `
  --document-name AWS-RunShellScript --comment "paquetes helga todas las cuentas (lectura)" `
  --parameters "file://$paramsFile" --timeout-seconds 600 --query 'Command.CommandId' --output text
Remove-Item $paramsFile -ErrorAction SilentlyContinue

for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 5
  $status = aws ssm get-command-invocation --region $Region --command-id $commandId --instance-id $instance --query 'Status' --output text 2>$null
  if ($status -in @('Success', 'Failed', 'Cancelled', 'TimedOut')) { break }
}
aws ssm get-command-invocation --region $Region --command-id $commandId --instance-id $instance --query 'StandardOutputContent' --output text
if ($status -ne 'Success') {
  aws ssm get-command-invocation --region $Region --command-id $commandId --instance-id $instance --query 'StandardErrorContent' --output text
}
