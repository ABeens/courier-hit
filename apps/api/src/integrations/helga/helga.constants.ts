/**
 * Valores fijos que viajan al proveedor Helga y derivacion del correo falso.
 * Fuente: docs/13-integracion-proveedor-helga.md §3.6 (regla dura del proyecto).
 *
 * Regla: el destinatario que registramos en Helga NO son los datos reales del
 * cliente. Es SIEMPRE la direccion de consolidacion de HS Global en Costa Rica,
 * y el correo es inventado a partir del real. El contacto real del cliente vive
 * solo en nuestra BD y jamas se propaga al proveedor.
 */
import { createHash } from 'node:crypto';

/**
 * Datos de consolidacion de HS Global. Ninguno depende del cliente.
 *
 * TODO(13): confirmar contra la captura de la UI del proveedor (los "recuadros
 * en rojo") que esta es la lista completa y que ningun otro campo varia por
 * cliente. Hoy lo unico variable es `email` (ver `helgaEmailFor`).
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
 * Ids geograficos DE HELGA para la direccion fija. Helga no acepta los codigos
 * del catalogo de Costa Rica de `@courier/shared/geo`: usa su propia tabla.
 * Como la direccion es fija, basta resolverlos una sola vez.
 *
 * TODO(13): resolver contra el proveedor `departamento_id` (Alajuela) y
 * `ciudad_id` (Río Segundo) y fijarlos aqui. Sin ellos la operacion D falla con
 * 422; por eso `HELGA_ENABLED` viene apagado por defecto.
 */
export const HELGA_FIXED_GEO = {
  departamentoId: null as number | null,
  ciudadId: null as number | null,
};

/**
 * Cuenta de HS Global en Helga bajo la que cuelgan los destinatarios (campo
 * `cliente_id` de la operacion D).
 *
 * TODO(13): confirmar con el proveedor el `cliente_id` que corresponde al
 * casillero `SJO0008835S016`.
 */
export const HELGA_ACCOUNT_CLIENT_ID: number | null = null;

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
