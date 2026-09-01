/**
 * Panel de control del proveedor simulado. Se monta en `/api/dev/helga` SOLO
 * cuando `helgaMode === 'simulated'` (ver `main.ts`), modo que el arranque prohibe
 * en produccion. No forma parte de la API del producto y no debe consumirlo la
 * web: es una herramienta de pruebas para curl o Postman.
 *
 * Los robots NO usan estas rutas. El avance normal de un paquete sale del reloj
 * del simulador (ver `helga.mock.ts`); esto existe para lo que el reloj no puede
 * dar, que es justo donde estan los errores:
 *
 *   - un paquete que nunca se prealerto  -> unica forma de probar el flujo 2
 *   - una incidencia o un estado inventado -> ramas `incident` y `unknown`
 *   - un sub-casillero que no coincide     -> `checkLockerMatch`
 *   - un 403/422/timeout del proveedor     -> las dos tareas de reconciliacion
 *
 * Sin permisos ni sesion a proposito: exigir cookie haria incomodo el curl, y la
 * puerta ya esta cerrada por configuracion (estas rutas no existen si el modo no
 * es simulado, y el modo simulado no arranca en produccion).
 */
import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { zValidator } from '../../core/validator';
import { z } from 'zod';
import type { AppEnv } from '../../core/http';
import {
  mockAddFailure,
  mockAdvancePackage,
  mockInjectPackage,
  mockReset,
  mockSnapshot,
} from './helga.mock';

export const helgaMockRoutes = new Hono<AppEnv>();

/** Traduce el fallo de una operacion del panel a un 400 con su motivo. */
function badRequest(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

/**
 * Foto del mundo simulado: destinatarios (con el id que hay que usar para
 * inyectar paquetes), paquetes con su paso y estado calculados, y fallos armados.
 */
helgaMockRoutes.get('/state', (c) => c.json(mockSnapshot()));

/**
 * Inyecta un paquete que NUNCA paso por nuestra API, como si alguien lo hubiera
 * creado a mano en la interfaz del proveedor (flujo 2, docs/13 §3.3).
 *
 * `recipientId` es el `helgaClientId` del cliente nuestro que debe recibirlo: sin
 * eso el descubrimiento lo descarta por ajeno. Los que ya conoce el simulador se
 * listan en `GET /state`, pero tambien se acepta uno anterior a este mundo (se
 * recupera al vuelo), asi que se puede copiar directo de la tabla de clientes.
 *
 * `hold` lo fija en DIGITADO: la op. E solo lista ese estado, asi que sin esto el
 * paquete sale del listado al primer paso del reloj y el descubrimiento lo pierde
 * (que es el comportamiento real, pero incomodo si el paso es corto).
 */
helgaMockRoutes.post(
  '/packages',
  zValidator(
    'json',
    z.object({
      tracking: z.string().min(3),
      recipientId: z.string().min(1),
      content: z.string().optional(),
      store: z.string().optional(),
      declaredValue: z.number().nonnegative().optional(),
      hold: z.boolean().optional(),
    }),
  ),
  (c) => {
    try {
      return c.json(mockInjectPackage(c.req.valid('json')), 201);
    } catch (err) {
      return c.json(badRequest(err), 400);
    }
  },
);

/**
 * Mueve un paquete a mano.
 *
 *   - `state`: fija el estado que reporta el proveedor. Acepta cualquier cadena,
 *     tambien las que no estan homologadas ("NOVEDAD", "COSA RARA"), que es como
 *     se prueban las ramas de incidencia y de estado desconocido. `null` lo
 *     devuelve al reloj.
 *   - `steps`: lo adelanta N pasos de la linea de tiempo.
 *   - `locker`: cambia el `codigo_casillero` que reporta el proveedor, para
 *     disparar el aviso de casillero que no coincide.
 */
helgaMockRoutes.post(
  '/advance',
  zValidator(
    'json',
    z.object({
      tracking: z.string().min(3),
      state: z.string().nullable().optional(),
      steps: z.number().int().optional(),
      locker: z.string().nullable().optional(),
    }),
  ),
  (c) => {
    try {
      return c.json(mockAdvancePackage(c.req.valid('json')));
    } catch (err) {
      return c.json(badRequest(err), 400);
    }
  },
);

/**
 * Programa un fallo del proveedor.
 *
 * `status: 0` simula que no responde (timeout de red). Sin `tracking`, el fallo
 * aplica a CUALQUIER llamada, que es la forma de reventar el alta de casilleros
 * (op. D no lleva tracking) y ver correr `helga-link-reconcile`.
 */
helgaMockRoutes.post(
  '/fail',
  zValidator(
    'json',
    z.object({
      status: z.number().int().min(0).max(599),
      tracking: z.string().nullable().optional(),
      message: z.string().nullable().optional(),
      once: z.boolean().optional(),
    }),
  ),
  (c) => {
    const body = c.req.valid('json');
    mockAddFailure({
      status: body.status,
      tracking: body.tracking ?? null,
      message: body.message ?? null,
      once: body.once ?? true,
    });
    return c.json(mockSnapshot().failures, 201);
  },
);

/** Vacia el mundo simulado (equivale a borrar `.helga-mock.json`). */
helgaMockRoutes.post('/reset', (c) => {
  mockReset();
  return c.json({ ok: true });
});

/**
 * Las fotos de bodega del simulador (ver `mockPhotos`). Es la unica ruta de este
 * panel pensada para el NAVEGADOR y no para curl: el portal las pide con un
 * `<img>`, igual que pediria las del proveedor de verdad.
 *
 * Se sirven desde aqui, y no desde `apps/web/public`, para que no acaben
 * publicadas en el sitio: son fotos reales de bodega y solo tienen sentido en
 * desarrollo. Por eso tampoco pasan por el almacenamiento de adjuntos, que es
 * para archivos de clientes.
 *
 * El fichero se lee del arbol de fuentes (`import.meta.url`): estas rutas solo
 * existen con HELGA_MODE=simulated, que el arranque prohibe en produccion, asi
 * que nunca se ejecuta desde el `dist` empaquetado.
 */
helgaMockRoutes.get('/photos/:name', async (c) => {
  const name = c.req.param('name');
  // Lista blanca, no saneo: con dos ficheros conocidos no hace falta razonar
  // sobre `..` ni sobre rutas absolutas.
  if (name !== 'warehouse-1.webp' && name !== 'warehouse-2.webp') return c.notFound();

  const file = new URL(`./fixtures/${name}`, import.meta.url);
  const body = await readFile(file);
  return c.body(body, 200, {
    'content-type': 'image/webp',
    'cache-control': 'public, max-age=3600',
  });
});
