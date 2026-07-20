/**
 * Correo saliente. Un solo punto de envio para todo el sistema: verificacion de
 * cuenta, invitacion de staff, restablecer contrasena, avisos de cambio de estado
 * y el resumen diario de tramites.
 *
 * El TRANSPORTE es intercambiable y hoy hay uno solo: consola. No es un stub
 * vacio —imprime el mensaje completo— para que en desarrollo se pueda seguir un
 * flujo entero (registrarse, leer el codigo en el log, verificar) sin depender de
 * un servidor SMTP.
 *
 * TODO(correo): implementar el transporte de Amazon SES y elegirlo cuando
 * MAIL_ENABLED=true. Solo se agrega un `Transport` mas abajo; ningun modulo que
 * envie correo cambia.
 */
import { config } from './config';

export interface MailMessage {
  to: string;
  subject: string;
  /** Cuerpo en texto plano. Las plantillas del manual son texto, no HTML. */
  body: string;
}

interface Transport {
  send(message: MailMessage): Promise<void>;
}

/**
 * Transporte de desarrollo: escribe el correo en la consola. Que el mensaje se
 * vea entero es deliberado: es como se prueban los flujos sin SES.
 */
const consoleTransport: Transport = {
  async send(message) {
    console.log(
      [
        '',
        '──────── correo ────────',
        `De:      ${config.MAIL_FROM}`,
        `Para:    ${message.to}`,
        `Asunto:  ${message.subject}`,
        '',
        message.body,
        '────────────────────────',
        '',
      ].join('\n'),
    );
  },
};

/**
 * TODO(correo): transporte real (SES). Mientras no exista, encender MAIL_ENABLED
 * no cambia nada salvo el aviso de arranque: preferimos que el correo se vea en
 * el log a que se pierda en silencio.
 */
function resolveTransport(): Transport {
  if (config.MAIL_ENABLED) {
    console.warn(
      '[mailer] MAIL_ENABLED=true pero el transporte SES aún no está implementado. ' +
        'Los correos se seguirán escribiendo en la consola.',
    );
  }
  return consoleTransport;
}

const transport = resolveTransport();

export const mailer = {
  /**
   * Envia un correo. NUNCA lanza: un fallo de correo no puede tumbar la operacion
   * que lo disparo (aprobar unos costos, confirmar una entrega). Se registra y se
   * sigue; el estado del tramite ya quedo guardado.
   */
  async send(message: MailMessage): Promise<void> {
    try {
      await transport.send(message);
    } catch (err) {
      console.error(`[mailer] no se pudo enviar el correo a ${message.to}:`, err);
    }
  },
};
