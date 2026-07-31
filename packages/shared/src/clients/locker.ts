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
 *
 * NO se le muestra al cliente: la dirección que él pega en el checkout lleva
 * nuestro código `HS…` (ver `lockerIdFor`). Esta constante queda para lo que
 * mira hacia el proveedor.
 */
export const MASTER_LOCKER_ID = 'SJO008835';

/**
 * Direccion fisica de la bodega en Miami.
 *
 * TODO(casillero): SIGUEN SIENDO VALORES DE RELLENO. Confirmar con HS Global; el
 * manual lo deja pendiente de forma explicita ("confirmar datos con el cliente").
 * Cuando lleguen los definitivos se cambian AQUI y toda la web los toma.
 *
 * Dos avisos, porque esta es la direccion que el cliente copia al comprar y un
 * error aqui manda paquetes a ninguna parte:
 *
 * 1. NO se puede sacar del API del proveedor. Comprobado el 2026-07-26: su ficha
 *    de cuenta solo trae la direccion de Costa Rica y no expone ninguna ruta de
 *    oficinas ni bodegas (docs/13 §6).
 * 2. Estos valores NO COINCIDEN con los del prototipo, que decia
 *    "8200 NW 27th St, Suite 140". Al menos uno de los dos esta mal, y el
 *    telefono es de relleno en ambos.
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
 * Identificador que el cliente escribe al comprar: SIEMPRE el codigo de HS
 * Global (`HS0001042`), nunca el `sub_casillero` del proveedor
 * (`SJO008835S033`).
 *
 * Es una decision de producto: de cara al usuario final el casillero es el
 * nuestro. El codigo del proveedor es un detalle de la cuenta consolidada que el
 * cliente no tiene por que conocer, y mostrarle dos identificadores distintos
 * (uno en el portal, otro en los correos o en el mostrador) es justo lo que hace
 * que pegue el equivocado en el checkout.
 *
 * El `sub_casillero` sigue guardado y sigue siendo la llave contra Helga: lo usa
 * la sincronizacion y el panel, no la etiqueta de envio.
 */
function lockerIdFor(clientCode: string): string {
  return formatLockerCode(clientCode);
}

/**
 * Direccion completa de envio del cliente, en el orden en que se llena un
 * formulario de compra en USA. Punto UNICO donde se arma esa direccion: la usan
 * la pantalla de Casillero y cualquier correo que la incluya.
 */
export function lockerAddressFor(clientName: string, clientCode: string): LockerAddressLine[] {
  const locker = lockerIdFor(clientCode);
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
