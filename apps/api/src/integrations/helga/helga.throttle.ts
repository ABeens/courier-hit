/**
 * Regulador del ritmo de SALIDA hacia Helga (docs/13 §3.7).
 *
 * El proveedor admite 60 peticiones por minuto. Nada en el codigo lo respetaba:
 * la sincronizacion consulta hasta 200 paquetes seguidos, el descubrimiento
 * recorre las paginas de la op. E sin pausa y las dos reconciliaciones empujan de
 * a 50, todo ademas del trafico que generan las personas (alta de casillero,
 * prealerta, fotos del detalle). Con relojes independientes por tarea, nadie
 * llevaba la cuenta de cuantas peticiones salian en el mismo minuto.
 *
 * ESTO NO RECHAZA, ESPERA. Es la diferencia con `core/rate-limit.ts`, que protege
 * la ENTRADA de nuestra API y responde 429 al que se pasa. Aqui el que se pasa
 * somos nosotros y no hay a quien responderle: la llamada se retiene hasta que
 * haya cupo. Por eso una corrida del robot ahora dura lo que le permita el cupo
 * (con el default, 200 consultas son unos 4,5 minutos) en vez de saturar el
 * minuto. Cabe de sobra en el intervalo de la tarea, que es de 15.
 *
 * DOS PRIORIDADES. Una corrida del robot encola cientos de llamadas de golpe; sin
 * prioridades, el cliente que abre el detalle de su paquete esperaria detras de
 * todas ellas. Las llamadas `interactive` (las que nacen de una persona) se
 * ponen a la CABEZA de la cola y adelantan a todo el robot; las `robot` van al
 * final, que es donde no le molestan a nadie. Si aun asi la espera se alarga
 * (muchas interactivas a la vez), la interactiva se rinde en vez de colgar la
 * pantalla: ver `INTERACTIVE_MAX_WAIT_MS`.
 *
 * EL CONTADOR VIVE EN MEMORIA DEL PROCESO, igual que el de entrada y por la misma
 * razon: hoy la API es UNA instancia (`infra/lib/app-stack.ts`, docs/12). El dia
 * que haya dos, cada una regulara lo suyo y el ritmo real se multiplicara por el
 * numero de instancias; el arreglo sera un contador compartido, no subir el tope.
 */
import { config } from '../../core/config';
import { ProviderErrors } from '../../core/errors';

/** Quien hace la llamada, y por tanto donde entra en la cola. */
export type HelgaCallPriority = 'interactive' | 'robot';

/** La ventana del proveedor: su tope esta expresado por minuto. */
const WINDOW_MS = 60_000;

/**
 * Cuanto esperar tras un 429 que no trae `Retry-After`. Un minuto entero es la
 * ventana completa del proveedor: si nos limito sin decir cuanto, lo unico
 * seguro es dejar pasar la ventana.
 */
export const DEFAULT_RETRY_AFTER_MS = WINDOW_MS;

/**
 * Cuanto puede esperar cupo una llamada INTERACTIVA antes de rendirse.
 *
 * Existe porque detras de una llamada interactiva hay una peticion HTTP abierta y
 * una persona mirando. Aunque se ponga a la cabeza de la cola, si llegan muchas a
 * la vez la ultima esperaria el cupo de todas las anteriores. Pasado este tiempo
 * se rinde con el mismo error que un 429: quien la pidio prefiere un "ahora no"
 * a una pantalla colgada. Por debajo de `HELGA_TIMEOUT_MS` (15s) a proposito, que
 * es lo que el llamador ya tolera para una peticion entera.
 *
 * Las llamadas del robot NO caducan: nadie las espera y su trabajo es justamente
 * drenar la cola al ritmo que se pueda.
 */
const INTERACTIVE_MAX_WAIT_MS = 10_000;

/** Una llamada esperando su turno. */
interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  /** 0 = interactiva (va primero), 1 = robot. */
  rank: number;
  /** Temporizador de caducidad (solo las interactivas lo tienen). */
  expiry: NodeJS.Timeout | null;
}

/**
 * Cuantas peticiones se permiten de golpe cuando el sistema viene de estar
 * quieto. Sin rafaga, dos llamadas seguidas de una misma pantalla se separarian
 * mas de un segundo aunque no haya nadie mas compitiendo por el cupo.
 *
 * NO es gratis: la rafaga se suma a lo que se repone dentro del mismo minuto, asi
 * que el ritmo sostenido se baja en la misma cantidad (ver el constructor). Ese
 * es el precio de que el tope valga para CUALQUIER minuto y no solo para los que
 * empiezan con el cubo vacio.
 */
const BURST = 10;

/**
 * Cubo de fichas: se reponen de forma continua (no de golpe al cambiar el
 * minuto) para que el ritmo sea parejo y no una rafaga por ventana.
 *
 * EL CUBO NO ARRANCA LLENO, y esto es lo unico fino del archivo. Un cubo cuya
 * capacidad es el tope entero deja pasar el DOBLE a caballo de dos ventanas: se
 * vacia de golpe (tope peticiones en un instante) y se repone entero dentro del
 * mismo minuto. Con el proceso recien levantado y el robot arrancando, ese es
 * justo el escenario que se daria. Por eso la capacidad es `BURST` y el ritmo de
 * reposicion es `limit - BURST`: sumados no pasan del tope en ningun minuto,
 * mires donde mires la ventana.
 */
