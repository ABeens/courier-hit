/**
 * Pantalla "Resumen" (permiso dashboard.read).
 *
 * No es un tablero de metricas: son las COLAS DE TRABAJO del dia. Cada cifra
 * responde a "¿que tengo pendiente?" y ES un boton que abre la pantalla donde
 * se resuelve, ya filtrada por esa cola. Un numero que no se puede accionar
 * solo ocupa espacio, y llegar a la pantalla destino para tener que rehacer a
 * mano el filtro que uno acaba de pulsar convierte el atajo en dos pasos.
 *
 * Reparte a lo ancho (la cascara le suelta el limite de 1100px):
 *   - arriba, la fila de colas — lo que espera una accion de alguien;
 *   - abajo a la izquierda, los ultimos ingresos — que esta entrando;
 *   - abajo a la derecha, los repartos por tipo y por estado — donde esta
 *     parada la operacion entera, no solo lo accionable.
 *
 * Cada cola lleva el tono de su estado (el mismo de la ficha en Paqueteria) y
 * se APAGA cuando esta en cero: asi el ojo cae primero en lo que tiene trabajo
 * en vez de recorrer seis recuadros identicos.
 */
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import {
  Flow,
  ProformaStatus,
  Resource,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  State,
  flowForType,
} from '@courier/shared';
import type { ShipmentType } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';
import { STATE_TONE } from '../lib/tone';
import type { Tone } from '../lib/tone';
import type { NavIntent } from '../lib/nav';
import type { ShipmentView } from './ShipmentsScreen';

interface Queue {
  state: State;
  label: string;
  total: number;
}

interface RecentRow {
  id: string;
  code: string;
  /** HAWB (LES). Nulo mientras el bulto no ha llegado a Miami. */
  hawb: string | null;
  shipmentType: ShipmentType;
  state: State;
  tracking: string;
  clientName: string;
  createdAt: string;
}

interface Summary {
  queues: Queue[];
  /** Proformas de Transporte aprobadas y sin pagar (no es un estado del trámite). */
  transportUnpaid: number;
  /** Proformas de Paquetería aprobadas y sin pagar. */
  packageUnpaid: number;
  pendingPayments: number;
  byType: { shipmentType: ShipmentType; total: number }[];
  /** Todos los estados con al menos un trámite, no solo los accionables. */
  byState: { state: State; total: number }[];
  recent: RecentRow[];
}

/** A donde lleva un cuadro. `name` es lo que se anuncia en el pie del cuadro. */
interface Target {
  resource: Resource;
  name: string;
  intent?: NavIntent;
}

interface Props {
  /**
   * Recursos que el rol puede abrir. El Resumen lo ve mas de un rol y no todos
   * llegan a las mismas pantallas: un cuadro sin destino permitido se pinta,
   * pero no navega (la cifra sigue siendo informacion util para quien la ve).
   */
  allowed: ReadonlySet<Resource>;
  onNavigate: (resource: Resource, intent?: NavIntent) => void;
}

/**
 * Listado de trámites acotado a un estado. La vista va con el tipo de trámite
 * de la cola: un estado que solo existe en Paquetería abre el tablero de
 * Paquetería, y uno de varios flujos, la vista amplia.
 */
function boardFor(state: State, view: ShipmentView = 'todos', name = 'Ver listado'): Target {
  return { resource: Resource.Package, name, intent: { view, state } };
}

/** Rotulo corto de cada flujo en la ficha del cuadro. */
const FLOW_SHORT: Record<Flow, string> = {
  [Flow.Paqueteria]: 'Paquetería',
  [Flow.Transporte]: 'Transporte',
  [Flow.Agenciamiento]: 'Agenciamiento',
};

const ALL_FLOWS: Flow[] = [Flow.Paqueteria, Flow.Transporte, Flow.Agenciamiento];

/**
 * Que se hace con cada cola, donde, y de que tipo de trámite es (`flows`: los
 * flujos que pasan por ese estado, segun la maquina de estados). Los destinos
 * van en orden de preferencia: se usa el primero que el rol pueda abrir, y el
 * listado de trámites queda siempre de ultimo como salida universal.
 *
 * Es un Partial a proposito: si la API agrega una cola nueva, la pantalla la
 * pinta igual con el destino generico en vez de romperse.
 */
const QUEUE_META: Partial<
  Record<State, { hint: string; icon: ReactElement; targets: Target[]; flows: Flow[] }>
