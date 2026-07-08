/*
  Catálogo de servicios del sitio público. Contenido estático,
  portado de DATA.SERVICES del prototipo. Cuando exista la API,
  esto puede moverse a contenido gestionable; por ahora es fuente
  única para el landing y la página de servicios.
*/
export type Service = {
  id: string;
  icon: string;
  name: string;
  tag: string | null;
  short: string;
  desc: string;
  points: string[];
};

export const SERVICES: Service[] = [
  {
    id: 'casillero',
    icon: 'box',
    name: 'Casillero en Miami',
    tag: 'El más popular',
    short: 'Tu dirección propia en EE. UU. para comprar en cualquier tienda y recibir en casa.',
    desc: 'Te asignamos una dirección física en Miami al registrarte. Compra en Amazon, eBay, SHEIN o cualquier tienda de EE. UU. y envía a tu casillero. Nosotros consolidamos, procesamos y despachamos hacia tu país.',
    points: ['Dirección de Miami al instante', 'Sin cuota mensual', 'Consolidación de paquetes gratis 30 días'],
  },
  {
    id: 'consolidacion',
    icon: 'layers',
    name: 'Consolidación de paquetes',
    tag: null,
    short: 'Junta varias compras en un solo envío y paga menos flete.',
    desc: 'Cuando esperas varios paquetes, los agrupamos en una sola caja optimizada. Menos peso volumétrico, menos flete, un solo trámite aduanero.',
    points: ['Hasta 60% de ahorro en flete', 'Reempaque optimizado', 'Fotos antes de despachar'],
  },
  {
    id: 'aereo',
    icon: 'plane',
    name: 'Carga aérea exprés',
    tag: null,
    short: 'Entrega rápida puerta a puerta con seguimiento en tiempo real.',
    desc: 'Para lo urgente. Despacho aéreo con tiempos de 3 a 6 días hábiles, tracking en vivo y gestión aduanera incluida.',
    points: ['3–6 días hábiles', 'Tracking en vivo', 'Gestión aduanera incluida'],
  },
  {
    id: 'maritimo',
    icon: 'ship',
    name: 'Carga marítima',
    tag: 'Mejor precio',
    short: 'La opción más económica para volúmenes grandes y mudanzas.',
    desc: 'Ideal para compras voluminosas, equipos o mudanzas. Tarifa por volumen, ruta marítima consolidada y manejo completo de documentación.',
    points: ['Tarifa por volumen', 'Sin límite de peso', 'Ideal para mudanzas'],
  },
  {
    id: 'compras',
    icon: 'cart',
    name: 'Servicio de compra asistida',
    tag: null,
    short: '¿La tienda no acepta tu tarjeta? Compramos por ti.',
    desc: 'Si una tienda no acepta tarjetas internacionales o no envía a casilleros, nuestro equipo realiza la compra por ti y la gestiona hasta tu puerta.',
    points: ['Compramos en tu nombre', 'Comisión transparente', 'Soporte de un asesor'],
  },
];
