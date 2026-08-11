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
import { zValidator } from '../../core/validator';
import {
  Permission,
  listPaymentsQuerySchema,
  recordPaymentSchema,
  resolvePaymentSchema,
  simulatePaymentSchema,
  startPaymentSchema,
  updateBankAccountSchema,
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
 * navegador: no hay cookie que validar, la autenticidad la da el secreto del
 * header.
 *
 * Onvo NO firma el cuerpo: manda el secreto tal cual en `X-Webhook-Secret`. Sin
 * `ONVO_WEBHOOK_SECRET` configurado la verificacion falla siempre, asi que todo
 * webhook se rechaza; preferimos ignorar cobros reales a aceptar uno falso.
 *
 * Se responde 200 en cuanto el evento queda aplicado (o descartado por conocido):
 * Onvo marca la entrega como fallida con cualquier otro codigo y la reintenta. Por
 * eso un evento que no nos concierne tambien responde 200, no un error.
 */
paymentsRoutes.post('/webhook/onvo', async (c) => {
  const raw = await c.req.text();
  if (!onvoClient.verifyWebhookSecret(c.req.header('x-webhook-secret') ?? '')) {
    return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Firma inválida.' } }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: { code: 'INVALID_PAYLOAD', message: 'Cuerpo ilegible.' } }, 400);
  }

  const outcome = onvoClient.parseWebhookEvent(payload);
  // Evento que no resuelve nada (un cobro diferido, u otro tipo): recibido y ya.
  if (!outcome) return c.json({ received: true, applied: false });

  const result = await paymentsService.confirmByGateway(outcome);
  return c.json({ received: true, applied: result.applied });
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
 * Flujo de PRUEBA: resuelve un cobro simulado sin pasar por Onvo, para poder
 * recorrer el pago con tarjeta sin credenciales.
 *
 * Lleva sesion y permiso como cualquier otra ruta del cliente, aunque el cerrojo
 * de verdad es el modo de la pasarela: fuera de `simulated` el servicio responde
 * 404, y en produccion la API ni siquiera arranca con la simulacion encendida.
 */
paymentsRoutes.post(
  '/:id/simulate',
  requirePermission(Permission.PackagePay),
  zValidator('json', simulatePaymentSchema),
  async (c) => {
    const updated = await paymentsService.simulateGatewayOutcome(
      c.get('session'),
      c.req.param('id'),
      c.req.valid('json').approve,
    );
    return c.json(updated);
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

/**
 * El staff corrige a que cuenta entro un deposito. Va aparte de `/resolve`
 * porque tambien aplica a pagos YA confirmados: el estado de cuenta que revela
 * el error suele llegar despues de haber validado el abono.
 */
paymentsRoutes.patch(
  '/:id/bank-account',
  requirePermission(Permission.PaymentsValidate),
  zValidator('json', updateBankAccountSchema),
  async (c) => {
    const updated = await paymentsService.updateBankAccount(
      c.get('session'),
      c.req.param('id'),
      c.req.valid('json'),
    );
    return c.json(updated);
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
