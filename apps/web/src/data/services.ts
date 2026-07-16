/*
  Catálogo de servicios del sitio público. Contenido estático, alineado con
  las respuestas de `faq.ts` (ambos deben describir la misma oferta). Cuando
  exista la API, esto puede moverse a contenido gestionable; por ahora es
  fuente única para la sección de servicios del landing.

  Los nombres provienen del listado oficial del cliente. Las descripciones son
  redacción propia con el tono del servicio (el cliente no las entregó): por eso
  no afirman plazos, precios ni porcentajes concretos.
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
    id: 'recoleccion-usa',
    icon: 'truck',
    name: 'Servicio de recolección en USA (LTL & FTL)',
    tag: null,
    short: 'Recogemos tu carga en cualquier punto de Estados Unidos, sea un pallet o un camión completo.',
    desc: 'Coordinamos la recolección directamente con tu proveedor en Estados Unidos y movemos la carga hasta nuestro centro de consolidación. Trabajamos en modalidad LTL, cuando tu carga comparte camión y pagas solo por lo que ocupa, y FTL, cuando el volumen justifica un camión dedicado.',
    points: ['Recolección en el punto de origen', 'LTL: camión compartido', 'FTL: camión completo y dedicado'],
  },
  {
    id: 'consolidacion',
    icon: 'layers',
    name: 'Servicio de consolidación (Miami & Costa Rica)',
    tag: null,
    short: 'Agrupamos tus compras y embarques en nuestros centros de Miami y Costa Rica.',
    desc: 'Recibimos tus paquetes y embarques en nuestras bodegas de Miami y Costa Rica, los agrupamos en un solo envío y los preparamos para el despacho. Un solo flete, un solo trámite y menos manejo por unidad.',
    points: ['Bodegas en Miami y Costa Rica', 'Reempaque y agrupación de envíos', 'Un solo despacho por embarque'],
  },
  {
    id: 'transporte',
    icon: 'plane',
    name: 'Transporte Aéreo y Marítimo',
    tag: null,
    short: 'Elige velocidad o economía: despachamos tu carga por aire o por mar.',
    desc: 'Movemos tu carga por vía aérea cuando el tiempo manda, y por vía marítima cuando el volumen pesa más que la urgencia, en LCL para compartir contenedor o FCL para un contenedor completo. Te ayudamos a elegir la modalidad que mejor equilibra costo y tiempo.',
    points: ['Carga aérea para envíos urgentes', 'Marítimo LCL y FCL', 'Asesoría para elegir la modalidad'],
  },
  {
    id: 'paqueteria',
    icon: 'package',
    name: 'Paquetería',
    tag: null,
    short: 'Envíos de paquetes nacionales e internacionales, con opción puerta a puerta.',
    desc: 'Movemos tus paquetes dentro del país y hacia el exterior con la red de transporte que mejor se ajuste a cada destino. Ideal para envíos puntuales que no requieren consolidación ni contenedor.',
    points: ['Cobertura nacional e internacional', 'Opción puerta a puerta', 'Seguimiento en cada etapa'],
  },
  {
    id: 'agencia-aduanal',
    icon: 'file',
    name: 'Agencia Aduanal',
    tag: null,
    short: 'Nacionalizamos tu carga y respondemos por la documentación.',
    desc: 'Nuestro equipo se encarga de la clasificación arancelaria, la liquidación de tributos y el trámite ante la aduana, para que tu carga no se quede detenida por un documento.',
    points: ['Clasificación arancelaria', 'Liquidación de tributos', 'Trámite y liberación ante la aduana'],
  },
  {
    id: 'consultoria-logistica',
    icon: 'clipboard',
    name: 'Consultoría Logística',
    tag: null,
    short: 'Revisamos tu operación y te proponemos una ruta más eficiente.',
    desc: 'Analizamos tus rutas, volúmenes y tiempos para proponerte una estructura de envíos más eficiente: qué consolidar, por dónde despachar y en qué modalidad. Te acompaña un equipo que conoce el corredor y opera todos los días en él.',
    points: ['Diagnóstico de tu operación actual', 'Diseño de rutas y modalidades', 'Acompañamiento de un asesor'],
  },
  {
    id: 'seguro-carga',
    icon: 'shield',
    name: 'Seguro de Carga',
    tag: null,
    short: 'Protege tu mercancía frente a imprevistos durante el transporte.',
    desc: 'Ofrecemos opciones de seguro sobre el valor declarado de tu carga, para cubrirte ante pérdida o daño durante el transporte. Se contrata por envío, sin pólizas anuales.',
    points: ['Cobertura sobre el valor declarado', 'Se contrata por envío', 'Aplica a aéreo y marítimo'],
  },
];