> = {
  /* Los prealertados no se "trabajan" desde aqui: el paquete llega a bodega y
     se recibe por su tracking, no eligiendo de una lista. El cuadro es solo la
     cifra de lo anunciado y por eso no lleva a ninguna pantalla. */
  [State.Prealertado]: {
    hint: 'Anunciados por el cliente, aún sin recibir en bodega',
    icon: <path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />,
    targets: [],
    flows: ALL_FLOWS,
  },
  [State.FacturacionEnProceso]: {
    hint: 'Proformas en borrador de los tres tipos: falta revisarlas y aprobarlas',
    icon: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
    targets: [
      {
        resource: Resource.Proformas,
        name: 'Proformas en borrador',
        intent: { proformaStatus: ProformaStatus.Borrador },
      },
      boardFor(State.FacturacionEnProceso),
    ],
    flows: ALL_FLOWS,
  },
  /* Solo Transporte: se entrega antes de cobrar, así que este cuadro es la
     mercadería que ya salió y nadie ha facturado. NO lleva a los borradores de
     proforma: el borrador nace al pasar a "Facturación en proceso", así que
     estos trámites todavía no tienen uno. Lo que falta es ese avance, y se
     hace desde el tablero de Trámites. */
  [State.EntregadoPendientePago]: {
    hint: 'Ya entregados: falta pasarlos a facturación',
    icon: <path d="M20 6L9 17l-5-5" />,
    targets: [
      {
        resource: Resource.Tramite,
        name: 'Trámites de Transporte',
        intent: { state: State.EntregadoPendientePago },
      },
      boardFor(State.EntregadoPendientePago, 'transporte', 'Trámites de Transporte'),
    ],
    flows: [Flow.Transporte],
  },
  [State.EnBodegaPendientePago]: {
    hint: 'Paquetes en bodega: salen a ruta cuando su proforma está pagada',
    icon: <path d="M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2zM1 10h22" />,
    targets: [boardFor(State.EnBodegaPendientePago, 'paqueteria', 'Paquetería')],
    flows: [Flow.Paqueteria],
  },
  /* Solo Agenciamiento: la proforma ya emitida esperando el pago. Sin ese pago
     el trámite no entra a aduana, así que la cola bloquea el expediente entero. */
  [State.ProformaPendientePago]: {
    hint: 'Proformas emitidas sin pagar: sin el pago no entra a aduana',
    icon: <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8" />,
    targets: [
      {
        resource: Resource.Proformas,
        name: 'Proformas de Agenciamiento',
        intent: { proformaStatus: ProformaStatus.Aprobada, proformaFlow: Flow.Agenciamiento },
      },
      boardFor(State.ProformaPendientePago, 'transporte', 'Trámites de Agenciamiento'),
    ],
    flows: [Flow.Agenciamiento],
  },
  [State.EnRutaEntrega]: {
    hint: 'En manos del mensajero, pendientes de confirmar',
    icon: <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 21a2 2 0 100-4 2 2 0 000 4zM18.5 21a2 2 0 100-4 2 2 0 000 4z" />,
    targets: [
      { resource: Resource.Delivery, name: 'Entregas' },
      boardFor(State.EnRutaEntrega, 'paqueteria', 'Paquetería'),
    ],
    flows: [Flow.Paqueteria],
  },
  [State.DevueltoBodega]: {
    hint: 'La entrega falló: hay que reprogramarlas',
    icon: <path d="M1 4v6h6M3.51 15a9 9 0 102.13-9.36L1 10" />,
    targets: [boardFor(State.DevueltoBodega, 'paqueteria', 'Paquetería')],
    flows: [Flow.Paqueteria],
  },
};

const CHECK_ICON = <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />;

/** Forma comun de los cuadros que no son un estado del tramite. */
interface ExtraTile {
  label: string;
  hint: string;
  tone: Tone;
  icon: ReactElement;
  targets: Target[];
  flows: Flow[];
}

/**
 * Cuadro del cobro de Paqueteria: proformas de paquetes aprobadas y sin pagar.
 * Va por proforma y no por el estado "En bodega preparando" porque Paqueteria
 * agrupa los paquetes de un cliente en una sola proforma, y es esa la que se
 * cobra. Lleva a la misma bandeja que cuenta.
 */
