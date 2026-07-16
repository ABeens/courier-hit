/*
  Preguntas frecuentes del sitio público. Portado de
  `docs/manuales/landing.md`; debe mantenerse coherente con `services.ts`
  (el FAQ no puede prometer un servicio que el catálogo no lista).

  El rastreo se responde aquí como funcionalidad, pero solo se consulta desde
  el portal: el sitio público no expone búsqueda de paquetes.
*/
export type FaqItem = {
  q: string;
  a: string;
  points?: string[];
};

export const FAQ: FaqItem[] = [
  {
    q: '¿Qué tipos de envíos maneja HS Global?',
    a: 'Gestionamos envíos nacionales e internacionales, incluyendo:',
    points: [
      'Paquetería',
      'Carga consolidada aérea y marítima (LCL y FCL)',
      'Agencia aduanal',
      'Seguros de carga',
    ],
  },
  {
    q: '¿Puedo rastrear mi envío en tiempo real?',
    a: 'Sí. Nuestro sistema de tracking te permite monitorear el estado de tu envío en cada etapa del proceso, brindando visibilidad, control y tranquilidad. El seguimiento se consulta desde tu cuenta, iniciando sesión en el portal.',
  },
  {
    q: '¿Qué información necesito para solicitar un casillero?',
    a: 'Solo debes registrarte en nuestra plataforma y llenar el formulario. Recibes tu dirección de Miami al instante.',
  },
  {
    q: '¿El servicio de casillero tiene un costo?',
    a: 'No, es completamente gratuito. No cobramos membresías ni solicitamos mínimos de carga para mantenerlo abierto.',
  },
  {
    q: '¿Qué información necesito para solicitar un envío de transporte internacional?',
    a: 'Para cotizar o coordinar tu envío, requerimos:',
    points: [
      'Origen y destino',
      'Peso y dimensiones de la carga',
      'Tipo de mercancía',
      'Fecha estimada de envío',
      'Valor comercial (para trámites aduaneros, si aplica)',
    ],
  },
  {
    q: '¿HS Global ofrece servicio puerta a puerta?',
    a: 'Sí, contamos con soluciones puerta a puerta, desde la recolección en origen hasta la entrega final en destino, incluyendo gestión aduanera.',
  },
  {
    q: '¿Qué incluye el servicio de tracking?',
    a: 'Nuestro sistema de tracking incluye:',
    points: [
      'Estado actualizado del envío',
      'Alertas de tránsito y entrega',
      'Historial de movimiento',
      'Notificaciones clave (salida, llegada, liberación, entrega)',
    ],
  },
  {
    q: '¿Puedo asegurar mi envío?',
    a: 'Sí, ofrecemos opciones de seguro para proteger tu carga frente a imprevistos durante el transporte.',
  },
  {
    q: '¿A quién puedo contactar para soporte?',
    a: 'Puedes contactar a nuestro equipo de servicio al cliente en cualquier momento. Estamos comprometidos con una atención ágil, transparente y personalizada.',
  },
];
