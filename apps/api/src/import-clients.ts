/**
 * Carga inicial de clientes desde el Excel de HS Global
 * ("Informacion de Clientes ... .xlsx"). Valida SIEMPRE antes de escribir, y por
 * defecto SOLO valida.
 *
 * Hojas que lee (los encabezados se buscan por nombre, no por posicion):
 *
 *  - "Clientes HSGlobal": clientes de la cuenta principal (SJO008835).
 *      · Con sub-casillero: YA existen en Helga. No se dan de alta otra vez: se
 *        busca su destinatario por el sub-casillero (op. G, solo lectura) y el
 *        casillero nace `synced` con ese id. Sin el id, los paquetes que importa
 *        el robot no tendrian a quien atribuirse.
 *      · Sin sub-casillero: alta normal (`authService.createClientAccount`), que
 *        es la que ya aplica la regla de ofuscacion: a Helga solo viaja nombre y
 *        cedula; telefono y direccion son los fijos de HS Global y el correo es
 *        el falso derivado (docs/13 §3.6). Si Helga ya lo tenia, lo adopta.
 *      · La fila cuyo correo es el de la cuenta PRINCIPAL se salta: es HS Global,
 *        no un cliente.
 *  - "Cuentas Mayoristas": cada fila `consolidado` es una cuenta exclusiva del
 *    proveedor y su cliente consolidado (igual que `createConsolidatedClient`,
 *    pero sin invitacion y con la tarifa Consolidada). La fila PRINCIPAL vive en
 *    la configuracion del despliegue (`HELGA_ACCOUNTS`) y no se carga.
 *
 * Contra Helga se compara lo unico que alli es real: sub-casillero, cedula y
 * nombre. Correo, telefono y direccion de Helga son los ofuscados, asi que no se
 * comparan. Las credenciales de cada cuenta mayorista se prueban pidiendo un
 * token; si Helga las rechaza, la cuenta se carga APAGADA.
 *
 * NO SE ENVIA NINGUN CORREO. Los clientes quedan con una contrasena inutilizable
 * hasta que se les mande la invitacion (paso aparte).
 *
 * Idempotente: un cliente cuyo correo ya existe con la misma cedula se cuenta
 * como "ya cargado" y no se toca, asi que se puede volver a correr tras corregir
 * el Excel.
 *
 * Variables:
 *   IMPORT_FILE=<ruta>      el Excel en disco (local), o
 *   IMPORT_S3_KEY=<clave>   el Excel subido al bucket de adjuntos (AWS).
 *   IMPORT_CONFIRM=1        escribe. Sin ella solo valida.
 *   IMPORT_SKIP_HELGA=1     solo desarrollo: no consulta Helga; los clientes con
 *                           sub-casillero quedan `pending` sin id de destinatario.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import {
  ClientRateKind,
  ClientReviewStatus,
  HelgaSyncStatus,
  PROVINCES,
  Principal,
  ProviderLinkSource,
  Role,
  UserStatus,
  emailSchema,
  idNumberSchema,
  phoneSchema,
} from '@courier/shared';
import { type HelgaAccount, config, helgaPrincipalAccountCode } from './core/config';
import { db } from './core/db';
import { encryptSecret, secretsKeyConfigured } from './core/secrets';
import { getAccessToken } from './integrations/helga/helga.auth';
import { isHelgaEnabled, isHelgaSimulated, listHelgaRecipients } from './integrations/helga/helga.client';
import { clients, users } from './modules/auth/auth.schema';
import { authService } from './modules/auth/auth.service';
import { clientProviderLinkEvents } from './modules/clients/provider-link.schema';
import { providerAccounts } from './modules/provider-accounts/provider-accounts.schema';
import { clientRates } from './modules/tariffs/tariffs.schema';

const CONFIRMED = process.env.IMPORT_CONFIRM === '1';
const SKIP_HELGA = process.env.IMPORT_SKIP_HELGA === '1';
const ORIGIN = 'Carga inicial desde Excel';

// ---------------------------------------------------------------------------
// Lectura del Excel
// ---------------------------------------------------------------------------

/** Minusculas, sin tildes ni espacios de mas. Para comparar nombres y encabezados. */
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Texto de una celda, venga como numero, hipervinculo (los correos) o texto enriquecido. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('').trim();
    if ('text' in value) return cellText(value.text as ExcelJS.CellValue);
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if (value instanceof Date) return value.toISOString();
  }
  return String(value).trim();
}

