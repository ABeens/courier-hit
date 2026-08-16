/**
 * Pantalla «Sala de control» (permiso control_room.manage, solo Admin).
 *
 * Es la UNICA puerta de los cambios contra flujo: corregir un estado hacia atras
 * o hacia adelante, cambiarle el dueño a un tramite, descartar y restaurar. El
 * tablero de Paqueteria no ofrece ninguna de esas acciones; ahi solo se avanza
 * por la maquina.
 *
 * Es el cuarto de atrás de la operación: el sitio donde se ENMIENDA lo que entró
 * mal, a diferencia del tablero de Paquetería, que sirve para OPERAR lo que va
 * bien. Cubre dos poblaciones que en el fondo son el mismo problema («esta caja
 * no está donde debería, o no es de quien dice»):
 *
 *   - PAQUETES SIN DUEÑO: llegaron a la bodega de HS Global sin que nadie los
 *     anunciara (ni el cliente los prealertó, ni el operador de Miami los
 *     reportó). Mientras no tengan dueño no avanzan, no se cotizan y no se
 *     cobran: son cajas esperando a que alguien las reclame.
 *   - CUALQUIER TRÁMITE del sistema, para cambiarle el dueño (homónimos, dos
 *     cuentas de la misma familia, un dedazo en el alta) o corregirle el estado.
 *
 * Las acciones que ofrece cada ficha dependen de en cuál de las dos está, y no
 * por estética: un paquete sin dueño no puede moverse de estado (todo lo que
 * viene después pregunta por el casillero), y uno que ya lo tiene no se puede
 * descartar (eso se enmienda por el flujo, no archivándolo por la puerta de
 * atrás). La API aplica las dos reglas; aquí solo se dejan de ofrecer los botones
 * que iba a rechazar.
 */
import { useState } from 'react';
import {
  Currency,
  Permission,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  State,
  can,
  clientFullLabel,
  formatMoney,
  knownTracking,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { IconButton } from '../components/IconButton';
import { CardsSkeleton, EmptyList, ListBody } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { ApiError, api } from '../lib/api';
import { usePagedList } from '../lib/usePagedList';
import { formatDate, formatDateTime } from '../lib/datetime';
import { STATE_TONE } from '../lib/tone';
import { AssignOwnerModal } from './AssignOwnerModal';
import { DiscardPackageModal } from './DiscardPackageModal';
import { ShipmentHistoryModal } from './ShipmentHistoryModal';
import { StateCorrectModal } from './StateCorrectModal';
import { UnassignedFormModal } from './UnassignedFormModal';

/** Qué pila se está mirando. */
type ControlRoomView = 'sin-dueno' | 'todos' | 'descartados';

/**
 * Pila con la que abre la pantalla. Es «todos» y no la cola de sin dueño porque
 * quien entra aquí casi siempre viene de una llamada concreta («mi paquete no
 * aparece», «me cargaron el de otro»): lo primero que necesita es BUSCAR entre
 * todos los trámites, no revisar el montón de cajas anónimas. La cola sigue a un
 * clic, en el panel de filtros.
 */
const DEFAULT_VIEW: ControlRoomView = 'todos';

/**
 * Filtros de la API por vista. El eje «dueño» y el eje «archivado» son
 * independientes en el servidor (`owner` y `discarded`); aquí se combinan en un
 * único selector porque para quien mira son tres pilas, no dos ejes.
 */
const VIEW_PARAMS: Record<ControlRoomView, Record<string, string>> = {
  'sin-dueno': { owner: 'unassigned' },
  todos: { owner: 'all' },
  // Solo se descartan paquetes sin dueño, así que `owner=all` no ensancha nada
  // hoy; se deja explícito para que la pila siga completa si eso cambiara.
  descartados: { owner: 'all', discarded: 'true' },
};

const VIEW_COUNT_LABEL: Record<ControlRoomView, string> = {
  'sin-dueno': 'paquetes sin dueño',
  todos: 'trámites',
  descartados: 'paquetes descartados',
};

/** Par etiqueta/valor de una ficha; el guion marca el dato que falta. */
function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const classes = [mono ? 'mono' : '', value ? '' : 'empty-val'].filter(Boolean).join(' ');
  return (
    <div className="card-item-field">
      <dt>{label}</dt>
      <dd className={classes || undefined}>{value ?? '—'}</dd>
    </div>
  );
}

