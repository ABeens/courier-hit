/**
 * Endpoints que llama Helga (especificacion v1.0 §1 y §3):
 *
 *   POST /api/webhooks/helga/paquetes   creacion de paquete
 *   POST /api/webhooks/helga/tracking   nuevo estado de la guia
 *
 * Respuestas (§4 y §7.2 de la especificacion):
 *   200  aviso guardado, incluidos duplicados y todo lo que no cambia nada
 *   400  cuerpo ilegible o sin sus campos llave       -> Helga no reintenta
 *   401  sin llave o llave invalida                   -> Helga no reintenta
 *   503  recepcion apagada (HELGA_WEBHOOKS_ENABLED)    -> Helga reintenta
 *   500  fallo al guardar                              -> Helga reintenta
 *
 * No hay sesion ni CSRF que proteger: la llave identifica la cuenta Miami y es
 * lo unico que abre estas rutas (no abre nada mas).
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { config } from '../../core/config';
import { AppError } from '../../core/errors';
import type { AppEnv } from '../../core/http';
import { accountForWebhookKey, readWebhookKey } from './provider-webhooks.keys';
import { providerWebhooksService } from './provider-webhooks.service';
import type { WebhookKind } from './provider-webhooks.repo';

type WebhookEnv = AppEnv & { Variables: { webhookAccount: string } };

/** Un aviso real pesa unos pocos KB; esto solo corta abusos. */
const MAX_BODY_BYTES = 1024 * 1024;

const requireWebhookKey = () =>
  createMiddleware<WebhookEnv>(async (c, next) => {
    if (!config.HELGA_WEBHOOKS_ENABLED) {
      throw new AppError(
        'WEBHOOKS_DISABLED',
        'La recepción de avisos está apagada temporalmente. Reintenta más tarde.',
        503,
      );
    }
    const key = readWebhookKey((name) => c.req.header(name));
    if (!key) {
      throw new AppError(
        'WEBHOOK_KEY_MISSING',
        'Falta la llave de acceso: envíala en "Authorization: Bearer <llave>".',
        401,
      );
    }
    const account = accountForWebhookKey(key);
    if (!account) throw new AppError('WEBHOOK_KEY_INVALID', 'La llave de acceso no es válida.', 401);
    c.set('webhookAccount', account);
    await next();
  });

async function readBody(raw: string): Promise<unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('WEBHOOK_UNREADABLE', 'El cuerpo no es un JSON válido (UTF-8).', 400);
  }
}

export const providerWebhooksRoutes = new Hono<WebhookEnv>()
  .use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: 'WEBHOOK_TOO_LARGE', message: 'El cuerpo supera 1 MB.' } }, 413),
    }),
  )
  .use('*', requireWebhookKey())
  .post('/:kind{paquetes|tracking}', async (c) => {
    const kind: WebhookKind = c.req.param('kind') === 'paquetes' ? 'package' : 'tracking';
    const body = await readBody(await c.req.text());
    await providerWebhooksService.receive(kind, c.get('webhookAccount'), body);
    return c.json({ success: true, message: 'Recibido' }, 200);
  });
