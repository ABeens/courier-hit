/**
 * Rutas del modulo de pagos. El recurso lo comparten dos poblaciones, asi que el
 * permiso va por endpoint y no en un middleware del router:
 *
 *   - el CLIENTE consulta lo que debe, inicia el pago y sube su comprobante
 *     (package.pay, scope Own: el servicio acota al casillero de la sesion);
 *   - el STAFF registra depositos con su comprobante (payments.record);
 *   - el ADMINISTRADOR ademas los aprueba o los rechaza (payments.validate).
 *
 * Los dos ultimos son permisos distintos a proposito: el Operativo asienta lo
 * que el cliente le manda y el abono queda en validacion; darlo por cobrado es
 * del administrador. Por eso ni `/` (la bandeja) ni `/:id/resolve` aflojan a
 * `payments.record`.
 *
 * El webhook de la pasarela queda FUERA de la sesion: lo llama Onvo, no un
 * navegador. Su autenticacion es la firma del cuerpo, no una cookie.
 */
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import {
  Permission,
  listPaymentsQuerySchema,
  proformaPaymentQuoteQuerySchema,
  recordProformaPaymentSchema,
  resolvePaymentGroupSchema,
  resolvePaymentSchema,
  simulatePaymentSchema,
  startProformaPaymentSchema,
  updateBankAccountSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { StorageErrors } from '../../core/storage';
import { requireAnyPermission } from '../../core/middleware/requireAnyPermission';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { onvoClient } from '../../integrations/onvo/onvo.client';
import { paymentsService } from './payments.service';
import { proformaPaymentsService } from './proforma-payments.service';

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

/**
 * Puede consultar pagos y mover su comprobante: el staff que los registra o los
 * aprueba (todos los tramites) y el cliente (los suyos, que el servicio acota).
 *
 * `payments.record` entra aqui y no solo en `/record` porque registrar un
 * deposito no termina con el JSON: el comprobante viaja en una segunda peticion
 * multipart, y quien acaba de asentar el abono tiene que poder adjuntarlo y
 * volver a verlo.
 */
const canRead = requireAnyPermission(
  Permission.PackagePay,
  Permission.PaymentsRecord,
  Permission.PaymentsValidate,
);

paymentsRoutes.get('/shipment/:shipmentId', canRead, async (c) => {
  return c.json(await paymentsService.listByShipment(c.get('session'), c.req.param('shipmentId')));
});

// ---------------------------------------------------------------------------
// COBRO DE PROFORMAS
// ---------------------------------------------------------------------------
//
// Todo se paga por proforma completa. Van ANTES de las rutas con parametro
// (`/:id/...`) para que "proformas" o "groups" no se lean como un id de pago. El
// cliente paga lo suyo (package.pay) y el staff registra depositos
// (payments.record).

/** Proformas aprobadas por cobrar del casillero (el staff indica cual con `?clientId=`). */
paymentsRoutes.get('/proformas/open', canRead, async (c) => {
  return c.json({ items: await proformaPaymentsService.open(c.get('session'), c.req.query('clientId')) });
});

/** Cotiza el cobro de las proformas elegidas (`?ids=a,b`). */
paymentsRoutes.get(
  '/proformas/quote',
  canRead,
  zValidator('query', proformaPaymentQuoteQuerySchema),
  async (c) => {
    const { ids, clientId } = c.req.valid('query');
    return c.json(await proformaPaymentsService.quote(c.get('session'), ids, clientId));
  },
);

/**
 * El CLIENTE paga las proformas que eligio. No lleva monto: lo pone el servidor
 * desde las facturas congeladas.
 */
paymentsRoutes.post(
  '/proformas',
  requirePermission(Permission.PackagePay),
  zValidator('json', startProformaPaymentSchema),
  async (c) => {
    const result = await proformaPaymentsService.start(c.get('session'), c.req.valid('json'));
    return c.json(result, 201);
  },
);

/**
 * El STAFF registra el deposito que el cliente ya hizo por unas proformas. Con
 * que situacion nace lo decide el servicio segun quien firma la sesion.
 */
paymentsRoutes.post(
  '/proformas/record',
  requirePermission(Permission.PaymentsRecord),
  zValidator('json', recordProformaPaymentSchema),
  async (c) => {
    const created = await proformaPaymentsService.record(c.get('session'), c.req.valid('json'));
    return c.json(created, 201);
  },
);

/** Un cobro ya creado. */
paymentsRoutes.get('/groups/:groupId', canRead, async (c) => {
  const groupId = c.req.param('groupId');
  await proformaPaymentsService.assertOwnGroup(c.get('session'), groupId);
  return c.json(await proformaPaymentsService.get(groupId));
});

/** El cargo del cobro salio hacia la pasarela. */
paymentsRoutes.post('/groups/:groupId/submitted', requirePermission(Permission.PackagePay), async (c) => {
  return c.json(await proformaPaymentsService.markCardSubmitted(c.get('session'), c.req.param('groupId')));
});

/** El cliente cerro el formulario de tarjeta sin pagar: se suelta el cobro. */
paymentsRoutes.post('/groups/:groupId/abandon', requirePermission(Permission.PackagePay), async (c) => {
  return c.json(await proformaPaymentsService.abandonCard(c.get('session'), c.req.param('groupId')));
});

/** Flujo de PRUEBA: resuelve un cobro simulado sin pasar por Onvo. */
paymentsRoutes.post(
  '/groups/:groupId/simulate',
  requirePermission(Permission.PackagePay),
  zValidator('json', simulatePaymentSchema),
  async (c) => {
    return c.json(
      await proformaPaymentsService.simulateGatewayOutcome(
        c.get('session'),
        c.req.param('groupId'),
        c.req.valid('json').approve,
      ),
    );
  },
);

/** Comprobante del deposito: un archivo para todo el cobro. */
paymentsRoutes.post('/groups/:groupId/receipt', canRead, async (c) => {
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw StorageErrors.fileRequired('el comprobante del depósito');
  return c.json(
    await proformaPaymentsService.attachReceipt(c.get('session'), c.req.param('groupId'), file),
  );
});

/**
 * El ADMINISTRADOR confirma o rechaza un cobro ENTERO (todos sus abonos): un
 * deposito por varias proformas fue un solo deposito.
 */
paymentsRoutes.post(
  '/groups/:groupId/resolve',
  requirePermission(Permission.PaymentsValidate),
  zValidator('json', resolvePaymentGroupSchema),
  async (c) => {
    return c.json(
      await proformaPaymentsService.resolveGroup(c.get('session'), c.req.param('groupId'), c.req.valid('json')),
    );
  },
);

/** Bandeja de validacion del staff. */
paymentsRoutes.get(
  '/',
  requirePermission(Permission.PaymentsValidate),
  zValidator('query', listPaymentsQuerySchema),
  async (c) => {
    return c.json(await paymentsService.list(c.req.valid('query')));
  },
);

/**
 * El navegador acabo de mandarle la tarjeta a la pasarela: el cobro pasa de
 * formulario abierto a cargo en camino.
 *
 * Mismo permiso que iniciarlo, y sin cuerpo, por lo mismo que `abandon`: es otro
 * paso del mismo acto y lo unico que hace falta saber es cual pago.
 */
paymentsRoutes.post('/:id/submitted', requirePermission(Permission.PackagePay), async (c) => {
  return c.json(await paymentsService.markCardSubmitted(c.get('session'), c.req.param('id')));
});

/**
 * El cliente cerro el formulario de tarjeta sin pagar: se cancela el intento en
 * la pasarela y se suelta el cobro reservado.
 *
 * Mismo permiso que iniciarlo, porque es la otra mitad del mismo acto. Sin
 * cuerpo: lo unico que hace falta es cual pago, y quien puede soltarlo lo decide
 * el servicio comprobando que el tramite sea suyo.
 */
paymentsRoutes.post('/:id/abandon', requirePermission(Permission.PackagePay), async (c) => {
  return c.json(await paymentsService.abandonCard(c.get('session'), c.req.param('id')));
});

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

/**
 * El staff corrige a que cuenta entro un deposito. Va aparte de `/resolve`
 * porque tambien aplica a pagos YA confirmados: el estado de cuenta que revela
 * el error suele llegar despues de haber validado el abono.
 *
 * Lo alcanzan los dos permisos del staff, tal como pide el requerimiento ("un
 * operario o administrador luego puede indicar que se deposito a otro tipo de
 * cuenta"): corregir la cuenta es enmendar un dato de conciliacion, no aprobar
 * el abono. El monto, la moneda y la tasa siguen siendo un snapshot.
 */
paymentsRoutes.patch(
  '/:id/bank-account',
  requireAnyPermission(Permission.PaymentsRecord, Permission.PaymentsValidate),
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

/**
 * El ADMINISTRADOR confirma o rechaza un deposito pendiente. Es la puerta que
 * convierte un comprobante en dinero recibido, y por eso sigue pidiendo
 * `payments.validate` y no el permiso de registrar.
 */
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
