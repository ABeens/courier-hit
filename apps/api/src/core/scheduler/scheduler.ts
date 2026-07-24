/**
 * Scheduler ("robot"): ejecuta varias tareas en segundo plano, cada una en su
 * propio intervalo configurable. Es un motor generico y sin dependencias del
 * dominio: recibe tareas ya construidas (ver `jobs.ts`) y se encarga solo de
 * cuando y como dispararlas.
 *
 * Cuatro decisiones que viven aqui:
 *
 * 1. INTERVALO ENTRE FINALES, NO ENTRE INICIOS. Cada tarea se reprograma cuando
 *    TERMINA la corrida anterior (setTimeout recursivo), no con `setInterval`.
 *    Asi una tarea lenta nunca se solapa consigo misma ni acumula corridas
 *    atrasadas si el proceso se congela un rato.
 * 2. UNA TAREA QUE FALLA NO TUMBA AL ROBOT. Cada corrida va envuelta en try/catch;
 *    el error se registra y la tarea se reprograma igual. Un fallo del proveedor
 *    no puede dejar sin agendar a las demas tareas.
 * 3. LAS TAREAS SON INDEPENDIENTES. Cada una tiene su propio temporizador; el
 *    ritmo de una no afecta a las otras.
 * 4. APAGADO LIMPIO. `stop()` cancela los temporizadores pendientes; una corrida
 *    en curso termina sola (no se interrumpe a la fuerza).
 */
import { formatDuration, parseDuration } from './duration';

/** Una tarea a agendar. `every` acepta una duracion legible ("15m") o ms. */
export interface ScheduledJob {
  /** Nombre corto para los logs; unico dentro del scheduler. */
  name: string;
  /** Cada cuanto correr: duracion legible ("2h", "30m") o milisegundos. */
  every: string | number;
  /** El trabajo en si. Puede ser async; el scheduler espera a que termine. */
  handler: () => Promise<void> | void;
  /**
   * Si true, se corre una vez de inmediato al arrancar (ademas de cada
   * intervalo). Por defecto false: espera un intervalo completo antes de la
   * primera corrida.
   */
  runOnStart?: boolean;
}

/** Estado interno de una tarea ya registrada (intervalo ya resuelto a ms). */
interface RegisteredJob {
  name: string;
  everyMs: number;
  handler: () => Promise<void> | void;
  runOnStart: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

export class Scheduler {
  private readonly jobs = new Map<string, RegisteredJob>();
  private started = false;

  /**
   * Registra una tarea. Resuelve el intervalo a milisegundos aqui mismo: si la
   * duracion esta mal escrita, preferimos fallar al registrar (arranque) que
   * descubrirlo en la primera corrida.
   */
  register(job: ScheduledJob): this {
    if (this.jobs.has(job.name)) {
      throw new Error(`[scheduler] ya existe una tarea llamada "${job.name}".`);
    }
    const everyMs = typeof job.every === 'number' ? job.every : parseDuration(job.every);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error(`[scheduler] intervalo invalido para "${job.name}": ${job.every}`);
    }
    this.jobs.set(job.name, {
      name: job.name,
      everyMs,
      handler: job.handler,
      runOnStart: job.runOnStart ?? false,
      timer: null,
      running: false,
    });
    return this;
  }

  /** Cuantas tareas hay registradas (util para decidir si vale la pena arrancar). */
  get size(): number {
    return this.jobs.size;
  }

  /** Arranca todos los temporizadores. Idempotente: llamar dos veces no duplica. */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const job of this.jobs.values()) {
      console.log(`[scheduler] tarea "${job.name}" cada ${formatDuration(job.everyMs)}.`);
      if (job.runOnStart) {
        // Sin await: el arranque del servidor no debe esperar a la primera corrida.
        void this.runNow(job);
      } else {
        this.schedule(job);
      }
    }

    console.log(`[scheduler] activo con ${this.jobs.size} tarea(s).`);
  }

  /** Cancela los temporizadores pendientes. Una corrida en curso termina sola. */
  stop(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
    this.started = false;
    console.log('[scheduler] detenido.');
  }

  /** Programa la proxima corrida de una tarea dentro de su intervalo. */
  private schedule(job: RegisteredJob): void {
    job.timer = setTimeout(() => {
      void this.runNow(job);
    }, job.everyMs);
    // No mantener vivo el proceso solo por este temporizador: si todo lo demas
    // (el servidor HTTP) se apaga, el robot no debe impedir que Node salga.
    job.timer.unref?.();
  }

  /**
   * Ejecuta una tarea, mide su duracion, aisla sus errores y reprograma la
   * siguiente corrida cuando esta termina (decisiones 1 y 2).
   */
  private async runNow(job: RegisteredJob): Promise<void> {
    // Proteccion de solape: si por lo que sea la corrida anterior sigue viva
    // (p. ej. runOnStart + un intervalo muy corto), no lanzamos otra encima.
    if (job.running) {
      console.warn(`[scheduler] "${job.name}" sigue en curso; se omite esta corrida.`);
      return;
    }

    job.running = true;
    const startedAt = process.hrtime.bigint();
    try {
      await job.handler();
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      console.log(`[scheduler] "${job.name}" ok en ${ms.toFixed(0)}ms.`);
    } catch (err) {
      console.error(`[scheduler] "${job.name}" fallo:`, err);
    } finally {
      job.running = false;
      // Reprogramar solo si el scheduler sigue activo (no tras un stop()).
      if (this.started) this.schedule(job);
    }
  }
}
