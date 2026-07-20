/**
 * Valores fijos que viajan al proveedor Helga y derivacion del correo falso.
 * Fuente: docs/13-integracion-proveedor-helga.md §3.6 (regla dura del proyecto).
 *
 * Regla: hacia Helga viaja la IDENTIDAD real del cliente (nombre, apellidos y
 * cedula) pero NUNCA su CONTACTO ni su UBICACION. El telefono y la direccion son
 * siempre los de consolidacion de HS Global en Costa Rica, y el correo es
 * inventado a partir del real. Telefono, direccion y correo reales viven solo en
 * nuestra BD y jamas se propagan al proveedor.
 *
 * La identidad tiene que ser real por dos razones: el paquete se entrega contra
 * documento de identidad, y Helga exige que el nombre del destinatario sea unico
 * dentro de la cuenta (un nombre fijo solo permitiria un cliente).
 */
import { createHash } from 'node:crypto';

/**
 * Datos de consolidacion de HS Global: el CONTACTO y la UBICACION que sustituyen
 * a los del cliente. Ninguno depende del cliente. El nombre y la cedula del
 * destinatario NO salen de aqui: son los reales del cliente.
 *
 * `firstName`/`lastName` describen a la persona de contacto de HS Global; se
 * conservan como referencia del dato de negocio, pero la op. D ya no los usa.
 *
 * Nota: la ficha real de nuestra cuenta en el proveedor
 * (`GET /api/casillero/clientes`, 2026-07-20) trae otros valores para algunos
 * de estos campos: `codigo_casillero: "SJO008835"`, identificacion juridica
 * `3102869317`, telefono `72023637` y la direccion larga "200 MTS. DE LA
 * GUARDIA DE ASISTENCIA RURAL RIO SEGUNDO ALAJUELA". Mandan los valores de
 * negocio de esta constante; la diferencia queda anotada, no aplicada.
 */
export const HELGA_FIXED_RECIPIENT = {
  name: 'HS GLOBAL SERVICES',
  lockerCode: 'SJO0008835S016',
  idType: 'CÉDULA FÍSICA',
  idNumber: '2555775',
  firstName: 'Andy',
  lastName: 'Rodriguez',
  countryCode: 'CR',
  state: 'Alajuela',
  city: 'Río Segundo',
  address: 'Rio Segundo Alajuela',
  neighborhood: 'Rio Segundo',
  postalCode: '20109',
  mobilePhone: '70196535',
} as const;

/**
 * Tipo de identificacion de Helga para una persona fisica costarricense
 * (`tipo_de_identificacion_id: 1` = "CEDULA DE CIUDADANIA" en su catalogo).
 */
export const HELGA_ID_TYPE_CEDULA = 1;

/** Nombre partido como lo pide Helga (dos nombres + dos apellidos). */
export interface SplitName {
  firstName: string;
  secondName: string;
  lastName: string;
  secondLastName: string;
}

/**
 * Parte el `name` de una sola linea de nuestro registro en los cuatro campos de
 * Helga. Es una heuristica: asume el orden costarricense
 * `nombre(s) apellido apellido`, que es lo que pide el formulario de alta.
 *
 * - 4+ palabras: dos nombres y dos apellidos (el resto se acumula en el segundo
 *   apellido, para no perder informacion de nombres compuestos largos).
 * - 3 palabras: un nombre y dos apellidos.
 * - 2 palabras: un nombre y un apellido.
 * - 1 palabra: Helga exige `primer_apellido`, asi que se repite la unica que hay.
 *
 * TODO(13): si el alta pasa a pedir nombre y apellidos por separado, esta
 * heuristica sobra y hay que borrarla.
 */
export function splitPersonName(fullName: string): SplitName {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const [first = '', second = '', third = '', ...rest] = parts;

  if (parts.length >= 4) {
    return { firstName: first, secondName: second, lastName: third, secondLastName: rest.join(' ') };
  }
  if (parts.length === 3) {
    return { firstName: first, secondName: '', lastName: second, secondLastName: third };
  }
  if (parts.length === 2) {
    return { firstName: first, secondName: '', lastName: second, secondLastName: '' };
  }
  return { firstName: first, secondName: '', lastName: first, secondLastName: '' };
}

/**
 * Ids geograficos DE HELGA para la direccion fija. Helga no acepta los codigos
 * del catalogo de Costa Rica de `@courier/shared/geo`: usa su propia tabla.
 * Como la direccion es fija, basta resolverlos una sola vez.
 *
 * Resueltos en vivo (2026-07-20) desde `GET /api/casillero/clientes`, que
 * devuelve la ficha de nuestra propia cuenta: Alajuela / Río Segundo.
 */
export const HELGA_FIXED_GEO = {
  departamentoId: 163 as number | null,
  ciudadId: 40933 as number | null,
};

/**
 * Cuenta de HS Global en Helga bajo la que cuelgan los destinatarios (campo
 * `cliente_id` de la operacion D).
 *
 * Resuelto en vivo (2026-07-20): `GET /api/casillero/clientes` -> `datos.id`.
 * El proveedor conoce ese casillero como `SJO008835`.
 */
export const HELGA_ACCOUNT_CLIENT_ID: number | null = 7536;

/** Dominio propio sobre el que se inventan los correos que ve el proveedor. */
export const HELGA_FAKE_EMAIL_DOMAIN = 'hsglobalcliente.com';

/**
 * Correo falso, determinista y unico, derivado del correo real del cliente.
 * Determinista: el mismo cliente siempre produce el mismo correo, para que un
 * reintento no cree un destinatario duplicado en Helga. Unico: Helga valida que
 * el correo no exista, y el hash del correo real evita colisiones entre dos
 * clientes cuya parte local coincide (ana@gmail.com y ana@hotmail.com).
 *
 * TODO(13): el patron de referencia de la UI del proveedor es
 * `nombre+hsglobal@hsglobalcliente.com`. Usamos un punto en vez de `+` porque
 * varios validadores rechazan el sufijo `+`; confirmar cual acepta Helga.
 */
export function helgaEmailFor(realEmail: string): string {
  const normalized = realEmail.trim().toLowerCase();
  const local = (normalized.split('@')[0] ?? 'cliente').replace(/[^a-z0-9]/g, '').slice(0, 24) || 'cliente';
  const fingerprint = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${local}.${fingerprint}@${HELGA_FAKE_EMAIL_DOMAIN}`;
}
