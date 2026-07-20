/**
 * Dashboards de tramites (docs/manuales/flujo.md L90-145).
 *
 * El manual pide tres tableros de staff con columnas distintas; se resuelven con
 * UNA pantalla y un `view`, porque comparten filtros, paginado y acciones:
 *   - 'paqueteria' -> Consecutivo, Cliente, Tracking, Tienda, Transportista, HAWB…
 *   - 'transporte' -> Consecutivo, Almacen, Cliente, Tracking, DUA…
 *   - 'todos'      -> solo las columnas comunes.
 * El cliente ve una cuarta variante ('propios'): sus tramites, sin filtro de
 * cliente ni acciones de staff. La API ya acota el listado a lo suyo.
 *
 * El "Monto de Factura" que pide el manual sale del modulo de costos y solo
 * existe una vez APROBADOS: hasta entonces la ficha no lo muestra, para no dar
 * por firme una cifra que todavia se esta armando.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Currency,
  Flow,
  Permission,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  ShipmentType,
  State,
  can,
  formatMoney,
  statesOf,
  usesPackageFields,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate, startOfLocalDayUtc, startOfNextLocalDayUtc } from '../lib/datetime';
import { ShipmentFormModal } from './ShipmentFormModal';
import { PaymentModal } from './PaymentModal';

/** Que tablero se esta mirando. */
export type ShipmentView = 'paqueteria' | 'transporte' | 'todos' | 'propios';

/** Tipos de tramite que trae cada vista (vacio = todos). */
const TYPES_BY_VIEW: Record<ShipmentView, ShipmentType[]> = {
  paqueteria: [ShipmentType.Paqueteria],
  transporte: [
    ShipmentType.Aereo,
    ShipmentType.MaritimoFCL,
    ShipmentType.MaritimoLCL,
    ShipmentType.Agenciamiento,
  ],
  todos: [],
  propios: [],
};

interface ListResponse {
  items: ShipmentDto[];
}

/**
 * Par etiqueta/valor de una ficha. Centraliza el guion de "sin dato" para que
 * un campo vacio no se confunda con uno que no aplica a ese tipo de tramite.
 * `mono` es para identificadores (tracking, DUA, HAWB): en monoespaciada los
 * digitos alinean y es mas facil cotejarlos contra una guia impresa.
 */
function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const classes = [mono ? 'mono' : '', value ? '' : 'empty-val'].filter(Boolean).join(' ');
  return (
    <div className="card-item-field">
      <dt>{label}</dt>
      <dd className={classes || undefined}>{value ?? '—'}</dd>
    </div>
  );
}

/** Familias de color de la ficha, mapeadas a los tokens semanticos del tema. */
type Tone = 'neutral' | 'info' | 'warn' | 'ok' | 'danger';

/**
 * Tono de cada estado, para que al recorrer la lista se distinga de un vistazo
 * lo que avanza (info) de lo que espera una accion (warn) o ya cerro (ok).
 * El Record es exhaustivo a proposito: agregar un State obliga a decidir su tono.
 */
const STATE_TONE: Record<State, Tone> = {
  [State.Prealertado]: 'neutral',

  // En curso: el trámite se está moviendo, nadie tiene que hacer nada.
  [State.RecibidoBodegaMiami]: 'info',
  [State.PreparandoEnvio]: 'info',
  [State.EnTransitoCostaRica]: 'info',
  [State.RecoleccionEnProceso]: 'info',
  [State.ProcesoExportacion]: 'info',
  [State.EnTransitoDestino]: 'info',
  [State.ArriboDestino]: 'info',
  [State.RevisionDocumentos]: 'info',
  [State.ExamenPrevio]: 'info',
  [State.InspeccionDekra]: 'info',
  [State.PreparandoBorradorDua]: 'info',
  [State.EnRutaEntrega]: 'info',

  // Retenido o a la espera de alguien: aduana, facturación o pago del cliente.
  [State.EnAduanas]: 'warn',
  [State.ProcesoAduanas]: 'warn',
  [State.FacturacionEnProceso]: 'warn',
  [State.EnBodegaPendientePago]: 'warn',
  [State.PendienteAdelantoImpuestos]: 'warn',

  [State.Entregado]: 'ok',
  [State.DevueltoBodega]: 'danger',
};

