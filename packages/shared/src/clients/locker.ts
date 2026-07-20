/**
 * Casillero en Miami: la direccion que el cliente usa para comprar en USA.
 * Fuente: "Requerimientos Parte 2 - Portal Cliente" L36-40.
 *
 * El manual describe la direccion como la del casillero MAESTRO de HS Global
 * (`SJO008835`) al que se le agrega el identificador del casillero del cliente.
 * Es decir: todos los clientes comparten domicilio fisico y lo que los distingue
 * es esa linea. Por eso la direccion es una constante del sistema y no un campo
 * por cliente: guardar la misma calle mil veces solo crea mil formas de que se
 * desincronice.
 */

/**
 * Identificador del casillero maestro de HS Global ante el proveedor. Constante
 * del negocio ("El identificador único del casillero siempre es: SJO008835").
 */
export const MASTER_LOCKER_ID = 'SJO008835';

/**
 * Direccion fisica de la bodega en Miami.
 *
 * TODO(casillero): confirmar los datos reales con HS Global — el manual lo deja
 * pendiente de forma explicita ("confirmar datos con el cliente"). Mientras
 * tanto se muestran estos valores, que son los del prototipo. Cuando lleguen los
 * definitivos se cambian AQUI y toda la web los toma.
 */
export const MIAMI_WAREHOUSE = {
  addressLine1: '8200 NW 30th Terrace',
  addressLine2: 'Suite 100',
  city: 'Doral',
  state: 'FL',
  zipCode: '33122',
  country: 'USA',
  phone: '+1 (305) 000-0000',
} as const;

/**
 * Identificador del casillero del cliente en el formato del manual: `HS` + 7
 * digitos (su ejemplo literal es HS0000001).
 *
 * El codigo que guarda la BD es `HS-1042` (con guion, sin relleno) porque es la
 * clave de negocio interna. Esta funcion solo cambia su PRESENTACION para la
 * etiqueta de envio, donde el formato importa: se toman los digitos del codigo y
 * se rellenan. Nada se migra en BD.
 */
export function formatLockerCode(clientCode: string): string {
  const digits = clientCode.replace(/\D/g, '');
  return `HS${digits.padStart(7, '0')}`;
}

/** Una linea de la direccion de envio, con su etiqueta, lista para mostrar y copiar. */
export interface LockerAddressLine {
  label: string;
  value: string;
}

/**
 * Identificador que el cliente escribe al comprar.
 *
 * El bueno es el `sub_casillero` que asigna el proveedor (`SJO008835S033`): es
 * el unico que su operador reconoce para saber de quien es cada paquete dentro
 * de la cuenta consolidada de HS Global.
 *
 * El compuesto `SJO008835 HS0001042` es un FALLBACK para los casilleros creados
 * mientras la integracion estuvo apagada, que aun no tienen sub-casillero. No es
 * equivalente: el proveedor no conoce nuestro codigo interno.
 *
 * TODO(13): cuando todos los casilleros esten sincronizados, este fallback
 * sobra y `subLocker` pasa a ser obligatorio.
 */
function lockerIdFor(clientCode: string, subLocker?: string | null): string {
  return subLocker ?? `${MASTER_LOCKER_ID} ${formatLockerCode(clientCode)}`;
}

/**
 * Direccion completa de envio del cliente, en el orden en que se llena un
 * formulario de compra en USA. Punto UNICO donde se arma esa direccion: la usan
 * la pantalla de Casillero y cualquier correo que la incluya.
 */
export function lockerAddressFor(
  clientName: string,
  clientCode: string,
  subLocker?: string | null,
): LockerAddressLine[] {
  const locker = lockerIdFor(clientCode, subLocker);
  return [
    { label: 'Nombre', value: `${clientName} — ${locker}` },
    { label: 'Dirección', value: MIAMI_WAREHOUSE.addressLine1 },
    { label: 'Apto / Suite', value: `${MIAMI_WAREHOUSE.addressLine2} — ${locker}` },
    { label: 'Ciudad', value: MIAMI_WAREHOUSE.city },
    { label: 'Estado', value: MIAMI_WAREHOUSE.state },
    { label: 'Código postal', value: MIAMI_WAREHOUSE.zipCode },
    { label: 'País', value: MIAMI_WAREHOUSE.country },
    { label: 'Teléfono', value: MIAMI_WAREHOUSE.phone },
  ];
}