export function ControlRoomScreen({ role }: { role: Role }) {
  const [view, setView] = useState<ControlRoomView>(DEFAULT_VIEW);
  const [q, setQ] = useState('');
  const [state, setState] = useState<string>('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<ShipmentDto | null>(null);
  const [assigning, setAssigning] = useState<ShipmentDto | null>(null);
  const [correcting, setCorrecting] = useState<ShipmentDto | null>(null);
  const [discarding, setDiscarding] = useState<ShipmentDto | null>(null);
  const [tracing, setTracing] = useState<ShipmentDto | null>(null);

  /**
   * Corregir el estado es un permiso propio (`shipment.correct`) y no viene con
   * la sala de control: hoy los dos son de Admin, pero se pregunta por separado
   * para que abrirle la sala a Operativo o a Servicio al Cliente no le regale de
   * paso la puerta de saltar la máquina de estados.
   */
  const canCorrectState = can(role, Permission.ShipmentCorrect);

  /**
   * La pila que se está mirando, paginada. TODOS los filtros viajan a la API
   * (los dos ejes de la pila, el buscador y el estado): con el listado paginado,
   * recortar en el navegador solo afectaría a la página visible y el contador de
   * la cabecera diría una cifra que no es.
   */
  const list = usePagedList<ShipmentDto>(
    '/shipments',
    { ...VIEW_PARAMS[view], q: q.trim() || undefined, state: state || undefined },
    { errorMessage: 'No se pudo cargar la sala de control.' },
  );
  const { error, setError, reload: load } = list;

  /**
   * Lo aplicado además del buscador. La PILA no pinta ficha: no es un filtro que
   * se quite (siempre tiene valor) y el contador de la cabecera ya dice cuál está
   * puesta. El estado sí, que es el que puede dejar el listado corto sin que se
   * vea por qué.
   */
  const chips: FilterChip[] = state
    ? [{ label: `Estado: ${STATE_LABELS[state as State]}`, onClear: () => setState('') }]
    : [];

  /** Cierra el modal que estuviera abierto, avisa y recarga. */
  function afterChange(message: string) {
    setRegistering(false);
    setEditing(null);
    setAssigning(null);
    setCorrecting(null);
    setDiscarding(null);
    setNotice(message);
    setError(null);
    void load();
  }

  /**
   * Deshacer un descarte no abre modal: no hay nada que preguntar. El motivo por
   * el que se descartó ya está escrito, y pedir otro para revertirlo solo añade
   * fricción a la corrección de un clic equivocado.
   */
  async function restore(row: ShipmentDto) {
    setBusyId(row.id);
    try {
      await api.post(`/shipments/${row.id}/restore`);
      afterChange(`${row.code} vuelve a la cola de la sala de control.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo restaurar el paquete.');
    } finally {
      setBusyId(null);
    }
  }

  const items = list.items;
  /** Hay algo puesto además de la pila: cambia el "no hay nada" por "no coincide". */
  const filtered = q.trim() !== '' || state !== '';

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Sala de control</div>
          {/* El total de la pila, no las filas de la pagina. */}
          {list.data && (
            <div className="count">
              {list.total.toLocaleString('es-CR')} {VIEW_COUNT_LABEL[view]}
            </div>
          )}
        </div>
        {view !== 'descartados' && (
          <button className="btn btn-primary" onClick={() => setRegistering(true)}>
            + Registrar paquete
          </button>
        )}
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      {/* Mismo patrón de filtros que el resto del portal: a la vista solo el
          buscador, que es lo que se usa en cada visita, y el resto colgado del
          botón. Aquí la pila entra al panel en vez de ocupar media fila fija:
          la pantalla abre sobre TODOS los trámites, así que acotarla es la
          excepción, no el paso previo obligatorio. */}
      <FilterBar
        search={{
          value: q,
          onChange: setQ,
          placeholder: 'Buscar por consecutivo, guía, descripción, casillero o cliente…',
        }}
        chips={chips}
        onClearAll={() => setState('')}
      >
        <div>
          <label className="field-label" htmlFor="cr-pile">Pila</label>
          <select
            id="cr-pile"
            className="input"
            value={view}
            onChange={(e) => setView(e.target.value as ControlRoomView)}
          >
            <option value="todos">Todos los trámites</option>
            <option value="sin-dueno">Sin dueño</option>
            <option value="descartados">Descartados</option>
          </select>
        </div>

        {/* Todos los estados de las tres máquinas: la pila «Todos» mezcla los tres
            flujos, así que acotar el selector a uno escondería trámites. */}
        <div>
          <label className="field-label" htmlFor="cr-state">Estado</label>
          <select
            id="cr-state"
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="">Todos los estados</option>
            {Object.values(State).map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </FilterBar>

      {list.loading && <CardsSkeleton />}

      <ListBody refreshing={list.refreshing}>
        <div className="cards">
        {items.map((row) => {
          const unassigned = row.client === null;
          // Se guarda el instante, no un booleano: así el aviso del descarte lo
          // usa sin volver a comprobar el nulo.
          const discardedAt = row.discardedAt;
          const discarded = discardedAt !== null;
          /**
           * Ámbar para lo que pide acción (una caja sin dueño es trabajo
           * pendiente), neutro para lo archivado, que ya no la pide, y el tono
           * del estado para el resto: en la vista general la ficha se lee igual
           * que en el tablero de Paquetería.
           */
          const tone = discarded ? 'neutral' : unassigned ? 'warn' : STATE_TONE[row.state];

          return (
            <article className={`card-item tone-${tone}`} key={row.id}>
              <div className="card-item-head">
                <div className="card-item-ident">
                  <span className="card-item-code">{row.code}</span>
                  <div className="card-item-title">{row.description}</div>
                  <div className="card-item-sub">
                    <span className="sub-type">{SHIPMENT_TYPE_LABELS[row.shipmentType]}</span>
                    <span className="sub-client">{clientFullLabel(row.client)}</span>
                    <span className="sub-date">Ingresó {formatDate(row.createdAt)}</span>
                  </div>
                </div>
                <div className="card-item-aside">
                  <span className="spill">
                    <span className="dot" />
                    {discarded ? 'Descartado' : unassigned ? 'Sin dueño' : STATE_LABELS[row.state]}
                  </span>
                  <IconButton label="Ver historial" icon="clock" onClick={() => setTracing(row)} />

                  {discarded ? (
                    /* Sin texto no hay donde poner "Restaurando…", asi que el
                       trabajo en curso lo dice el propio globo y el boton se
                       apaga mientras tanto. */
                    <IconButton
                      label={busyId === row.id ? 'Restaurando…' : 'Restaurar paquete'}
                      icon="undo"
                      tone="primary"
                      disabled={busyId === row.id}
                      onClick={() => void restore(row)}
                    />
                  ) : (
                    <>
                      {/* Corregir los DATOS del bulto solo mientras no tenga
                          dueño: ahí la ventana de edición por estado está
                          abierta de par en par. En cuanto lo tiene, sus datos se
                          editan desde Paquetería con las reglas de siempre. */}
                      {unassigned && (
                        <IconButton label="Corregir datos" icon="edit" onClick={() => setEditing(row)} />
                      )}
                      {/* Mover de estado NO se ofrece sin dueño: el paquete no
                          puede avanzar hasta que se sepa a quién cotizarle,
                          cobrarle y entregarle, y la API lo rechazaría. */}
                      {!unassigned && canCorrectState && (
                        <IconButton label="Corregir estado" icon="undo" onClick={() => setCorrecting(row)} />
                      )}
                      {/* Descartar es la salida del que nunca tuvo dueño. Uno que
                          ya lo tiene es un trámite normal y se enmienda por el
                          flujo, no archivándolo. */}
                      {unassigned && (
                        <IconButton
                          label="Descartar paquete"
                          icon="trash"
                          tone="danger"
                          onClick={() => setDiscarding(row)}
                        />
                      )}
                      <IconButton
                        label={unassigned ? 'Asignar dueño' : 'Cambiar dueño'}
                        icon="userSwap"
                        tone="primary"
                        onClick={() => setAssigning(row)}
                      />
                    </>
                  )}
                </div>
              </div>

              {discardedAt !== null && (
                <div
                  className="banner"
                  style={{ margin: '0 0 10px', background: 'var(--paper-2)', color: 'var(--muted)' }}
                >
                  Descartado el {formatDateTime(discardedAt)}: {row.discardReason}
                </div>
              )}

              {unassigned && !discarded && (
                <div
                  className="banner"
                  style={{ margin: '0 0 10px', background: 'var(--paper-2)', color: 'var(--muted)' }}
                >
                  Sin dueño no avanza de estado, no se cotiza y no se cobra. Asígnale un casillero
                  para que siga el flujo normal.
                </div>
              )}

              <div className="card-item-body">
                <section className="card-sec">
                  <div className="card-sec-title">Identificadores</div>
                  <dl className="card-sec-fields">
                    <Field label="HAWB (LES)" value={row.hawb} mono />
                    {/* `knownTracking` deshace la siembra del consecutivo: un
                        paquete sin guía legible debe mostrar el hueco, no un
                        número que nadie puede rastrear. */}
                    <Field label="Tracking" value={knownTracking(row)} mono />
                    <Field label="Tienda" value={row.store} />
                    <Field label="Transportista" value={row.carrier} />
                  </dl>
                </section>
                <section className="card-sec">
                  <div className="card-sec-title">Bulto</div>
                  <dl className="card-sec-fields">
                    <Field label="Peso" value={row.weightKg != null ? `${row.weightKg} kg` : null} />
                    <Field
                      label="Valor declarado"
                      value={
                        row.declaredValueUsd != null
                          ? formatMoney(row.declaredValueUsd, Currency.USD)
                          : null
                      }
                    />
                    <Field
                      label="Monto de factura"
                      value={
                        row.invoiceTotalUsd != null
                          ? formatMoney(row.invoiceTotalUsd, Currency.USD)
                          : null
                      }
                    />
                    <Field label="Notas de bodega" value={row.billingNotes} />
                  </dl>
                </section>
              </div>
            </article>
          );
        })}
        </div>

        <Pagination
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          totalPages={list.totalPages}
          onPage={list.goToPage}
          busy={list.refreshing}
          noun={VIEW_COUNT_LABEL[view]}
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={items.length === 0}>
        {view === 'sin-dueno'
          ? filtered
            ? 'Ningún paquete sin dueño coincide con los filtros.'
            : 'No hay paquetes sin dueño. Cuando aparezca uno en bodega que el sistema no reconozca, regístralo aquí.'
          : view === 'todos'
            ? filtered
              ? 'Ningún trámite coincide con los filtros.'
              : 'Todavía no hay trámites registrados.'
            : filtered
              ? 'Ningún paquete descartado coincide con los filtros.'
              : 'No hay paquetes descartados.'}
      </EmptyList>

      {registering && (
        <UnassignedFormModal
          mode="create"
          onClose={() => setRegistering(false)}
          onSaved={afterChange}
        />
      )}

      {editing && (
        <UnassignedFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={afterChange}
        />
      )}

      {assigning && (
        <AssignOwnerModal
          row={assigning}
          onClose={() => setAssigning(null)}
          onSaved={afterChange}
        />
      )}

      {correcting && (
        <StateCorrectModal
          row={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={afterChange}
        />
      )}

      {discarding && (
        <DiscardPackageModal
          row={discarding}
          onClose={() => setDiscarding(null)}
          onSaved={afterChange}
        />
      )}

      {tracing && <ShipmentHistoryModal row={tracing} onClose={() => setTracing(null)} />}
    </div>
  );
}