const PACKAGE_UNPAID_TILE: ExtraTile = {
  label: 'Paquetería por cobrar',
  hint: 'Proformas de Paquetería aprobadas, sin pagar',
  tone: STATE_TONE[State.EnBodegaPendientePago],
  icon: <path d="M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2zM1 10h22" />,
  targets: [
    {
      resource: Resource.Proformas,
      name: 'Proformas de Paquetería',
      intent: { proformaStatus: ProformaStatus.Aprobada, proformaFlow: Flow.Paqueteria },
    },
  ],
  flows: [Flow.Paqueteria],
};

/**
 * Cuadro del cobro de Transporte. No es un estado: Transporte factura y cobra
 * sin salir de "Facturación en proceso", así que lo facturado y sin pagar no
 * cae en ninguna cola por estado. Cuenta proformas aprobadas de Transporte y
 * lleva a esa misma bandeja, para que el cuadro y el destino digan lo mismo.
 */
const TRANSPORT_UNPAID_TILE: ExtraTile = {
  label: 'Transporte por cobrar',
  hint: 'Proformas de Transporte aprobadas, sin pagar',
  tone: STATE_TONE[State.FacturacionEnProceso],
  icon: <path d="M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2zM1 10h22" />,
  targets: [
    {
      resource: Resource.Proformas,
      name: 'Proformas de Transporte',
      intent: { proformaStatus: ProformaStatus.Aprobada, proformaFlow: Flow.Transporte },
    },
  ],
  flows: [Flow.Transporte],
};

/**
 * Cuadro de los depositos: no es un estado del trámite, es cola de tesoreria.
 *
 * Lleva a la bandeja de Proformas acotada a las que tienen un pago sin validar:
 * el cobro es por proforma completa, y es en su detalle donde el deposito se
 * aprueba o se rechaza. La cifra es de proformas, igual que esa bandeja, para
 * que el cuadro y la cabecera de destino digan lo mismo.
 */
const PAYMENTS_TILE: ExtraTile = {
  label: 'Depósitos por validar',
  hint: 'Proformas con un pago registrado, sin revisar',
  tone: 'info',
  icon: CHECK_ICON,
  targets: [
    {
      resource: Resource.Proformas,
      name: 'Validar depósitos',
      intent: { pendingValidation: true },
    },
  ],
  flows: ALL_FLOWS,
};

/** Primer destino que el rol puede abrir; null si no puede abrir ninguno. */
function pickTarget(targets: Target[], allowed: ReadonlySet<Resource>): Target | null {
  return targets.find((t) => allowed.has(t.resource)) ?? null;
}

/** El tablero donde vive un trámite, segun su flujo. */
function targetForType(type: ShipmentType): Target {
  return flowForType(type) === Flow.Paqueteria
    ? { resource: Resource.Package, name: 'Paquetería', intent: { view: 'paqueteria' } }
    : { resource: Resource.Tramite, name: 'Trámites' };
}

