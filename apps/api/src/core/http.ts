/**
 * App Hono base: CORS restringido al origen de la web, logger y handler de
 * errores unico. Cada modulo aporta su router y se monta en main.ts.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { PUBLIC_API_PREFIX, type Session } from '@courier/shared';
import { config } from './config';
import { onError } from './errors';

/**
 * El casillero que la LLAVE de API identifica (docs/16 §5). Es a la API publica
 * lo que `session` es al portal: lo pone el middleware desde la credencial, y
 * nunca lo manda quien llama.
 */
export interface ApiClient {
  /** Id de la llave con la que entro. Va en el log de la peticion. */
  keyId: string;
  clientId: string;
  /** Codigo de casillero `HS-####`. */
  clientCode: string;
}

/** Variables que los middleware ponen en el contexto de la request. */
export type AppEnv = {
  Variables: {
    session: Session;
    apiClient: ApiClient;
  };
};

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', logger());

  /**
   * DOS politicas de CORS, porque son dos APIs con dos audiencias.
   *
   *   - El portal (todo lo que no es `/api/v1`) habla desde el navegador con la
   *     cookie de sesion, asi que necesita `credentials: true` y, por eso mismo,
   *     una lista blanca de UN solo origen: con credenciales, el comodin ni
   *     siquiera es legal, y permitir otro origen seria regalar la sesion.
   *   - La API publica se consume desde SERVIDORES, con una llave en la
   *     cabecera. No hay cookie que proteger, asi que el origen es libre
   *     (`*`) y las credenciales van apagadas: eso es justamente lo que impide
   *     que el navegador de un cliente logueado le adjunte su cookie a una
   *     peticion cruzada hacia `/api/v1`.
   */
  const portalCors = cors({
    origin: config.WEB_ORIGIN,
    credentials: true, // necesario para la cookie de sesion
  });
  const publicApiCors = cors({
    origin: '*',
    credentials: false,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
    // Sin esto el navegador no deja leer las cabeceras del limitador, que son
    // justo las que permiten a un cliente regularse solo.
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
    maxAge: 600,
  });

  app.use('*', async (c, next) =>
    c.req.path.startsWith(PUBLIC_API_PREFIX) ? publicApiCors(c, next) : portalCors(c, next),
  );

  /**
   * Cabeceras de seguridad de TODA respuesta de la API.
   *
   *   - `nosniff`: aqui todo es JSON; sin ella, un navegador puede decidir tratar
   *     una respuesta como HTML y ejecutar lo que lleve dentro.
   *   - `no-store`: ninguna respuesta de esta API es cacheable. Llevan datos de
   *     un casillero concreto y no pueden quedarse en un proxy intermedio.
   *   - `Referrer-Policy`: que una URL de la API no viaje entera hacia terceros.
   *
   * La cabecera HSTS NO se pone aqui sino en CloudFront: es una politica del
   * SITIO (host y subdominios) y ponerla desde un origen que ademas habla HTTP
   * con el borde seria decir una cosa y hacer otra.
   */
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
  });

  app.onError(onError);

  /**
   * Ruta que no existe. Hono responde por defecto `404 Not Found` en texto
   * plano, y eso rompe dos cosas a la vez: el contrato de errores (todo error de
   * esta API es `{error:{code,message}}`) y la depuracion de quien integra, que
   * recibe el mismo cuerpo mudo si se equivoco de ruta que si le sobro una barra
   * final. El mensaje dice que se pidio y donde mirar la lista de operaciones.
   */
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: c.req.path.startsWith(PUBLIC_API_PREFIX)
            ? `No existe ${c.req.method} ${c.req.path} en la API. Revisa la ruta (en minúsculas y sin barra final) y el método; las operaciones están listadas en ${PUBLIC_API_PREFIX}/openapi.json.`
            : `No existe ${c.req.method} ${c.req.path}.`,
        },
      },
      404,
    ),
  );


  /**
   * Sonda de salud, en las DOS rutas a proposito.
   *
   *   - `/health`     — desde dentro del contenedor. Es la que usa el
   *                     HEALTHCHECK de la imagen, que habla con 127.0.0.1 y no
   *                     pasa por ningun proxy.
   *   - `/api/health` — desde fuera. CloudFront solo enruta hacia la API lo que
   *                     empieza por `/api/`, asi que sin esta la sonda es
   *                     inalcanzable desde internet y no sirve para comprobar un
   *                     despliegue (docs/12).
   */
  const health = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  app.get('/health', health);
  app.get('/api/health', health);

  return app;
}

export type App = ReturnType<typeof createApp>;
