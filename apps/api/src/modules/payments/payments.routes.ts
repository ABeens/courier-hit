/**
 * Rutas del modulo de pagos. El recurso lo comparten dos poblaciones, asi que el
 * permiso va por endpoint y no en un middleware del router:
 *
 *   - el CLIENTE consulta lo que debe, inicia el pago y sube su comprobante
 *     (package.pay, scope Own: el servicio acota al casillero de la sesion);
 *   - el STAFF registra depositos y valida los pendientes (payments.validate).
 *
 * El webhook de la pasarela queda FUERA de la sesion: lo llama Onvo, no un
 * navegador. Su autenticacion es la firma del cuerpo, no una cookie.
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  Permission,
  listPaymentsQuerySchema,
  recordPaymentSchema,
  resolvePaymentSchema,
  startPaymentSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { StorageErrors } from '../../core/storage';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { onvoClient } from '../../integrations/onvo/onvo.client';
import { paymentsService } from './payments.service';

export const paymentsRoutes = new Hono<AppEnv>();

/**
 * Webhook de Onvo. Se monta ANTES de `requireSession` porque no viene de un
 * navegador: no hay cookie que validar, la autenticidad la da la firma.
 *
 * TODO(09/onvo): cuando `verifyWebhookSignature` este implementado, confirmar el
 * pago con `parseWebhookEvent` y llamar a `paymentsService.resolve`. Hoy la firma
 * nunca valida, asi que todo webhook se rechaza: preferimos ignorar cobros reales
 * a aceptar uno falso.
 */
paymentsRoutes.post('/webhook/onvo', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('onvo-signature') ?? '';
  if (!onvoClient.verifyWebhookSignature(raw, signature)) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Firma inválida.' } }, 401);
  }
  return c.json({ received: true });
});

paymentsRoutes.use('*', requireSession());

/** Puede consultar pagos: el staff (todos) o el cliente (los suyos). */
const canRead = requireAnyPermission(Permission.PackagePay, Permission.PaymentsValidate);

/** Lo que el cliente debe por un tramite y con que lo puede pagar. */
paymentsRoutes.get('/quote/:shipmentId', canRead, async (c) => {
  return c.json(await paymentsService.quote(c.get('session'), c.req.param('shipmentId')));
});

paymentsRoutes.get('/shipment/:shipmentId', canRead, async (c) => {
  return c.json(await paymentsService.listByShipment(c.get('session'), c.req.param('shipmentId')));
});

/** Bandeja de validacion del staff. */
paymentsRoutes.get(
  '/',
  requirePermission(Permission.PaymentsValidate),
  zValidator('query', listPaymentsQuerySchema),
  async (c) => {
    return c.json(await paymentsService.list(c.req.valid('query')));
  },
);

/** El cliente inicia el pago de un tramite suyo. */
paymentsRoutes.post(
  '/',
  requirePermission(Permission.PackagePay),
  zValidator('json', startPaymentSchema),
  async (c) => {
    const result = await paymentsService.start(c.get('session'), c.req.valid('json'));
    return c.json(result, 201);
  },
);

/**
 * Comprobante del deposito. Va como multipart porque lleva un archivo; el resto
 * del modulo es JSON.
 */
paymentsRoutes.post('/:id/receipt', canRead, async (c) => {
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw StorageErrors.fileRequired('el comprobante del depósito');

  return c.json(await paymentsService.attachReceipt(c.get('session'), c.req.param('id'), file));
});

paymentsRoutes.get('/:id/receipt', canRead, async (c) => {
  const { body, contentType } = await paymentsService.receiptFile(
    c.get('session'),
    c.req.param('id'),
  );
  return c.body(body, 200, { 'content-type': contentType });
});

/** El staff registra un deposito ya recibido ("Informacion de Pago"). */
paymentsRoutes.post(
  '/record',
  requirePermission(Permission.PaymentsValidate),
  zValidator('json', recordPaymentSchema),
  async (c) => {
    const created = await paymentsService.record(c.get('session'), c.req.valid('json'));
    return c.json(created, 201);
  },
);

/** El staff confirma o rechaza un deposito pendiente. */
paymentsRoutes.post(
  '/:id/resolve',
  requirePermission(Permission.PaymentsValidate),
  zValidator('json', resolvePaymentSchema),
  async (c) => {
    const updated = await paymentsService.resolve(
      c.get('session'),
      c.req.param('id'),
      c.req.valid('json'),
    );
    return c.json(updated);
  },
);
