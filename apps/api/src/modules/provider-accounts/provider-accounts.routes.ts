/**
 * Mantenimiento de las cuentas exclusivas del operador de Miami (docs/13 §6).
 *
 * Un solo permiso para todo, `provider_accounts.manage`, que hoy solo tiene el
 * administrador: aqui se guardan CREDENCIALES de una cuenta del proveedor y se
 * crean clientes, dos cosas que no son de la operacion diaria.
 *
 * Ademas del permiso, todas piden `MIAMI_LINK_ENABLED=true`, igual que el panel
 * de enlaces: con la bandera apagada la pantalla no se ofrece en el portal y
 * estas rutas responden 403 en vez de quedar accesibles por URL.
 */
import { Hono } from 'hono';
import {
  Permission,
  createConsolidatedClientSchema,
  createProviderAccountSchema,
  updateProviderAccountSchema,
} from '@courier/shared';
import type { AppEnv } from '../../core/http';
import { requireMiamiLink } from '../../core/middleware/requireMiamiLink';
import { requirePermission } from '../../core/middleware/requirePermission';
import { requireSession } from '../../core/middleware/requireSession';
import { zValidator } from '../../core/validator';
import { providerAccountsService } from './provider-accounts.service';

export const providerAccountsRoutes = new Hono<AppEnv>();

providerAccountsRoutes.use(
  '*',
  requireSession(),
  requireMiamiLink(),
  requirePermission(Permission.ProviderAccountsManage),
);

/** Todas las cuentas: la principal (solo lectura) y las exclusivas. Sin paginar. */
providerAccountsRoutes.get('/', async (c) => {
  return c.json(await providerAccountsService.list());
});

providerAccountsRoutes.post('/', zValidator('json', createProviderAccountSchema), async (c) => {
  const created = await providerAccountsService.create(c.get('session'), c.req.valid('json'));
  return c.json(created, 201);
});

providerAccountsRoutes.patch('/:id', zValidator('json', updateProviderAccountSchema), async (c) => {
  return c.json(await providerAccountsService.update(c.req.param('id'), c.req.valid('json')));
});

/**
 * Alta del cliente consolidado de la cuenta. Es el UNICO camino por el que nace
 * un cliente de este tipo: ni el landing lo ofrece, ni un cliente existente se
 * puede enganchar aqui (ver `provider-accounts.service`).
 *
 * 201 con la cuenta ya enlazada dentro, y en desarrollo con el enlace de
 * invitacion para no tener que leerlo del log (igual que el alta de staff).
 */
providerAccountsRoutes.post(
  '/:id/client',
  zValidator('json', createConsolidatedClientSchema),
  async (c) => {
    const created = await providerAccountsService.createConsolidatedClient(
      c.get('session'),
      c.req.param('id'),
      c.req.valid('json'),
    );
    return c.json(created, 201);
  },
);