export function DashboardScreen({ allowed, onNavigate }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Summary>('/dashboard')
      .then(setData)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el resumen.'),
      );
  }, []);

  const pending = data
    ? data.queues.reduce((sum, q) => sum + q.total, 0) +
      data.packageUnpaid +
      data.transportUnpaid +
      data.pendingPayments
    : 0;
  const headline = !data
    ? 'Colas de trabajo del día'
    : pending === 0
      ? 'Todo al día: no hay nada esperando'
      : `${pending} ${pending === 1 ? 'pendiente espera' : 'pendientes esperan'} una acción`;

  /** Repartos de mayor a menor: en un reparto lo que se busca es quien manda. */
  const byType = data ? [...data.byType].sort((a, b) => b.total - a.total) : [];
  const byState = data ? [...data.byState].sort((a, b) => b.total - a.total) : [];
  const totalTypes = byType.reduce((sum, r) => sum + r.total, 0);
  const totalStates = byState.reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Resumen</div>
          <div className="count">{headline}</div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="dash">
        <section className="dash-block">
          <div className="dash-block-head">
            <h3 className="dash-block-title">Colas de trabajo</h3>
            <span className="dash-block-hint">Cada cuadro abre la pantalla donde se resuelve</span>
          </div>
          <div className="dash-queues">
            {!data &&
              !error &&
              /* Esqueleto: sin el, el bloque salta de vacio a lleno y la pantalla
                 parece rota mientras carga. */
              /* Tantos como cuadros reales (7 colas + Paquetería + Transporte +
                 Depositos): con menos, la fila salta al terminar de cargar. */
              [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => <div className="dash-tile is-skeleton" key={i} />)}

            {data?.queues.map((queue) => {
              const meta = QUEUE_META[queue.state];
              return (
                <Tile
                  key={queue.state}
                  total={queue.total}
                  label={queue.label}
                  hint={meta?.hint ?? STATE_LABELS[queue.state]}
                  tone={STATE_TONE[queue.state]}
                  icon={meta?.icon ?? CHECK_ICON}
                  flows={meta?.flows ?? ALL_FLOWS}
                  target={pickTarget(meta?.targets ?? [boardFor(queue.state)], allowed)}
                  onNavigate={onNavigate}
                />
              );
            })}

            {data && (
              <Tile
                total={data.packageUnpaid}
                label={PACKAGE_UNPAID_TILE.label}
                hint={PACKAGE_UNPAID_TILE.hint}
                tone={PACKAGE_UNPAID_TILE.tone}
                icon={PACKAGE_UNPAID_TILE.icon}
                flows={PACKAGE_UNPAID_TILE.flows}
                target={pickTarget(PACKAGE_UNPAID_TILE.targets, allowed)}
                onNavigate={onNavigate}
              />
            )}

            {data && (
              <Tile
                total={data.transportUnpaid}
                label={TRANSPORT_UNPAID_TILE.label}
                hint={TRANSPORT_UNPAID_TILE.hint}
                tone={TRANSPORT_UNPAID_TILE.tone}
                icon={TRANSPORT_UNPAID_TILE.icon}
                flows={TRANSPORT_UNPAID_TILE.flows}
                target={pickTarget(TRANSPORT_UNPAID_TILE.targets, allowed)}
                onNavigate={onNavigate}
              />
            )}

            {data && (
              <Tile
                total={data.pendingPayments}
                label={PAYMENTS_TILE.label}
                hint={PAYMENTS_TILE.hint}
                tone={PAYMENTS_TILE.tone}
                icon={PAYMENTS_TILE.icon}
                flows={PAYMENTS_TILE.flows}
                target={pickTarget(PAYMENTS_TILE.targets, allowed)}
                onNavigate={onNavigate}
              />
            )}
          </div>
        </section>

        <div className="dash-main">
          <section className="dash-block">
            <div className="dash-block-head">
              <h3 className="dash-block-title">Últimos ingresos</h3>
              <span className="dash-block-hint">Toca una fila para abrir el trámite</span>
            </div>
            <div className="table-wrap">
              <table className="table table-dense">
                <thead>
                  <tr>
                    <th>HAWB (LES)</th>
                    <th>Trámite</th>
                    <th>Cliente</th>
                    <th>Tracking</th>
                    <th>Estatus</th>
                    <th>Ingreso</th>
                    <th aria-hidden="true" />
                  </tr>
                </thead>
                {data?.recent.map((row) => {
                  const target = pickTarget([targetForType(row.shipmentType)], allowed);
                  /* La fila no lleva a una ficha (no existe pantalla de detalle):
                     abre el tablero del trámite con su consecutivo ya buscado,
                     que es donde estan todas sus acciones. */
                  const open = target
                    ? () => onNavigate(target.resource, { ...target.intent, q: row.code })
                    : undefined;
                  /* Cada trámite es un GRUPO de dos filas dentro de su propio
                     <tbody>: arriba el consecutivo, en pequeño y a lo ancho, y
                     debajo los datos con el LES de primera columna. El grupo es
                     lo que se pulsa y lo que se ilumina, no cada fila suelta. */
                  return (
                    <tbody
                      key={row.id}
                      className={open ? 'row-group is-link' : 'row-group'}
                      onClick={open}
                      tabIndex={open ? 0 : undefined}
                      onKeyDown={(e) => {
                        if (open && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          open();
                        }
                      }}
                    >
                      <tr className="row-lead">
                        <td colSpan={7}>
                          <small className="mono">{row.code}</small>
                        </td>
                      </tr>
                      <tr>
                        <td className="mono">{row.hawb ?? '—'}</td>
                        <td>{SHIPMENT_TYPE_LABELS[row.shipmentType]}</td>
                        <td>{row.clientName}</td>
                        <td className="mono">{row.tracking}</td>
                        <td>
                          <span className={`spill is-toned tone-${STATE_TONE[row.state]}`}>
                            <span className="dot" />
                            {STATE_LABELS[row.state]}
                          </span>
                        </td>
                        <td>{formatDate(row.createdAt)}</td>
                        <td className="cell-go">{open && <Chevron />}</td>
                      </tr>
                    </tbody>
                  );
                })}
              </table>
            </div>
            {data && data.recent.length === 0 && <div className="empty">Todavía no hay trámites.</div>}
          </section>

          {/* Los dos repartos. No son colas: son "donde esta parada la operacion",
              y por eso van en la columna angosta y en filas y no en cuadros. */}
          <aside className="dash-side">
            {data && byType.length > 0 && (
              <section className="dash-panel">
                <div className="dash-panel-head">
                  <h3 className="dash-panel-title">Por tipo de trámite</h3>
                  <span className="dash-panel-total">{totalTypes}</span>
                </div>
                <div className="dash-rows">
                  {byType.map((row) => (
                    <DistRow
                      key={row.shipmentType}
                      label={SHIPMENT_TYPE_LABELS[row.shipmentType]}
                      total={row.total}
                      max={totalTypes}
                      className={`flow-${flowForType(row.shipmentType)}`}
                      target={pickTarget([targetForType(row.shipmentType)], allowed)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </section>
            )}

            {data && byState.length > 0 && (
              <section className="dash-panel">
                <div className="dash-panel-head">
                  <h3 className="dash-panel-title">Por estado</h3>
                  <span className="dash-panel-total">{totalStates}</span>
                </div>
                <div className="dash-rows">
                  {byState.map((row) => (
                    <DistRow
                      key={row.state}
                      label={STATE_LABELS[row.state]}
                      total={row.total}
                      max={totalStates}
                      className={`tone-${STATE_TONE[row.state]}`}
                      target={pickTarget([boardFor(row.state)], allowed)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/**
 * Cuadro de una cola. Es un boton cuando hay a donde ir y un recuadro inerte
 * cuando no: nada peor que un cuadro que parece pulsable y no hace nada.
 */
function Tile({
  total,
  label,
  hint,
  tone,
  icon,
  flows,
  target,
  onNavigate,
}: {
  total: number;
  label: string;
  hint: string;
  tone: Tone;
  icon: ReactElement;
  /** Tipos de trámite que cuenta el cuadro; los tres juntos se rotulan "Todos". */
  flows: Flow[];
  target: Target | null;
  onNavigate: (resource: Resource, intent?: NavIntent) => void;
}) {
  const classes = `dash-tile tone-${tone}${total === 0 ? ' is-empty' : ''}`;
  const body = (
    <>
      <span className="dash-tile-top">
        <span className="dash-tile-ic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {icon}
          </svg>
        </span>
        <span className="dash-tile-n">{total}</span>
      </span>
      <span className="dash-tile-label">{label}</span>
      <span className="dash-tile-flows">
        {flows.length === ALL_FLOWS.length ? (
          <span className="dash-flow">Todos los tipos</span>
        ) : (
          flows.map((flow) => (
            <span key={flow} className={`dash-flow flow-${flow}`}>
              {FLOW_SHORT[flow]}
            </span>
          ))
        )}
      </span>
      <span className="dash-tile-hint">{hint}</span>
      {target && (
        <span className="dash-tile-go">
          {target.name}
          <Chevron />
        </span>
      )}
    </>
  );

  if (!target) return <div className={classes}>{body}</div>;
  return (
    <button type="button" className={classes} onClick={() => onNavigate(target.resource, target.intent)}>
      {body}
    </button>
  );
}

/**
 * Fila de un reparto. La proporcion se pinta como relleno de la fila entera y
 * no como una barra aparte: a este tamaño una barra de 40px no se compara con
 * nada, y el relleno deja el ancho completo para la etiqueta y la cifra.
 */
function DistRow({
  label,
  total,
  max,
  className,
  target,
  onNavigate,
}: {
  label: string;
  total: number;
  max: number;
  className: string;
  target: Target | null;
  onNavigate: (resource: Resource, intent?: NavIntent) => void;
}) {
  const classes = `dash-row ${className}`;
  // `--pct` es una custom property: React la pasa tal cual, TS no la conoce.
  const style = { '--pct': `${max > 0 ? Math.round((total / max) * 100) : 0}%` } as CSSProperties;
  const body = (
    <>
      <span className="dash-row-label" title={label}>{label}</span>
      <span className="dash-row-n mono">{total}</span>
    </>
  );

  if (!target) return <div className={classes} style={style}>{body}</div>;
  return (
    <button
      type="button"
      className={classes}
      style={style}
      title={`Abrir ${target.name}`}
      onClick={() => onNavigate(target.resource, target.intent)}
    >
      {body}
    </button>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