interface CardField {
  label: string;
  value: string | null;
  mono?: boolean;
}

/** Bloque tematico dentro de una ficha. */
interface CardSection {
  title: string;
  fields: CardField[];
  /** Resalta el bloque como importe a cobrar. */
  money?: boolean;
}

/** Etiqueta de la guia segun el tipo: tracking en Paqueteria, AWB/BL en el resto. */
function trackingField(row: ShipmentDto): CardField {
  return {
    label: usesPackageFields(row.shipmentType) ? 'Tracking' : 'Tracking (AWB/BL)',
    value: row.tracking,
    mono: true,
  };
}

/**
 * Bloque de facturacion, o `null` si el tramite todavia no tiene costos
 * aprobados. El manual pide el monto "($ y ₡)": van como dos campos, no como
 * una cadena, para que cada moneda se lea sola.
 */
function moneySection(row: ShipmentDto): CardSection | null {
  if (row.invoiceTotalUsd == null || row.invoiceTotalCrc == null) return null;
  return {
    title: 'Facturación',
    money: true,
    fields: [
      { label: 'Dólares', value: formatMoney(row.invoiceTotalUsd, Currency.USD) },
      { label: 'Colones', value: formatMoney(row.invoiceTotalCrc, Currency.CRC) },
    ],
  };
}

/**
 * Secciones de una ficha, a la medida de lo que necesita cada tablero.
 *
 * No hay un juego unico de campos: Paqueteria se revisa por compra y guia
 * (¿de que tienda viene?, ¿que transportista lo trae?, ¿cuanto pesa?), mientras
 * que Transporte y Agenciamiento se revisan por documentacion aduanal (DUA,
 * almacen). Los tableros mixtos se quedan con lo comun para no inventar
 * columnas que la mitad de las filas no tiene.
 */
function sectionsFor(row: ShipmentDto, view: ShipmentView): CardSection[] {
  const money = moneySection(row);
  const entrega: CardField = {
    label: 'Ruta',
    value: row.routeNumber != null ? `Ruta ${row.routeNumber}` : null,
  };

  if (view === 'paqueteria') {
    return [
      { title: 'Guías', fields: [trackingField(row), { label: 'HAWB/HBL', value: row.hawb, mono: true }] },
      { title: 'Compra', fields: [{ label: 'Tienda', value: row.store }, { label: 'Transportista', value: row.carrier }] },
      {
        title: 'Logística',
        fields: [{ label: 'Peso', value: row.weightKg != null ? `${row.weightKg} kg` : null }, entrega],
      },
      ...(money ? [money] : []),
    ];
  }

  if (view === 'transporte') {
    return [
      { title: 'Guías', fields: [trackingField(row)] },
      { title: 'Aduana', fields: [{ label: 'DUA', value: row.dua, mono: true }, { label: 'Almacén', value: row.warehouse }] },
      { title: 'Entrega', fields: [entrega] },
      ...(money ? [money] : []),
    ];
  }

  // 'todos' y 'propios': conviven paquetes y trámites, así que solo lo común.
  return [
    { title: 'Guías', fields: [trackingField(row)] },
    { title: 'Entrega', fields: [entrega] },
    ...(money ? [money] : []),
  ];
}

interface Props {
  role: Role;
  /** Vista inicial; en el tablero de paquetes el usuario puede alternar a "Todos". */
  initialView: ShipmentView;
}

