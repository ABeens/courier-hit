/**
 * Pantalla "Recepción" (permiso package.receive) — Requerimientos Parte 4.
 *
 * Es una mesa de bodega: el operador escanea con pistola y el cursor no debe
 * salir nunca del campo del LES. Por eso el input se re-enfoca solo tras cada
 * registro y el formulario se envía con Enter, que es lo que la pistola emite al
 * terminar de leer un código.
 *
 * Lo que se escanea es el LES (HAWB), el número que la bodega de Miami imprime
 * en la etiqueta del bulto, no el tracking de la tienda.
 *
 * Dos desenlaces, los dos del manual:
 *   - el trámite existe  -> pasa a "Facturación en proceso";
 *   - no existe          -> se avisa para darlo de alta manualmente.
 * El segundo no se pinta como error rojo porque no lo es: es una rama esperada
 * del flujo (una compra que el cliente nunca prealertó).
 *
 * Pero esos dos no agotan lo que puede pasar, y por eso el desenlace se decide
 * por el `code` del error y no por "falló / no falló": mandar a dar de alta un
 * paquete que en realidad está duplicado, ya recibido o mal digitado crea un
 * trámite fantasma, que es peor que no haber escaneado nada.
 */
import { useEffect, useRef, useState } from 'react';
import { SHIPMENT_TYPE_LABELS, STATE_LABELS, clientName, receiveShipmentSchema } from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/datetime';
import { UnassignedFormModal } from './UnassignedFormModal';

/** Lo registrado en esta sesión de trabajo, del más reciente al más antiguo. */
interface LogEntry {
  at: string;
  hawb: string;
  shipment: ShipmentDto | null;
  message: string;
  ok: boolean;
  /** Qué hacer con este bulto. Es lo que el operador lee de reojo sin soltar la pistola. */
  label: string;
  /** Clase de tono de la tarjeta; ver `.tone-*` en portal.css. */
  tone: string;
  /**
   * El LES no resolvió a ningún trámite. Es la única rama que ofrece registrar el
   * bulto como paquete sin dueño; las demás (duplicado, ya recibido, LES mal
   * digitado) se resuelven en otro sitio, y dar de alta ahí crearía un fantasma.
   */
  unknown?: boolean;
}

/**
 * Desenlace de un escaneo fallido. Solo el LES desconocido deriva al alta
 * manual; el resto son cosas que se resuelven en otro lado, y decirle "ingresar
 * manual" al operador lo llevaría a duplicar un trámite que ya existe.
 */
function outcomeFor(err: unknown): Pick<LogEntry, 'label' | 'tone' | 'message' | 'unknown'> {
  const code = err instanceof ApiError ? err.code : 'NETWORK';
  const message =
    err instanceof ApiError && err.message
      ? err.message
      : 'No se pudo registrar la recepción. Reintenta.';

  switch (code) {
    case 'RECEPTION_UNKNOWN_HAWB':
      return { label: 'Ingresar manual', tone: 'tone-warn', message, unknown: true };
    case 'RECEPTION_ALREADY_RECEIVED':
      return { label: 'Ya recibido', tone: 'tone-info', message };
    case 'RECEPTION_AMBIGUOUS_HAWB':
      return { label: 'Revisar en Trámites', tone: 'tone-danger', message };
    default:
      // Validación del LES, sesión caída, API sin responder: no hay nada que
      // dar de alta, hay que corregir lo digitado o avisar a soporte.
      return { label: 'No se registró', tone: 'tone-danger', message };
  }
}

/**
 * `canRegisterUnassigned` (permiso control_room.manage) abre el atajo del LES
 * desconocido: registrar ahí mismo el bulto como paquete sin dueño, con el
 * código ya escaneado. Sin el permiso la bitácora sigue diciendo «Ingresar
 * manual», que es lo que había: quien no puede registrar desconocidos tiene que
 * escalarlo, no quedarse mirando un botón que le va a devolver un 403.
 */
