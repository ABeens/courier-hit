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
 * SI se le muestra al cliente: va literal en la segunda linea de la direccion
 * ("Suite 700 SJO 008835"), separado en dos bloques porque asi lo pide el
 * negocio. La cadena sin espacio es la que mira hacia el proveedor.
 */
export const MASTER_LOCKER_ID = 'SJO008835';

/**
 * Direccion fisica de la bodega en Miami. Datos DEFINITIVOS confirmados por HS
 * Global (2026-08-08); ya no son valores de relleno.
 *
 * Esta es la direccion que el cliente copia al comprar y un error aqui manda
 * paquetes a ninguna parte: cambiarla solo contra confirmacion escrita del
 * negocio. NO se puede sacar del API del proveedor (comprobado el 2026-07-26:
 * su ficha de cuenta solo trae la direccion de Costa Rica, docs/13 §6).
 *
 * `addressLine2` lleva el casillero maestro incrustado (MASTER_LOCKER_ID con un
 * espacio) porque el negocio lo dicta como una sola linea de formulario: es el
 * campo "Apto / Suite" que el cliente pega tal cual en el checkout.
 */
export const MIAMI_WAREHOUSE = {
  addressLine1: '1350 NW 121 ST Ave',
  addressLine2: 'Suite 700 SJO 008835',
  city: 'Miami',
  state: 'Florida',
  zipCode: '33182-1542',
  country: 'USA',
  phone: '+1 305 714 0023',
} as const;

/**
 * Identificador del casillero del cliente en el formato del manual: `HS` + 7
 * digitos (su ejemplo literal es HS0000001).
 *
 * El codigo que guarda la BD es `HS-1000` (con guion, sin relleno) porque es la
 * clave de negocio interna. Esta funcion solo cambia su PRESENTACION: se toman
 * los digitos del codigo y se rellenan. Nada se migra en BD.
 *
 * Pasa por aqui TODO lo que ve el cliente (direccion de envio, badge de "Mi
 * casillero", perfil, menu de cuenta, registro). El `HS-1000` crudo queda para
 * el panel interno. La regla es: el cliente lee un solo numero. Antes convivian
 * los dos formatos en la misma pantalla -- el badge decia `HS-1000` y la linea
 * de Nombre `HS0001000` -- que es justo lo que hace que pegue el equivocado.
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
 * Global (`HS0001000`), nunca el `sub_casillero` del proveedor
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
 * Direccion de la bodega SIN cliente, para la web publica (landing, FAQ) donde
 * todavia no hay casillero asignado. Mismas lineas, misma fuente.
 */
export function warehouseAddressLines(): string[] {
  return [
    MIAMI_WAREHOUSE.addressLine1,
    MIAMI_WAREHOUSE.addressLine2,
    `${MIAMI_WAREHOUSE.city}, ${MIAMI_WAREHOUSE.state} ${MIAMI_WAREHOUSE.zipCode}`,
    `${MIAMI_WAREHOUSE.country} · ${MIAMI_WAREHOUSE.phone}`,
  ];
}

/**
 * Direccion completa de envio del cliente, en el orden en que se llena un
 * formulario de compra en USA. Punto UNICO donde se arma esa direccion: la usan
 * la pantalla de Casillero y cualquier correo que la incluya.
 */
export function lockerAddressFor(clientName: string, clientCode: string): LockerAddressLine[] {
  const locker = lockerIdFor(clientCode);
  return [
    { label: 'Nombre', value: `${clientName} ${locker}` },
    { label: 'Dirección', value: MIAMI_WAREHOUSE.addressLine1 },
    // La suite NO lleva el codigo del cliente: el negocio la define fija
    // ("Suite 700 SJO 008835"). Lo unico que distingue al destinatario es la
    // linea de Nombre.
    { label: 'Apto / Suite', value: MIAMI_WAREHOUSE.addressLine2 },
    { label: 'Ciudad', value: MIAMI_WAREHOUSE.city },
    { label: 'Estado', value: MIAMI_WAREHOUSE.state },
    { label: 'Código postal', value: MIAMI_WAREHOUSE.zipCode },
    { label: 'País', value: MIAMI_WAREHOUSE.country },
    { label: 'Teléfono', value: MIAMI_WAREHOUSE.phone },
  ];
}
