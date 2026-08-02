/*
  Contenido de las páginas legales del sitio público (/legal/*).

  Se guarda como datos y no dentro del .astro para que las páginas legales
  compartan una misma plantilla de lectura (`components/legal/LegalDoc.astro`:
  índice + secciones numeradas) y para que el texto se pueda revisar sin tocar
  el marcado.

  OJO: estos textos son una base operativa redactada a partir de cómo funciona
  el servicio (casillero en Miami, consolidado aéreo/marítimo, aduana, seguro) y
  de qué datos trata realmente el sistema. No han pasado revisión legal: antes
  de publicar debe validarlos el abogado de HS Global y confirmarse la razón
  social, el domicilio y los datos de contacto.
*/
export type LegalBlock =
  | { type: 'p'; text: string }
  | { type: 'list'; items: string[] };

export type LegalSection = {
  /** Ancla del índice lateral; debe ser única dentro del documento. */
  id: string;
  title: string;
  blocks: LegalBlock[];
};

/** Fechas de la última revisión de cada texto (se muestran en el encabezado). */
export const TERMS_UPDATED = '28 de julio de 2026';
export const PRIVACY_UPDATED = '28 de julio de 2026';

export const TERMS: LegalSection[] = [
  {
    id: 'aceptacion',
    title: 'Aceptación de los términos',
    blocks: [
      {
        type: 'p',
        text: 'Estos Términos de uso regulan el acceso y el uso de los servicios de HS Global Services ("HS Global", "nosotros"): el casillero en Miami, el transporte internacional de paquetería y carga consolidada, la gestión aduanera y los servicios complementarios contratados a través del sitio web y del portal de clientes.',
      },
      {
        type: 'p',
        text: 'Al crear una cuenta, solicitar un casillero, prealertar un paquete o contratar cualquiera de nuestros servicios, declaras que leíste y aceptas estos términos. Si no estás de acuerdo con ellos, no debes usar el servicio.',
      },
    ],
  },
  {
    id: 'definiciones',
    title: 'Definiciones',
    blocks: [
      { type: 'p', text: 'Para efectos de este documento:' },
      {
        type: 'list',
        items: [
          'Casillero: dirección en Miami asignada a tu cuenta para recibir compras hechas en tiendas de Estados Unidos.',
          'Prealerta: aviso que registras en el portal antes de que el paquete llegue a bodega, con la tienda, el número de rastreo, la descripción y el valor declarado.',
          'Paquete: bulto recibido en bodega a nombre de tu casillero.',
          'Envío: uno o varios paquetes procesados y despachados hacia el destino.',
          'Valor declarado: valor comercial de la mercancía que tú declaras, respaldado por la factura de compra.',
        ],
      },
    ],
  },
  {
    id: 'cuenta',
    title: 'Registro y cuenta',
    blocks: [
      {
        type: 'p',
        text: 'Para usar el casillero debes registrarte y ser mayor de edad. La información que entregues (nombre, identificación, dirección de entrega, teléfono y correo) debe ser verdadera, completa y estar actualizada. La usamos para identificarte ante la aduana, coordinar la entrega y contactarte por el estado de tus envíos.',
      },
      {
        type: 'p',
        text: 'Eres responsable de la confidencialidad de tu contraseña y de toda la actividad que ocurra en tu cuenta. Si detectas un acceso no autorizado, avísanos de inmediato.',
      },
      {
        type: 'p',
        text: 'La cuenta es personal e intransferible: el casillero no puede cederse ni usarse para recibir mercancía de terceros sin autorización previa de HS Global.',
      },
    ],
  },
  {
    id: 'casillero',
    title: 'Uso del casillero',
    blocks: [
      {
        type: 'p',
        text: 'El casillero es gratuito: no cobramos membresía ni exigimos un mínimo de carga para mantenerlo abierto. Solo pagas por los envíos que despaches y por los servicios que contrates.',
      },
      {
        type: 'p',
        text: 'Al recibir un paquete lo registramos, lo pesamos y lo medimos. Solo se admite mercancía dirigida al número de casillero asignado a tu cuenta. Un paquete que llegue sin identificación suficiente queda retenido hasta que podamos asociarlo a un cliente.',
      },
      {
        type: 'p',
        text: 'HS Global puede abrir e inspeccionar un paquete cuando la ley lo exija, cuando la autoridad aduanera lo solicite o cuando exista sospecha razonable de que su contenido está restringido o mal declarado.',
      },
    ],
  },
  {
    id: 'prealerta',
    title: 'Prealerta y declaración de contenido',
    blocks: [
      {
        type: 'p',
        text: 'Debes prealertar tus compras y adjuntar la factura. La prealerta es lo que permite clasificar la mercancía, calcular los tributos y despachar sin demoras.',
      },
      {
        type: 'p',
        text: 'Declarar un contenido o un valor distinto al real es responsabilidad exclusiva del cliente. Las multas, los recargos, las retenciones y los decomisos que se deriven de una declaración inexacta corren por tu cuenta.',
      },
    ],
  },
  {
    id: 'restringidas',
    title: 'Mercancías restringidas y prohibidas',
    blocks: [
      {
        type: 'p',
        text: 'No transportamos mercancía cuyo envío esté prohibido por la legislación de origen, de tránsito o de destino, ni por las políticas de las aerolíneas y navieras. Entre otras:',
      },
      {
        type: 'list',
        items: [
          'Armas, municiones, explosivos y material inflamable o corrosivo.',
          'Drogas, estupefacientes y sustancias de uso controlado sin permiso.',
          'Dinero en efectivo, títulos valores, joyas y metales preciosos.',
          'Animales vivos, restos humanos y material biológico.',
          'Productos falsificados o que infrinjan derechos de propiedad intelectual.',
          'Mercancía que requiera permiso sanitario, fitosanitario o de otra autoridad y que no lo tenga.',
        ],
      },
      {
        type: 'p',
        text: 'Otras categorías (baterías de litio, líquidos, aerosoles, medicamentos, alimentos, equipos de telecomunicaciones) están restringidas y solo se transportan bajo condiciones especiales, confirmadas previamente por nuestro equipo. Si un paquete infringe esta cláusula, HS Global puede rechazarlo, retenerlo, reportarlo a la autoridad competente o disponer de él, sin obligación de indemnizar y sin devolución de los cargos ya pagados.',
      },
    ],
  },
  {
    id: 'tarifas',
    title: 'Tarifas, peso y facturación',
    blocks: [
      {
        type: 'p',
        text: 'El costo del envío se calcula sobre el peso facturable, que es el mayor entre el peso real y el peso volumétrico del bulto, según la modalidad contratada (paquetería, consolidado aéreo o marítimo). A ese valor se suman los servicios adicionales que solicites y los cargos de terceros que apliquen.',
      },
      {
        type: 'p',
        text: 'Las tarifas vigentes se publican en el portal y pueden cambiar. El cambio no afecta a los envíos ya despachados. Las cotizaciones tienen la vigencia que se indique en cada caso.',
      },
      {
        type: 'p',
        text: 'La liberación y la entrega del envío están sujetas al pago total de los cargos. Un envío con saldo pendiente permanece en bodega y puede generar cargos por almacenaje.',
      },
    ],
  },
  {
    id: 'aduana',
    title: 'Aduana, impuestos y tributos',
    blocks: [
      {
        type: 'p',
        text: 'Los impuestos, aranceles, tasas y demás tributos que cause la importación son responsabilidad del cliente y se liquidan según la normativa vigente en el país de destino, sobre el valor declarado y la clasificación arancelaria de la mercancía.',
      },
      {
        type: 'p',
        text: 'Al usar el servicio autorizas a HS Global, o al agente aduanal que designe, a actuar en tu nombre para los trámites de importación y a presentar la documentación necesaria ante la autoridad. Si la autoridad exige un documento, un permiso o una aclaración adicional, debes aportarlo dentro del plazo que se te indique.',
      },
      {
        type: 'p',
        text: 'Los tiempos de inspección, aforo o retención por parte de la autoridad no son imputables a HS Global y no generan devolución del flete.',
      },
    ],
  },
  {
    id: 'tiempos',
    title: 'Tiempos de tránsito y entrega',
    blocks: [
      {
        type: 'p',
        text: 'Los tiempos publicados son estimados y se cuentan desde el cierre del consolidado, no desde la compra en la tienda. Pueden variar por frecuencia de vuelos o zarpes, disponibilidad de espacio, procesos aduaneros, clima, fuerza mayor o cobertura de la zona de entrega.',
      },
      {
        type: 'p',
        text: 'La entrega se hace en la dirección registrada en tu cuenta. Si no hay quien reciba, se coordina un nuevo intento; los intentos adicionales pueden generar un cargo. Mantener la dirección actualizada es responsabilidad tuya.',
      },
    ],
  },
  {
    id: 'seguro',
    title: 'Seguro y límite de responsabilidad',
    blocks: [
      {
        type: 'p',
        text: 'Ofrecemos seguro de carga opcional. Si no contratas seguro, la responsabilidad de HS Global por pérdida o daño se limita al monto mínimo previsto por la normativa de transporte aplicable, calculado sobre el peso del bulto afectado.',
      },
      {
        type: 'p',
        text: 'No respondemos por daños derivados del embalaje inadecuado del remitente, por el desgaste propio de la mercancía, por defectos de fábrica, ni por lucro cesante, pérdida de oportunidad o cualquier daño indirecto.',
      },
      {
        type: 'p',
        text: 'Los reclamos por faltantes o daño visible deben presentarse al momento de la entrega y, en todo caso, dentro de los cinco (5) días hábiles siguientes, con el soporte fotográfico y la factura de compra.',
      },
    ],
  },
  {
    id: 'abandono',
    title: 'Almacenaje y abandono',
    blocks: [
      {
        type: 'p',
        text: 'Los paquetes tienen un periodo de almacenamiento gratuito en bodega, informado en el portal. Superado ese plazo se genera un cargo diario por almacenaje.',
      },
      {
        type: 'p',
        text: 'La mercancía que permanezca sin instrucciones, sin pago o sin retirar durante más de noventa (90) días se considera abandonada y HS Global podrá disponer de ella para cubrir los costos pendientes, previo aviso al correo registrado.',
      },
    ],
  },
  {
    id: 'datos',
    title: 'Datos personales',
    blocks: [
      {
        type: 'p',
        text: 'Tratamos tus datos personales para prestar el servicio, cumplir obligaciones aduaneras y contactarte sobre tus envíos. El detalle de qué datos recogemos, con qué finalidad y cómo ejercer tus derechos está en la Política de privacidad, que forma parte integral de estos términos.',
      },
    ],
  },
  {
    id: 'cambios',
    title: 'Cambios en el servicio y en los términos',
    blocks: [
      {
        type: 'p',
        text: 'Podemos modificar estos términos para reflejar cambios en el servicio, en las tarifas o en la normativa. La versión vigente es siempre la publicada en esta página, con su fecha de actualización. Si el cambio es sustancial, lo avisaremos por el portal o por correo. Seguir usando el servicio después de la publicación implica aceptar la nueva versión.',
      },
      {
        type: 'p',
        text: 'HS Global puede suspender o cancelar una cuenta que incumpla estos términos, que use el casillero para fines ilícitos o que mantenga saldos vencidos.',
      },
    ],
  },
  {
    id: 'ley',
    title: 'Ley aplicable y contacto',
    blocks: [
      {
        type: 'p',
        text: 'Estos términos se rigen por la legislación de la República de Costa Rica y cualquier controversia se somete a sus tribunales, sin perjuicio de los derechos que la ley reconozca al consumidor.',
      },
      {
        type: 'p',
        text: 'Para dudas sobre este documento escríbenos a servicioalcliente@hsglobal-services.com o desde la página de contacto.',
      },
    ],
  },
];