export function ShipmentsScreen({ role, initialView }: Props) {
  const [view, setView] = useState<ShipmentView>(initialView);
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; row: ShipmentDto } | null>(null);
  const [paying, setPaying] = useState<ShipmentDto | null>(null);

  const isOwn = view === 'propios';
  const canWrite = can(role, Permission.PackageWrite) || can(role, Permission.TramiteManage);
  const canPay = can(role, Permission.PackagePay);

  useEffect(() => setView(initialView), [initialView]);

  /**
   * Estados ofrecidos en el filtro. Cuando la vista se limita a un unico flow,
   * solo tienen sentido los estados de esa maquina; si no, se ofrecen todos.
   */
  const stateOptions = useMemo(() => {
    if (view === 'paqueteria') return statesOf(Flow.Paqueteria);
    if (view === 'transporte') {
      return [...new Set([...statesOf(Flow.Transporte), ...statesOf(Flow.Agenciamiento)])];
    }
    return Object.values(State);
  }, [view]);

  // Si al cambiar de vista el estado filtrado ya no aplica, se limpia.
  useEffect(() => {
    if (state && !stateOptions.includes(state as State)) setState('');
  }, [state, stateOptions]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (state) params.set('state', state);
    const types = TYPES_BY_VIEW[view];
    if (types.length > 0) params.set('shipmentType', types.join(','));
    // El usuario elige dias en su hora local; el rango viaja como instantes UTC.
    if (from) params.set('from', startOfLocalDayUtc(from));
    if (to) params.set('to', startOfNextLocalDayUtc(to));
    const qs = params.toString();
    try {
      setData(await api.get<ListResponse>(`/shipments${qs ? `?${qs}` : ''}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, [q, state, view, from, to]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [load]);

  const title = isOwn
    ? 'Mis trámites'
    : view === 'paqueteria'
      ? 'Paquetería'
      : view === 'transporte'
        ? 'Transporte y agenciamiento'
        : 'Todos los trámites';

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">{title}</div>
          {data && <div className="count">{data.items.length} trámites</div>}
        </div>
        {canWrite && !isOwn && (
          <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
            + Nuevo trámite
          </button>
        )}
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="filters">
        <input
          className="input search" placeholder="Buscar por consecutivo, tracking, descripción o cliente…"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Todos los estados</option>
          {stateOptions.map((s) => (
            <option key={s} value={s}>{STATE_LABELS[s]}</option>
          ))}
        </select>
        <input
          className="input" type="date" value={from} aria-label="Desde"
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          className="input" type="date" value={to} aria-label="Hasta"
          onChange={(e) => setTo(e.target.value)}
        />
        {initialView === 'paqueteria' && (
          <select className="input" value={view} onChange={(e) => setView(e.target.value as ShipmentView)}>
            <option value="paqueteria">Solo paquetería</option>
            <option value="todos">Todos los trámites</option>
          </select>
        )}
      </div>

      <div className="cards">
        {data?.items.map((row) => (
          <article className={`card-item tone-${STATE_TONE[row.state]}`} key={row.id}>
            <div className="card-item-head">
              <div className="card-item-ident">
                <span className="card-item-code">{row.code}</span>
                <div className="card-item-title">{row.description}</div>
                {/* La fecha de ingreso vive aquí, con la identidad: es cuándo
                    entró el trámite, no un dato operativo de ningún bloque. */}
                <div className="card-item-sub">
                  {SHIPMENT_TYPE_LABELS[row.shipmentType]}
                  {!isOwn && ` · ${row.client.code} — ${row.client.name}`}
                  {` · Ingresó ${formatDate(row.createdAt)}`}
                </div>
              </div>
              <div className="card-item-aside">
                <span className="spill"><span className="dot" />{STATE_LABELS[row.state]}</span>
                {canWrite && !isOwn && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                    Editar
                  </button>
                )}
                {/* El cobro solo tiene sentido con la factura ya aprobada, que es
                    justo lo que significa "En bodega - Pendiente pago". */}
                {canPay && row.state === State.EnBodegaPendientePago && (
                  <button className="btn btn-primary btn-sm" onClick={() => setPaying(row)}>
                    Pagar
                  </button>
                )}
              </div>
            </div>

            <div className="card-item-body">
              {sectionsFor(row, view).map((section) => (
                <section className={`card-sec${section.money ? ' is-money' : ''}`} key={section.title}>
                  <div className="card-sec-title">{section.title}</div>
                  <dl className="card-sec-fields">
                    {section.fields.map((f) => (
                      <Field key={f.label} label={f.label} value={f.value} mono={f.mono} />
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </article>
        ))}
      </div>

      {data && data.items.length === 0 && <div className="empty">No hay trámites que coincidan.</div>}

      {paying && (
        <PaymentModal
          shipment={paying}
          onClose={() => setPaying(null)}
          onPaid={() => {
            setPaying(null);
            setNotice('Registramos tu pago. Queda pendiente de validación.');
            void load();
          }}
        />
      )}

      {modal && (
        <ShipmentFormModal
          mode={modal.mode}
          role={role}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message ?? null);
            setError(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