class HelgaThrottle {
  /** Peticiones por ventana que se reponen; el resto del tope es la rafaga. */
  private readonly rate: number;
  /** Tope de fichas acumulables (la rafaga). */
  private readonly capacity: number;
  private tokens: number;
  private updatedAt = Date.now();
  private readonly queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Instante hasta el que no se manda nada, tras un 429 del proveedor. */
  private pausedUntil = 0;

  constructor(limit: number, private readonly windowMs: number = WINDOW_MS) {
    // Con un tope muy bajo no hay de donde sacar rafaga: manda el ritmo.
    this.capacity = Math.max(1, Math.min(BURST, Math.floor(limit / 2)));
    this.rate = Math.max(1, limit - this.capacity);
    this.tokens = this.capacity;
  }

  /** Retiene a quien llama hasta que haya cupo para una peticion. */
  async acquire(priority: HelgaCallPriority): Promise<void> {
    this.refill();
    // Camino rapido: sin cola, sin castigo y con ficha disponible. Se comprueba
    // que la cola este vacia para no adelantar a quien ya estaba esperando.
    if (this.queue.length === 0 && Date.now() >= this.pausedUntil && this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        rank: priority === 'interactive' ? 0 : 1,
        expiry: null,
      };
      if (priority === 'interactive') {
        waiter.expiry = setTimeout(() => this.giveUp(waiter), INTERACTIVE_MAX_WAIT_MS);
        waiter.expiry.unref?.();
      }
      this.enqueue(waiter);
    });
  }

  /**
   * El proveedor nos limito: nada sale hasta que pase el castigo. Ademas vacia el
   * cubo, porque volver con una rafaga de fichas acumuladas es justo lo que nos
   * limitaria otra vez.
   */
  pause(ms: number): void {
    if (ms <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.refill();
    this.tokens = 0;
    this.reschedule();
  }

  /** Saca de la cola a quien se canso de esperar y le devuelve el error. */
  private giveUp(waiter: Waiter): void {
    const at = this.queue.indexOf(waiter);
    if (at < 0) return; // ya lo habian servido
    this.queue.splice(at, 1);
    waiter.reject(ProviderErrors.rateLimited());
  }

  /** Inserta respetando la prioridad; dentro de la misma, por orden de llegada. */
  private enqueue(waiter: Waiter): void {
    let at = this.queue.length;
    while (at > 0 && (this.queue[at - 1] as Waiter).rank > waiter.rank) at -= 1;
    this.queue.splice(at, 0, waiter);
    this.reschedule();
  }

  /** Repone fichas por el tiempo transcurrido, sin pasar del tope. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.updatedAt;
    if (elapsed <= 0) return;
    this.updatedAt = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.rate) / this.windowMs);
  }

  /** Reparte las fichas disponibles entre los que esperan, y se reagenda. */
  private readonly pump = (): void => {
    this.timer = null;
    this.refill();

    const now = Date.now();
    if (now < this.pausedUntil) {
      this.schedule(this.pausedUntil - now);
      return;
    }

    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.queue.shift() as Waiter;
      if (waiter.expiry) clearTimeout(waiter.expiry);
      waiter.resolve();
    }

    if (this.queue.length > 0) this.schedule(this.msUntilNextToken());
  };

  private reschedule(): void {
    if (this.timer !== null || this.queue.length === 0) return;
    const now = Date.now();
    this.schedule(now < this.pausedUntil ? this.pausedUntil - now : this.msUntilNextToken());
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(this.pump, Math.max(1, Math.ceil(ms)));
    // Una espera de cupo no debe impedir que el proceso termine cuando le manden
    // la señal de apagado, igual que los temporizadores del scheduler.
    this.timer.unref?.();
  }

  private msUntilNextToken(): number {
    return Math.max(1, Math.ceil(((1 - this.tokens) * this.windowMs) / this.rate));
  }
}

/**
 * Un unico regulador para TODA la salida hacia el proveedor: el tope es de la
 * cuenta que nos dieron, no de cada tarea. Se crea perezosamente porque `config`
 * ya esta resuelto cuando llega la primera llamada, y no al cargar el modulo.
 */
let instance: HelgaThrottle | null = null;

function throttle(): HelgaThrottle {
  if (instance === null) instance = new HelgaThrottle(config.HELGA_RATE_LIMIT_PER_MIN);
  return instance;
}

/** Espera a que haya cupo para una peticion al proveedor. */
export function acquireHelgaSlot(priority: HelgaCallPriority): Promise<void> {
  return throttle().acquire(priority);
}

/** Detiene toda la salida durante `ms` (lo que pidio el proveedor en un 429). */
export function pauseHelgaCalls(ms: number): void {
  throttle().pause(ms);
}

/**
 * Cuanto pidio esperar el proveedor, en milisegundos, o null si no lo dijo.
 * `Retry-After` admite dos formas (segundos o fecha HTTP) y las dos se ven en la
 * practica, asi que se contemplan las dos.
 */
export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}