export function ReceptionScreen({ canRegisterUnassigned = false }: { canRegisterUnassigned?: boolean }) {
  const [hawb, setHawb] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** LES desconocido que se está dando de alta como paquete sin dueño. */
  const [registering, setRegistering] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * Anota el desenlace del bulto y deja la mesa lista para el siguiente: limpia
   * el campo y le devuelve el foco. Los tres caminos (validación, recibido,
   * error de la API) terminan aquí, porque para el operador los tres son lo
   * mismo, una línea más en la bitácora y la pistola libre.
   */
  function record(entry: Omit<LogEntry, 'at'>) {
    setLog((prev) => [{ at: new Date().toISOString(), ...entry }, ...prev]);
    setHawb('');
    inputRef.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = hawb.trim();
    if (!value || busy) return;

    // Se valida aquí y no solo en la API, como el resto de los formularios del
    // portal: en la mesa de bodega la pistola va más rápido que un ida y vuelta
    // al servidor para avisar que el código venía mal. `parsed.data` sale ya
    // normalizado (trim + mayúsculas) y es lo que se envía, así que el mismo LES
    // leído en otra caja no termina resolviendo a un trámite distinto.
    const parsed = receiveShipmentSchema.safeParse({ hawb: value });
    if (!parsed.success) {
      record({
        hawb: value,
        shipment: null,
        ok: false,
        label: 'No se registró',
        tone: 'tone-danger',
        message: parsed.error.issues[0]?.message ?? 'Datos inválidos.',
      });
      return;
    }

    setBusy(true);
    try {
      const shipment = await api.post<ShipmentDto>('/shipments/receive', parsed.data);
      record({
        hawb: parsed.data.hawb,
        shipment,
        message: `${shipment.code} · ${clientName(shipment.client)} → ${STATE_LABELS[shipment.state]}`,
        ok: true,
        label: 'Recibido',
        tone: 'tone-ok',
      });
    } catch (err) {
      record({ hawb: parsed.data.hawb, shipment: null, ok: false, ...outcomeFor(err) });
    } finally {
      setBusy(false);
    }
  }

  const received = log.filter((entry) => entry.ok).length;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Recepción en bodega</div>
          <div className="count">
            {received} recibidos en esta sesión · {log.length - received} sin registrar
          </div>
        </div>
      </div>

      <form onSubmit={submit} className="scan-row">
        <input
          ref={inputRef}
          className="input search mono"
          placeholder="Escanea o digita el LES (HAWB), p. ej. LES48450141…"
          value={hawb}
          autoComplete="off"
          onChange={(e) => setHawb(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Registrando…' : 'Registrar'}
        </button>
      </form>

      <div className="cards">
        {log.map((entry) => (
          <article className={`card-item ${entry.tone}`} key={`${entry.at}-${entry.hawb}`}>
            <div className="card-item-head">
              <div className="card-item-ident">
                <div className="card-item-code mono">{entry.hawb}</div>
                <div className="card-item-title">{entry.message}</div>
                {entry.shipment && (
                  <div className="card-item-sub">
                    {SHIPMENT_TYPE_LABELS[entry.shipment.shipmentType]} ·{' '}
                    {entry.shipment.description}
                  </div>
                )}
              </div>
              <div className="card-item-aside">
                <span className="spill">
                  <span className="dot" />
                  {entry.label}
                </span>
                {/* El bulto está en la mesa AHORA: registrarlo aquí, con el LES
                    ya escaneado, evita el viaje a otra pantalla a redigitarlo. */}
                {entry.unknown && canRegisterUnassigned && (
                  <IconButton
                    label="Registrar sin dueño"
                    icon="userPlus"
                    onClick={() => setRegistering(entry.hawb)}
                  />
                )}
                <div className="card-item-sub">{formatDateTime(entry.at)}</div>
              </div>
            </div>
          </article>
        ))}
      </div>

      {log.length === 0 && (
        <div className="empty">
          Escanea el primer paquete para empezar. Los que no estén en el sistema se marcarán
          para ingresarlos a mano.
        </div>
      )}

      {registering !== null && (
        <UnassignedFormModal
          mode="create"
          initialHawb={registering}
          onClose={() => setRegistering(null)}
          onSaved={(message) => {
            setRegistering(null);
            record({
              hawb: registering,
              shipment: null,
              ok: true,
              label: 'Sin dueño',
              tone: 'tone-info',
              message,
            });
          }}
        />
      )}
    </div>
  );
}
