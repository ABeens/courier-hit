/**
 * Limitador de peticiones (docs/16 §6).
 *
 * QUE PROTEGE Y QUE NO. Son dos capas y hacen cosas distintas:
 *
 *   - AWS WAF, en el borde de CloudFront (`infra/lib/app-stack.ts`), corta las
 *     inundaciones por IP antes de que lleguen al servidor. Es la defensa contra
 *     la denegacion de servicio: para el trafico donde todavia es barato pararlo.
 *   - ESTO, dentro de la API, limita por LLAVE y por cuenta. Es lo unico que
 *     puede distinguir a un integrador que consulta de mas de otro que no: para
 *     el WAF los dos son la misma IP de un centro de datos, o incluso la misma IP
 *     de CloudFront.
 *
 * Ninguna de las dos sustituye a la otra, y por eso estan las dos.
 *
 * EL CONTADOR VIVE EN MEMORIA DEL PROCESO. Hoy la API es UNA instancia (docs/12),
 * asi que el conteo es exacto. El dia que haya dos, cada una contara lo suyo y el
 * limite efectivo se multiplicara por el numero de instancias; el arreglo es
 * mover el contador a un almacen compartido (Redis, o una tabla con un contador
 * por ventana), no subir el limite. Se elige memoria a proposito y no la base de
 * datos: un limitador que escribe en Postgres en cada peticion le suma carga al
 * sistema justo cuando lo estan inundando, que es cuando menos puede permitirselo.
 *
 * VENTANA DESLIZANTE, no fija. Una ventana fija de un minuto deja pasar el doble
 * del limite a caballo entre dos minutos (todo al final de una, todo al principio
 * de la siguiente). Aqui la cuenta pondera lo que queda de la ventana anterior,
 * que cuesta lo mismo y no tiene ese borde.
 */
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { AppError } from './errors';

interface Bucket {
  /** Inicio de la ventana actual, en milisegundos. */
  windowStart: number;
  /** Peticiones contadas en la ventana actual. */
  count: number;
  /** Peticiones de la ventana inmediatamente anterior, para ponderarlas. */
  previous: number;
}

/**
 * Un contador independiente. Se crea uno por sitio a limitar (la API publica, el
 * login...) para que agotar el cupo de uno no toque al otro.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Nombre para los logs. No sale en ninguna respuesta. */
    readonly name: string,
  ) {
    /**
     * Barrido periodico: sin el, cada IP o llave vista una sola vez se quedaria
     * en el mapa para siempre y la memoria crece con el trafico historico, no con
     * el concurrente. `unref` para que este temporizador no impida que el proceso
     * termine cuando le manden la señal de apagado.
     */
    const sweep = setInterval(() => this.sweep(), Math.max(windowMs, 60_000) * 2);
    sweep.unref?.();
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) this.buckets.delete(key);
    }
  }

  /**
   * Cuenta una peticion de `key` y dice si pasa.
   *
   * `remaining` y `resetAt` salen siempre, tambien cuando se rechaza: son las
   * cabeceras que le permiten a un cliente educado regularse solo en vez de
   * reintentar a ciegas.
   */
  hit(key: string): { allowed: boolean; remaining: number; resetAt: number; retryAfterSeconds: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      const previous = bucket && bucket.windowStart === windowStart - this.windowMs ? bucket.count : 0;
      bucket = { windowStart, count: 0, previous };
      this.buckets.set(key, bucket);
    }

    // Peso de lo que queda de la ventana anterior: 1 justo al empezar la actual,
    // 0 al terminarla.
    const elapsed = now - windowStart;
    const weight = (this.windowMs - elapsed) / this.windowMs;
    const estimated = bucket.previous * weight + bucket.count;

    const resetAt = windowStart + this.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

    if (estimated >= this.limit) {
      return { allowed: false, remaining: 0, resetAt, retryAfterSeconds };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(this.limit - estimated - 1)),
      resetAt,
      retryAfterSeconds,
    };
  }

  /** Olvida el contador de una clave. Lo usa el login tras autenticar bien. */
  reset(key: string): void {
    this.buckets.delete(key);
  }
}

/**
 * IP de quien pide, tal como llega DETRAS DE CLOUDFRONT.
 *
 * `X-Forwarded-For` es una lista y la ULTIMA entrada la pone el proxy mas
 * cercano, no el cliente: la primera es la que dice el navegador y se puede
 * falsificar. Como el unico camino hasta esta API pasa por CloudFront (el grupo
 * de seguridad solo abre el 80 a la red del borde, docs/12), la primera entrada
 * es la que CloudFront escribio y es de fiar. Sin cabecera, se cae a un cubo
 * comun: preferimos limitar de mas a no limitar.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || c.req.header('cf-connecting-ip') || 'desconocido';
}

/**
 * Middleware que aplica un limitador. `key` decide POR QUE se limita: por llave
 * de API donde hay credencial, por IP donde todavia no la hay (el login).
 *
 * El 429 se construye aqui y no se lanza como `AppError` porque tiene que llevar
 * `Retry-After`, y el manejador de errores comun no sabe de cabeceras. El cuerpo
 * si respeta el contrato unico `{error:{code,message}}`.
 */
export function rateLimit(limiter: RateLimiter, key: (c: Context) => string) {
  return createMiddleware(async (c, next) => {
    const result = limiter.hit(key(c));

    c.header('X-RateLimit-Limit', String(limiter.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)));

    if (!result.allowed) {
      const error = new AppError(
        'RATE_LIMITED',
        `Demasiadas peticiones. Vuelve a intentarlo en ${result.retryAfterSeconds} segundos.`,
        429,
      );
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: { code: error.code, message: error.message } }, 429);
    }

    await next();
  });
}
