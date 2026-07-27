/**
 * Correo saliente. Un solo punto de envio para todo el sistema: verificacion de
 * cuenta, invitacion de staff, restablecer contrasena, avisos de cambio de estado
 * y el resumen diario de tramites.
 *
 * Hay DOS transportes y el interruptor `MAIL_ENABLED` elige:
 *
 *   - consola (por defecto): imprime el mensaje completo. No es un stub vacio; es
 *     lo que permite recorrer un flujo entero (registrarse, leer el codigo en el
 *     log, verificar) sin servidor de correo.
 *   - SES (`MAIL_ENABLED=true`): Amazon SES v2. Listo para usarse; se enciende
 *     cuando exista el servidor en AWS y el dominio este verificado en SES.
 *
 * Ningun modulo que envie correo conoce esta diferencia: todos llaman a
 * `mailer.send`.
 *
 * Antes de encenderlo en produccion hacen falta tres cosas del lado de AWS:
 *   1. dominio (o al menos el remitente de `MAIL_FROM`) VERIFICADO en SES;
 *   2. la cuenta fuera del sandbox de SES, que solo deja enviar a direcciones
 *      verificadas y haria que ningun cliente reciba nada;
 *   3. permiso `ses:SendEmail` en el rol de la instancia (o las llaves de §config).
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
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
 * Cliente de SES. Perezoso y unico: se crea en el primer envio y se reusa. Crearlo
 * al importar el modulo obligaria a tener credenciales resueltas solo por arrancar
 * la API, incluso con el correo apagado.
 *
 * Sin `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` no se pasa `credentials` y el SDK
 * usa su cadena por defecto (rol de instancia en EC2/ECS), que es lo correcto en
 * AWS: llaves estaticas en produccion son un secreto mas que rotar.
 */
let sesClient: SESv2Client | null = null;

function getSesClient(): SESv2Client {
  sesClient ??= new SESv2Client({
    region: config.AWS_REGION,
    ...(config.SES_ACCESS_KEY_ID && config.SES_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.SES_ACCESS_KEY_ID,
            secretAccessKey: config.SES_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return sesClient;
}

/**
 * Transporte real: Amazon SES v2.
 *
 * El cuerpo va como TEXTO PLANO, no HTML: las plantillas del manual son texto y
 * un correo de texto no puede romperse en un cliente de correo raro. `Charset`
 * explicito porque los avisos llevan tildes y sin el llegan corruptos.
 */
const sesTransport: Transport = {
  async send(message) {
    await getSesClient().send(
      new SendEmailCommand({
        FromEmailAddress: config.MAIL_FROM,
        Destination: { ToAddresses: [message.to] },
        ...(config.SES_CONFIGURATION_SET
          ? { ConfigurationSetName: config.SES_CONFIGURATION_SET }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  },
};

/** Elige el transporte segun el interruptor. */
function resolveTransport(): Transport {
  if (!config.MAIL_ENABLED) return consoleTransport;
  console.log(`[mailer] transporte SES activo (región ${config.AWS_REGION}).`);
  return sesTransport;
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
