/**
 * Exclusion mutua ENTRE INSTANCIAS para una tarea del scheduler, con advisory
 * locks de Postgres. Es la red de seguridad para el dia que la API corra en mas
 * de una instancia (Fargate, autoscaling): sin esto, cada instancia dispararia
 * la misma tarea a la vez (trabajo duplicado, carreras al escribir, avisos
 * dobles al cliente). Con esto, solo la instancia que gane el candado corre; las
 * demas se saltan esa vuelta.
 *
 * Tres decisiones que viven aqui:
 *
 * 1. CANDADO DE SESION SOBRE UNA CONEXION DEDICADA. Un advisory lock de sesion
 *    vive atado a la conexion que lo tomo. Con un pool, pedirlo en una conexion
 *    y soltarlo en otra no funcionaria, asi que reservamos UNA conexion y la
 *    usamos para tomar el candado, mantenerlo mientras corre la tarea y soltarlo.
 *    El trabajo de la tarea usa el pool normal (`db`): la conexion reservada solo
 *    sostiene el candado.
 *
 *    Se descarto `pg_advisory_xact_lock` (atado a transaccion) a proposito: las
 *    tareas de sincronizacion hacen muchas transacciones cortas y llamadas HTTP
 *    al proveedor; sostener UNA transaccion abierta durante todo eso seria una
 *    transaccion larga con I/O externo, que es justo lo que no se debe hacer.
 *
 * 2. A PRUEBA DE CRASH SIN ESFUERZO. Si el proceso muere a mitad, la conexion se
 *    cae y Postgres libera el candado de sesion solo. No queda pegado.
 *
 * 3. UN CANDADO POR TAREA. Cada tarea trae su propia `key` (ver `jobs.ts`): dos
 *    instancias de la MISMA tarea no se solapan, pero tareas DISTINTAS si pueden
 *    correr a la vez.
 */
import { sql } from '../db';

/**
 * Envuelve el handler de una tarea para que solo lo ejecute la instancia que
 * tome el advisory lock `key`. Si otra instancia ya lo tiene, esta corrida se
 * omite (sin esperar) y se reintenta en el proximo intervalo.
 */
export function withLock(
  key: number,
  label: string,
  handler: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    const conn = await sql.reserve();
    try {
      const [row] = await conn<{ locked: boolean }[]>`select pg_try_advisory_lock(${key}) as locked`;
      if (!row?.locked) {
        console.log(`[scheduler] "${label}": otra instancia tiene el candado; se omite esta corrida.`);
        return;
      }
      try {
        await handler();
      } finally {
        // Soltar SIEMPRE, aunque el handler falle: si no, el candado quedaria
        // tomado en esta conexion hasta que se cierre.
        await conn`select pg_advisory_unlock(${key})`;
      }
    } finally {
      conn.release();
    }
  };
}