export const PRIVACY: LegalSection[] = [
  {
    id: 'responsable',
    title: 'Quién trata tus datos',
    blocks: [
      {
        type: 'p',
        text: 'HS Global Services ("HS Global", "nosotros") es responsable del tratamiento de los datos personales que recogemos a través del sitio web, del portal de clientes y de la operación de casillero y transporte internacional.',
      },
      {
        type: 'p',
        text: 'Esta política explica qué datos recogemos, para qué los usamos, con quién los compartimos, cuánto tiempo los conservamos y cómo puedes ejercer tus derechos. Forma parte integral de los Términos de uso.',
      },
    ],
  },
  {
    id: 'datos',
    title: 'Qué datos recogemos',
    blocks: [
      { type: 'p', text: 'Recogemos únicamente lo necesario para prestar el servicio:' },
      {
        type: 'list',
        items: [
          'Identificación: nombre completo y número de documento, requerido por la autoridad aduanera para importar a tu nombre.',
          'Contacto: correo electrónico y teléfono, para avisarte del estado de tus envíos y coordinar la entrega.',
          'Dirección de entrega: provincia, cantón, distrito y señas exactas.',
          'Datos de tus envíos: prealertas, facturas de compra, descripción y valor declarado, peso, dimensiones, fotos del bulto e historial de estados.',
          'Datos de facturación y de los pagos realizados.',
          'Datos técnicos de uso del portal: dirección IP, tipo de dispositivo y navegador, y registros de acceso.',
        ],
      },
      {
        type: 'p',
        text: 'No pedimos ni almacenamos datos sensibles. Los datos completos de tu tarjeta los procesa directamente la pasarela de pago: HS Global no los guarda.',
      },
    ],
  },
  {
    id: 'finalidades',
    title: 'Para qué usamos tus datos',
    blocks: [
      { type: 'p', text: 'Tratamos tus datos con estas finalidades:' },
      {
        type: 'list',
        items: [
          'Abrir y mantener tu casillero, y asociar a tu cuenta los paquetes que llegan a bodega.',
          'Transportar, nacionalizar y entregar tus envíos.',
          'Cumplir las obligaciones aduaneras, tributarias y contables que nos exige la ley.',
          'Cobrar los servicios y emitir la factura correspondiente.',
          'Notificarte el estado de tus paquetes y atender tus consultas y reclamos.',
          'Prevenir el fraude y el uso indebido del casillero.',
          'Enviarte comunicaciones comerciales, solo si lo autorizas por separado.',
        ],
      },
      {
        type: 'p',
        text: 'No vendemos tus datos personales ni los cedemos a terceros con fines publicitarios.',
      },
    ],
  },
  {
    id: 'consentimiento',
    title: 'Con qué fundamento los tratamos',
    blocks: [
      {
        type: 'p',
        text: 'La base del tratamiento es tu consentimiento informado, que otorgas al registrarte y aceptar esta política, junto con la ejecución del contrato de servicio y el cumplimiento de obligaciones legales (en particular las aduaneras y las tributarias).',
      },
      {
        type: 'p',
        text: 'Entregar los datos de identificación, contacto y dirección es indispensable para prestar el servicio: sin ellos no podemos recibir mercancía a tu nombre ni nacionalizarla. Los datos que pedimos como opcionales quedan marcados como tales.',
      },
    ],
  },
  {
    id: 'terceros',
    title: 'Con quién los compartimos',
    blocks: [
      { type: 'p', text: 'Compartimos datos solo con quien resulta necesario para mover tu carga:' },
      {
        type: 'list',
        items: [
          'Autoridades aduaneras y tributarias, en los términos que exige la ley.',
          'Agentes aduanales, aerolíneas, navieras y transportistas de última milla que ejecutan el envío.',
          'Aseguradoras, cuando contratas seguro de carga o presentas un reclamo.',
          'Pasarelas de pago, para procesar los cobros.',
          'Proveedores de infraestructura tecnológica que alojan el portal bajo acuerdos de confidencialidad.',
        ],
      },
      {
        type: 'p',
        text: 'Con nuestro proveedor logístico de bodega y transporte compartimos lo mínimo para identificar y mover el bulto. Tus datos de contacto reales (correo y teléfono) no se le entregan: quedan bajo control de HS Global, que es quien te notifica y te atiende.',
      },
    ],
  },
  {
    id: 'transferencias',
    title: 'Transferencia internacional',
    blocks: [
      {
        type: 'p',
        text: 'La operación es internacional: la mercancía se recibe en Miami y se transporta hasta Costa Rica. Por eso algunos de tus datos se tratan o se almacenan en Estados Unidos y, según la ruta, en países de tránsito.',
      },
      {
        type: 'p',
        text: 'Al usar el servicio autorizas esa transferencia, limitada a las finalidades descritas en esta política y sujeta a compromisos contractuales de confidencialidad y seguridad con cada proveedor.',
      },
    ],
  },
  {
    id: 'conservacion',
    title: 'Cuánto tiempo los conservamos',
    blocks: [
      {
        type: 'p',
        text: 'Conservamos tus datos mientras tu cuenta esté activa. Cerrada la cuenta, mantenemos la información de los envíos, las facturas y los soportes aduaneros durante el plazo que exige la normativa contable, tributaria y aduanera, y luego la eliminamos o la anonimizamos.',
      },
    ],
  },
  {
    id: 'seguridad',
    title: 'Cómo los protegemos',
    blocks: [
      {
        type: 'p',
        text: 'Aplicamos medidas técnicas y organizativas razonables: cifrado del tráfico, contraseñas almacenadas con funciones de hash, control de acceso por rol (cada persona del equipo ve solo lo que su función requiere) y registro de auditoría de las operaciones sensibles.',
      },
      {
        type: 'p',
        text: 'Ningún sistema es infalible. Si ocurre un incidente que afecte tus datos personales, te lo informaremos y lo reportaremos a la autoridad competente conforme a la ley.',
      },
    ],
  },
  {
    id: 'derechos',
    title: 'Tus derechos',
    blocks: [
      { type: 'p', text: 'En cualquier momento puedes:' },
      {
        type: 'list',
        items: [
          'Acceder a los datos que tenemos sobre ti.',
          'Rectificar los que estén incompletos, inexactos o desactualizados.',
          'Solicitar la eliminación de los que ya no sean necesarios para el servicio ni exigidos por ley.',
          'Revocar el consentimiento para las comunicaciones comerciales.',
          'Oponerte a un tratamiento o pedir que se limite, en los casos que la ley prevé.',
        ],
      },
      {
        type: 'p',
        text: 'Buena parte de tus datos los puedes ver y corregir tú mismo desde el portal. Para lo demás, escríbenos a servicioalcliente@hsglobal-services.com desde el correo registrado en tu cuenta: responderemos dentro de los plazos legales. Si no quedas conforme con la respuesta, puedes acudir a la autoridad de protección de datos de Costa Rica.',
      },
    ],
  },
  {
    id: 'cookies',
    title: 'Cookies y tecnologías similares',
    blocks: [
      {
        type: 'p',
        text: 'El sitio público es estático y no usa cookies de publicidad ni de seguimiento de terceros. En el portal usamos únicamente las cookies y el almacenamiento local necesarios para mantener tu sesión iniciada y recordar preferencias básicas de la interfaz.',
      },
      {
        type: 'p',
        text: 'Puedes borrarlas o bloquearlas desde tu navegador, pero en ese caso no podrás mantener la sesión abierta en el portal.',
      },
    ],
  },
  {
    id: 'menores',
    title: 'Menores de edad',
    blocks: [
      {
        type: 'p',
        text: 'El servicio está dirigido a personas mayores de edad. No recogemos datos de menores de forma consciente. Si detectamos una cuenta creada por un menor sin autorización de quien ejerce su representación, la cerraremos y eliminaremos sus datos.',
      },
    ],
  },
  {
    id: 'cambios-privacidad',
    title: 'Cambios en esta política',
    blocks: [
      {
        type: 'p',
        text: 'Podemos actualizar esta política cuando cambie el servicio o la normativa. La versión vigente es siempre la publicada en esta página, con su fecha de actualización. Si el cambio es sustancial, lo avisaremos por el portal o por correo antes de que entre en vigor.',
      },
    ],
  },
  {
    id: 'contacto-privacidad',
    title: 'Contacto',
    blocks: [
      {
        type: 'p',
        text: 'Para cualquier consulta sobre el tratamiento de tus datos personales escríbenos a servicioalcliente@hsglobal-services.com o desde la página de contacto.',
      },
    ],
  },
];