/** Filas de una hoja como objetos, con las columnas localizadas por encabezado. */
function readSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  columns: Record<string, string>,
): Array<{ line: number; get: (key: string) => string }> {
  const ws = wb.worksheets.find((w) => norm(w.name) === norm(sheetName));
  if (!ws) throw new Error(`El Excel no tiene la hoja "${sheetName}".`);

  const header = ws.getRow(1);
  const index: Record<string, number> = {};
  header.eachCell((cell, col) => {
    const text = norm(cellText(cell.value));
    for (const [key, prefix] of Object.entries(columns)) {
      if (index[key] === undefined && text.startsWith(norm(prefix))) index[key] = col;
    }
  });
  const missing = Object.entries(columns).filter(([key]) => index[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`La hoja "${sheetName}" no tiene las columnas: ${missing.map(([, p]) => p).join(', ')}.`);
  }

  const out: Array<{ line: number; get: (key: string) => string }> = [];
  ws.eachRow((row, line) => {
    if (line === 1) return;
    const get = (key: string) => cellText(row.getCell(index[key]!).value);
    if (Object.keys(columns).every((k) => get(k) === '')) return;
    out.push({ line, get });
  });
  return out;
}

async function loadWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const file = process.env.IMPORT_FILE;
  const key = process.env.IMPORT_S3_KEY;
  if (file) {
    await wb.xlsx.load((await readFile(file)) as unknown as ArrayBuffer);
  } else if (key) {
    if (!config.UPLOADS_BUCKET) throw new Error('IMPORT_S3_KEY sin UPLOADS_BUCKET configurado.');
    const s3 = new S3Client({ region: config.AWS_REGION });
    const res = await s3.send(new GetObjectCommand({ Bucket: config.UPLOADS_BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
  } else {
    throw new Error('Falta IMPORT_FILE (ruta local) o IMPORT_S3_KEY (clave en el bucket).');
  }
  return wb;
}

// ---------------------------------------------------------------------------
// Catalogo territorial: del nombre escrito a mano al codigo oficial
// ---------------------------------------------------------------------------

/** Quita lo que la gente antepone y el catalogo no lleva ("La Guacima", "Barrio San Jose"). */
const bare = (s: string) => norm(s).replace(/^(la|el|los|las|barrio|bo\.?)\s+/, '');

function resolveGeo(
  provinceName: string,
  cantonName: string,
  districtName: string,
): { provinceCode: string; cantonCode: string; districtCode: string } | string {
  const province = PROVINCES.find((p) => norm(p.name) === norm(provinceName));
  if (!province) return `provincia "${provinceName}" no existe`;
  const canton = province.cantons.find((c) => norm(c.name) === norm(cantonName));
  if (!canton) {
    return `el cantón "${cantonName}" no está en ${province.name} (opciones: ${province.cantons.map((c) => c.name).join(', ')})`;
  }
  const exact = canton.districts.find((d) => norm(d.name) === norm(districtName));
  const stripped = exact ?? canton.districts.find((d) => bare(d.name) === bare(districtName));
  // Ultimo recurso: un unico distrito que EMPIECE por lo escrito
  // ("San Isidro" -> "San Isidro de El General"). Si hay dos, no se adivina.
  const prefixed = canton.districts.filter((d) => bare(d.name).startsWith(bare(districtName)));
  const district = stripped ?? (prefixed.length === 1 ? prefixed[0] : undefined);
  if (!district) {
    return `el distrito "${districtName}" no está en ${canton.name} (opciones: ${canton.districts.map((d) => d.name).join(', ')})`;
  }
  return { provinceCode: province.code, cantonCode: canton.code, districtCode: district.code };
}

// ---------------------------------------------------------------------------
// Modelo de cada fila y su plan
// ---------------------------------------------------------------------------

type Kind = 'existente' | 'nuevo' | 'consolidado';

interface Row {
  kind: Kind;
  sheet: string;
  line: number;
  subLocker: string | null;
  name: string;
  idNumber: string;
  phone: string;
  email: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  /** Solo consolidados: la cuenta exclusiva del proveedor. */
  account?: { code: string; name: string; username: string; password: string; active: boolean };
  /** Lo que se hara (o por que no). */
  errors: string[];
  warnings: string[];
  skip?: string;
  /** Solo existentes: el destinatario que Helga tiene con ese sub-casillero. */
  helgaClientId?: string | null;
}

const label = (r: Row) => `${r.sheet} fila ${r.line} ${r.subLocker ?? '(sin sub-casillero)'} ${r.name}`;

function baseRow(kind: Kind, sheet: string, line: number, get: (k: string) => string): Row {
  const row: Row = {
    kind,
    sheet,
    line,
    subLocker: get('subLocker').toUpperCase() || null,
    name: get('name').replace(/\s+/g, ' ').trim(),
    idNumber: '',
    phone: '',
    email: '',
    provinceCode: '',
    cantonCode: '',
    districtCode: '',
    addressLine: get('address').replace(/\s+/g, ' ').trim(),
    errors: [],
    warnings: [],
  };
  if (!row.name) row.errors.push('sin nombre');

  const idNumber = idNumberSchema.safeParse(get('idNumber'));
  if (idNumber.success) row.idNumber = idNumber.data;
  else row.errors.push(`cédula "${get('idNumber')}": ${idNumber.error.issues[0]?.message}`);

  const phone = phoneSchema.safeParse(get('phone'));
  if (phone.success) row.phone = phone.data;
  else row.errors.push(`teléfono "${get('phone')}": ${phone.error.issues[0]?.message}`);

  const email = emailSchema.safeParse(get('email'));
  if (email.success) row.email = email.data;
  else row.errors.push(`correo "${get('email')}" inválido`);

  const geo = resolveGeo(get('province'), get('canton'), get('district'));
  if (typeof geo === 'string') row.errors.push(geo);
  else Object.assign(row, geo);

  if (!row.addressLine) row.errors.push('sin "Otras señas" (la dirección es obligatoria)');
  return row;
}

function parse(wb: ExcelJS.Workbook): { rows: Row[]; skipped: string[] } {
  const skipped: string[] = [];
  const rows: Row[] = [];

  // Primero los mayoristas: de ahi sale el correo de la cuenta principal, que es
  // como se reconoce la fila de HS Global en la hoja de clientes.
  const wholesale = readSheet(wb, 'Cuentas Mayoristas', {
    type: 'Tipo',
    subLocker: 'Casillero',
    name: 'A nombre de',
    username: 'Correo de la cuenta',
    password: 'Contrase',
    email: 'Correo facilitado',
    idNumber: 'Cedula',
    phone: 'Telefono',
    province: 'Provincia',
    canton: 'Canton',
    district: 'Distrito',
    address: 'Otras',
  });
  const principalUsernames = new Set<string>();
  for (const { line, get } of wholesale) {
    if (norm(get('type')) === 'principal') {
      principalUsernames.add(norm(get('username')));
      skipped.push(`Mayoristas fila ${line} ${get('subLocker')}: es la cuenta PRINCIPAL (vive en HELGA_ACCOUNTS).`);
      continue;
    }
    const row = baseRow('consolidado', 'Mayoristas', line, get);
    const username = get('username').trim().toLowerCase();
    const password = get('password');
    if (!row.subLocker) row.errors.push('sin código de casillero');
    if (!username) row.errors.push('sin correo de la cuenta Helga');
    if (!password) row.errors.push('sin contraseña Helga');
    row.account = { code: row.subLocker ?? '', name: row.name, username, password, active: true };
    rows.push(row);
  }

  const customers = readSheet(wb, 'Clientes HSGlobal', {
    subLocker: 'SubCasillero',
    name: 'Nombre',
    idNumber: 'Cedula',
    phone: 'Telefono',
    email: 'Correo',
    province: 'Provincia',
    canton: 'Canton',
    district: 'Distrito',
    address: 'Otras',
  });
  for (const { line, get } of customers) {
    if (principalUsernames.has(norm(get('email')))) {
      skipped.push(`Clientes fila ${line} ${get('subLocker')} ${get('name')}: es la cuenta principal, no un cliente.`);
      continue;
    }
    const sub = get('subLocker');
    const row = baseRow(sub ? 'existente' : 'nuevo', 'Clientes', line, get);
    if (row.subLocker && !row.subLocker.startsWith(`${helgaPrincipalAccountCode}S`)) {
      row.warnings.push(`el sub-casillero no es de la cuenta principal ${helgaPrincipalAccountCode}`);
    }
    rows.push(row);
  }

  // Repetidos dentro del propio Excel: el segundo no se puede cargar.
  const seen = new Map<string, Row>();
  for (const row of rows) {
    for (const key of [`correo ${row.email}`, `cédula ${row.idNumber}`, `casillero ${row.subLocker ?? ''}`]) {
      if (key.endsWith(' ')) continue;
      const first = seen.get(key);
      if (first) row.errors.push(`${key} repetido con ${first.sheet} fila ${first.line}`);
      else seen.set(key, row);
    }
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Validacion contra la base y contra Helga
// ---------------------------------------------------------------------------

async function checkDatabase(row: Row): Promise<void> {
  if (row.errors.length > 0) return;
  const [byEmail] = await db
    .select({ userId: users.id, idNumber: clients.idNumber })
    .from(users)
    .leftJoin(clients, eq(clients.userId, users.id))
    .where(eq(users.email, row.email))
    .limit(1);
  if (byEmail) {
    if (byEmail.idNumber === row.idNumber) row.skip = 'ya cargado (mismo correo y cédula)';
    else row.errors.push(`el correo ya existe en la base con otra cédula (${byEmail.idNumber ?? 'usuario de staff'})`);
    return;
  }
  const [byId] = await db.select({ code: clients.code }).from(clients).where(eq(clients.idNumber, row.idNumber)).limit(1);
  if (byId) row.errors.push(`la cédula ya pertenece al casillero ${byId.code} (con otro correo)`);
  if (row.subLocker) {
    const [bySub] = await db
      .select({ code: clients.code })
      .from(clients)
      .where(eq(clients.helgaSubLocker, row.subLocker))
      .limit(1);
    if (bySub) row.errors.push(`el sub-casillero ya pertenece al casillero ${bySub.code}`);
  }
  if (row.account) {
    const [byCode] = await db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(eq(providerAccounts.code, row.account.code))
      .limit(1);
    if (byCode) row.errors.push(`la cuenta ${row.account.code} ya existe en "Cuentas del proveedor"`);
  }
}

/** Mismas palabras, sin importar orden, tildes ni mayusculas. */
const sameName = (a: string, b: string) => norm(a).split(' ').sort().join(' ') === norm(b).split(' ').sort().join(' ');

async function checkHelga(row: Row): Promise<void> {
  if (row.errors.length > 0 || row.skip) return;

  if (row.kind === 'existente') {
    if (SKIP_HELGA) {
      row.helgaClientId = null;
      row.warnings.push('Helga no consultado (IMPORT_SKIP_HELGA): queda pending y sin id de destinatario');
      return;
    }
    const found = (await listHelgaRecipients({ search: row.subLocker!, priority: 'robot' })).filter(
      (r) => r.subLocker?.toUpperCase() === row.subLocker,
    );
    if (found.length === 0) return void row.errors.push('Helga no tiene ningún destinatario con ese sub-casillero');
    if (found.length > 1) {
      return void row.errors.push(`Helga tiene ${found.length} destinatarios con ese sub-casillero (${found.map((r) => r.id).join(', ')})`);
    }
    const recipient = found[0]!;
    if (!recipient.active) return void row.errors.push(`el destinatario ${recipient.id} está INACTIVO en Helga`);
    const helgaId = (recipient.idNumber ?? '').replace(/\D/g, '');
    if (helgaId !== row.idNumber) {
      return void row.errors.push(`la cédula no coincide: Excel ${row.idNumber}, Helga ${helgaId || '(vacía)'} (destinatario ${recipient.id})`);
    }
    if (recipient.name && !sameName(recipient.name, row.name)) {
      row.warnings.push(`el nombre en Helga es "${recipient.name}"`);
    }
    row.helgaClientId = recipient.id;
    return;
  }

  if (row.kind === 'nuevo') {
    if (SKIP_HELGA) return;
    const found = (await listHelgaRecipients({ search: row.idNumber, priority: 'robot' })).filter(
      (r) => r.active && (r.idNumber ?? '').replace(/\D/g, '') === row.idNumber,
    );
    if (found.length > 1) {
      row.errors.push(`Helga tiene ${found.length} destinatarios con esta cédula (${found.map((r) => r.id).join(', ')}); hay que elegir a mano`);
    } else if (found.length === 1) {
      row.warnings.push(`Helga ya lo tiene (destinatario ${found[0]!.id}, ${found[0]!.subLocker ?? 'sin sub-casillero'}): se adopta en vez de crearlo`);
    }
    return;
  }

  // Consolidado: se prueba la credencial pidiendo un token. En simulado el mock
  // acepta cualquier cosa, asi que probarla no diria nada.
  if (SKIP_HELGA || isHelgaSimulated()) return;
  const account: HelgaAccount = {
    code: row.account!.code,
    name: row.account!.name,
    username: row.account!.username,
    password: row.account!.password,
    clientId: null,
    oauthClientId: null,
    oauthClientSecret: null,
    appId: null,
  };
  try {
    await getAccessToken(account);
  } catch {
    row.account!.active = false;
    row.warnings.push('Helga rechazó las credenciales: la cuenta se carga APAGADA (corrígela en "Cuentas del proveedor")');
  }
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

async function nextClientCode(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<string> {
  const rows = (await tx.execute(`select nextval('hs_client_code_seq') as val`)) as unknown as Array<{ val: string }>;
  return `HS-${rows[0]!.val}`;
}

/** Hash inutilizable: bloquea el login hasta que el titular acepte la invitacion. */
const placeholderHash = async () => hash(randomBytes(32).toString('hex'));

async function insertExisting(row: Row, rateId: string, adminId: string | null): Promise<string> {
  const passwordHash = await placeholderHash();
  const linked = Boolean(row.helgaClientId);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: row.email,
        passwordHash,
        principal: Principal.Client,
        role: Role.Client,
        name: row.name,
        phone: row.phone,
        status: UserStatus.Activo,
      })
      .returning({ id: users.id });
    const code = await nextClientCode(tx);
    const [client] = await tx
      .insert(clients)
      .values({
        userId: user!.id,
        code,
        idNumber: row.idNumber,
        provinceCode: row.provinceCode,
        cantonCode: row.cantonCode,
        districtCode: row.districtCode,
        addressLine: row.addressLine,
        // Clientes de antes del sistema: ya los conoce HS Global, no hay nada que revisar.
        reviewStatus: ClientReviewStatus.Revisado,
        clientRateId: rateId,
        helgaClientId: row.helgaClientId ?? null,
        helgaSubLocker: row.subLocker,
        helgaSyncedAt: linked ? new Date() : null,
        helgaSyncStatus: linked ? HelgaSyncStatus.Synced : HelgaSyncStatus.Pending,
        helgaSyncAttempts: 0,
      })
      .returning({ id: clients.id });
    await tx.insert(clientProviderLinkEvents).values({
      clientId: client!.id,
      source: ProviderLinkSource.Manual,
      status: linked ? HelgaSyncStatus.Synced : HelgaSyncStatus.Pending,
      detail: linked
        ? `${ORIGIN}. Destinatario ${row.helgaClientId} (${row.subLocker}) ya existente en Helga.`
        : `${ORIGIN}. Sub-casillero ${row.subLocker} sin verificar en Helga.`,
      changes: {
        helgaClientId: { from: null, to: row.helgaClientId ?? null },
        subLocker: { from: null, to: row.subLocker },
      },
      createdBy: adminId,
    });
    return code;
  });
}

async function insertNew(row: Row): Promise<string> {
  // El alta normal: tarifa por defecto, op. D con los datos ofuscados y, si Helga
  // ya lo tenia, adopcion por cedula. Nace 'nuevo' como cualquier alta.
  const { code, clientId } = await authService.createClientAccount(
    { name: row.name, idNumber: row.idNumber, phone: row.phone, email: row.email, provinceCode: row.provinceCode, cantonCode: row.cantonCode, districtCode: row.districtCode, addressLine: row.addressLine },
    await placeholderHash(),
    ORIGIN,
  );
  await db.update(clients).set({ reviewStatus: ClientReviewStatus.Revisado }).where(eq(clients.id, clientId));
  return code;
}

async function insertConsolidated(row: Row, rateId: string, adminId: string | null): Promise<string> {
  const passwordHash = await placeholderHash();
  const account = row.account!;
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: row.email,
        passwordHash,
        principal: Principal.Client,
        role: Role.Client,
        name: row.name,
        phone: row.phone,
        status: UserStatus.Activo,
      })
      .returning({ id: users.id });
    const code = await nextClientCode(tx);
    // Mismo enlace que `createConsolidatedClient`: sin destinatario nuestro en
    // Helga, `synced`, y su "sub-casillero" es el codigo de SU cuenta.
    const [client] = await tx
      .insert(clients)
      .values({
        userId: user!.id,
        code,
        idNumber: row.idNumber,
        provinceCode: row.provinceCode,
        cantonCode: row.cantonCode,
        districtCode: row.districtCode,
        addressLine: row.addressLine,
        reviewStatus: ClientReviewStatus.Revisado,
        clientRateId: rateId,
        helgaClientId: null,
        helgaSubLocker: account.code,
        helgaSyncedAt: new Date(),
        helgaSyncStatus: HelgaSyncStatus.Synced,
        helgaSyncAttempts: 0,
      })
      .returning({ id: clients.id });
    await tx.insert(providerAccounts).values({
      code: account.code,
      name: account.name,
      username: account.username,
      passwordEncrypted: encryptSecret(account.password),
      consolidatedClientId: client!.id,
      active: account.active,
      lastImportError: account.active ? null : 'Helga rechazó las credenciales en la carga inicial.',
      createdBy: adminId,
    });
    await tx.insert(clientProviderLinkEvents).values({
      clientId: client!.id,
      source: ProviderLinkSource.Manual,
      status: HelgaSyncStatus.Synced,
      detail: `${ORIGIN}. Cliente consolidado de la cuenta ${account.code} (${account.name}).`,
      createdBy: adminId,
    });
    return code;
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const { rows, skipped } = parse(await loadWorkbook());

  // Lo que impide cargar NADA. En validacion se informa y se sigue revisando las
  // filas, para ver todos los problemas de una vez; al cargar, aborta.
  const blockers: string[] = [];
  if (!isHelgaEnabled() && !SKIP_HELGA) {
    blockers.push('Helga está apagado (HELGA_MODE=off): sin él no se verifican los sub-casilleros. En local usa IMPORT_SKIP_HELGA=1.');
  }
  const hasConsolidated = rows.some((r) => r.kind === 'consolidado');
  if (hasConsolidated && !secretsKeyConfigured()) {
    blockers.push('Falta la llave de cifrado de secretos: las contraseñas de las cuentas mayoristas no se pueden guardar.');
  }
  const [defaultRate] = await db.select({ id: clientRates.id }).from(clientRates).where(eq(clientRates.isDefault, true)).limit(1);
  const [consolidatedRate] = await db
    .select({ id: clientRates.id })
    .from(clientRates)
    .where(eq(clientRates.kind, ClientRateKind.Consolidada))
    .limit(1);
  if (!defaultRate) blockers.push('No hay tarifa de cliente por defecto. Corre el seed con tarifas (reset-db.ps1 -ConTarifas).');
  if (hasConsolidated && !consolidatedRate) blockers.push('No hay tarifa de tipo Consolidada para los mayoristas.');
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, Role.Admin)).limit(1);

  const helgaUsable = isHelgaEnabled() || SKIP_HELGA;
  console.log(`\nHelga: ${SKIP_HELGA ? 'NO consultado' : isHelgaSimulated() ? 'simulado' : 'real'}. Validando ${rows.length} filas...\n`);
  for (const row of rows) {
    await checkDatabase(row);
    if (!helgaUsable) continue;
    try {
      await checkHelga(row);
    } catch (err) {
      row.errors.push(`no se pudo consultar Helga: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ready = rows.filter((r) => r.errors.length === 0 && !r.skip);
  for (const s of skipped) console.log(`  [OMITIDA]   ${s}`);
  for (const row of rows) {
    const tag = row.errors.length > 0 ? '[ERROR]  ' : row.skip ? '[YA ESTÁ] ' : row.warnings.length > 0 ? '[AVISO]  ' : '[OK]     ';
    const plan =
      row.kind === 'existente'
        ? `enlazar destinatario ${row.helgaClientId ?? '?'}`
        : row.kind === 'nuevo'
          ? 'alta nueva en Helga'
          : `cuenta ${row.account?.code} + cliente consolidado${row.account?.active === false ? ' (cuenta APAGADA)' : ''}`;
    console.log(`  ${tag} ${label(row)}${row.errors.length === 0 && !row.skip ? `: ${plan}` : ''}`);
    for (const e of row.errors) console.log(`             x ${e}`);
    for (const w of row.warnings) console.log(`             ! ${w}`);
    if (row.skip) console.log(`             = ${row.skip}`);
  }

  const failed = rows.filter((r) => r.errors.length > 0).length;
  const already = rows.filter((r) => r.skip).length;
  console.log(`\nRESUMEN: ${ready.length} por cargar, ${already} ya cargados, ${failed} con error (no se cargan), ${skipped.length} omitidas.`);

  for (const b of blockers) console.log(`BLOQUEO: ${b}`);

  if (!CONFIRMED) {
    console.log('[validación] no se escribió nada.');
    return;
  }
  if (blockers.length > 0) throw new Error('hay bloqueos (arriba): no se cargó nada.');

  console.log('\nCargando...');
  let ok = 0;
  for (const row of ready) {
    try {
      const code =
        row.kind === 'existente'
          ? await insertExisting(row, defaultRate!.id, admin?.id ?? null)
          : row.kind === 'nuevo'
            ? await insertNew(row)
            : await insertConsolidated(row, consolidatedRate!.id, admin?.id ?? null);
      ok++;
      console.log(`  ${code}  ${label(row)}`);
    } catch (err) {
      console.error(`  FALLÓ ${label(row)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\nCargados: ${ok} de ${ready.length}. No se envió ningún correo.`);
  if (ok < ready.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[importar-clientes] falló:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
