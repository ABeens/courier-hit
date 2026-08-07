/**
 * Dashboards de tramites (docs/manuales/flujo.md L90-145).
 *
 * El manual pide tres tableros de staff con columnas distintas; se resuelven con
 * UNA pantalla y un `view`, porque comparten filtros, paginado y acciones:
 *   - 'paqueteria' -> Consecutivo, Cliente, Tracking, Tienda, Transportista, HAWB…
 *   - 'transporte' -> Consecutivo, Almacen, Cliente, Tracking, DUA…
 *   - 'todos'      -> solo las columnas comunes.
 * El cliente ve DOS variantes propias, sin filtro de cliente ni acciones de
 * staff (la API ya acota el listado a lo suyo); la vista las parte por flujo,
 * que es como el cliente las tiene en el menu:
 *   - 'propios'         -> "Mis paquetes": Paqueteria, y ahi se PREALERTA.
 *   - 'propios-tramites' -> "Otros tramites": aereo, maritimo y agenciamiento.
 * Antes solo existia la primera, asi que un tramite no-Paqueteria registrado por
 * el cliente no aparecia en ningun listado suyo.
 *
 * El "Monto de Factura" que pide el manual sale del modulo de costos y solo
 * existe una vez APROBADOS: hasta entonces la ficha no lo muestra, para no dar
 * por firme una cifra que todavia se esta armando.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Currency,
  Flow,
  MANUAL_SHIPMENT_TYPES,
  Permission,
  SHIPMENT_TYPE_LABELS,
  STATE_LABELS,
  ShipmentType,
  State,
  can,
  formatMoney,
  outstandingCrc,
  statesOf,
  usesPackageFields,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { FilterBar } from '../components/FilterBar';
import type { FilterChip } from '../components/FilterBar';
import { PayFlag, awaitingValidation } from '../components/PayFlag';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatDayInput, startOfLocalDayUtc, startOfNextLocalDayUtc } from '../lib/datetime';
import { STATE_TONE } from '../lib/tone';
import { ClientShipmentModal } from './ClientShipmentModal';
import { ShipmentFormModal, allowedTypesFor } from './ShipmentFormModal';
import { StateAdvanceModal, reachableStates } from './StateAdvanceModal';
import { StateCorrectModal } from './StateCorrectModal';
import { PaymentModal } from './PaymentModal';

/** Que tablero se esta mirando. */
export type ShipmentView = 'paqueteria' | 'transporte' | 'todos' | 'propios' | 'propios-tramites';

/**
 * Tipos de tramite que trae cada vista (vacio = todos). Los tableros de staff y
 * los del cliente se acotan igual: lo que cambia entre ellos es quien los mira,
 * no que tramites son.
 */
const TYPES_BY_VIEW: Record<ShipmentView, ShipmentType[]> = {
  paqueteria: [ShipmentType.Paqueteria],
  transporte: [...MANUAL_SHIPMENT_TYPES],
  todos: [],
  propios: [ShipmentType.Paqueteria],
  'propios-tramites': [...MANUAL_SHIPMENT_TYPES],
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
 * HAWB, el identificador que le pone la bodega de Miami al paquete. Va SIEMPRE
 * junto al tracking y nunca en su lugar: son dos numeros distintos que conviven
 * (el de la tienda y el del courier), y el cliente que llama preguntando por su
 * paquete necesita poder leer el que le pidan.
 *
 * Se muestra tambien vacio ("—") mientras el paquete no ha llegado a Miami: ahi
 * el hueco ES el dato, dice que todavia no hay HAWB asignado.
 *
 * "(LES)" es como lo nombra la operacion, y es el nombre por el que el cliente
 * lo va a oir; "HAWB" solo, sin esa pista, no lo reconoce nadie por telefono.
 */
function hawbField(row: ShipmentDto): CardField {
  return { label: 'HAWB (LES)', value: row.hawb, mono: true };
}

/**
 * Identificadores de la ficha. En Paqueteria son DOS y van juntos; en Transporte
 * y Agenciamiento el HAWB no existe como campo, asi que la seccion se queda con
 * su unica guia en vez de inventar una fila vacia que no aplica.
 */
function guideFields(row: ShipmentDto): CardField[] {
  return usesPackageFields(row.shipmentType)
    ? [trackingField(row), hawbField(row)]
    : [trackingField(row)];
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
      /**
       * El cobro va junto a la factura, no en un bloque aparte: quien mira este
       * bloque pregunta "cuánto es y ya lo pagó". La bandera de la cabecera da la
       * respuesta de un vistazo; estas dos líneas, la cifra exacta.
       */
      { label: 'Abonado', value: formatMoney(row.settledCrc, Currency.CRC) },
      {
        label: 'Saldo',
        value: formatMoney(outstandingCrc(row.settledCrc, row.invoiceTotalCrc), Currency.CRC),
      },
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
      { title: 'Guías', fields: guideFields(row) },
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
      { title: 'Guías', fields: guideFields(row) },
      { title: 'Aduana', fields: [{ label: 'DUA', value: row.dua, mono: true }, { label: 'Almacén', value: row.warehouse }] },
      { title: 'Entrega', fields: [entrega] },
      ...(money ? [money] : []),
    ];
  }

  // 'todos': conviven paquetes y trámites, así que solo lo común. Las dos vistas
  // del cliente usan el mismo juego: al titular no le toca la trastienda (tienda,
  // transportista, peso en Paquetería; DUA y almacén en los demás, que son
  // documentación que llevamos nosotros) sino sus guías, su ruta y su cobro.
  // Los identificadores SI son comunes: `guideFields` ya resuelve por fila cuál
  // lleva HAWB y cuál no, sin que el tablero tenga que elegir un juego único.
  return [
    { title: 'Guías', fields: guideFields(row) },
    { title: 'Entrega', fields: [entrega] },
    ...(money ? [money] : []),
  ];
}

interface Props {
  role: Role;
  /** Vista inicial; en el tablero de paquetes el usuario puede alternar a "Todos". */
  initialView: ShipmentView;
  /**
   * Filtros precargados cuando se llega desde otra pantalla (`NavIntent`): el
   * Resumen abre este tablero YA acotado a la cola o al trámite que se pulsó.
   * Solo son el punto de partida; el usuario los cambia como cualquier otro.
   */
  initialState?: State;
  initialQuery?: string;
}

export function ShipmentsScreen({ role, initialView, initialState, initialQuery }: Props) {
  const [view, setView] = useState<ShipmentView>(initialView);
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState(initialQuery ?? '');
  const [state, setState] = useState<string>(initialState ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; row: ShipmentDto } | null>(null);
  const [advancing, setAdvancing] = useState<ShipmentDto | null>(null);
  const [correcting, setCorrecting] = useState<ShipmentDto | null>(null);
  const [paying, setPaying] = useState<ShipmentDto | null>(null);
  /** Alta del cliente: vive aqui dentro, no en una pantalla aparte. */
  const [registering, setRegistering] = useState(false);

  /** Tablero del titular (cualquiera de los dos): sin acciones de staff. */
  const isOwn = view === 'propios' || view === 'propios-tramites';
  /** El de Paqueteria, el unico donde el alta se llama prealerta. */
  const isOwnPackages = view === 'propios';
  const canWrite = can(role, Permission.PackageWrite) || can(role, Permission.TramiteManage);
  const canPay = can(role, Permission.PackagePay);
  /**
   * Corregir aplica a los TRES flujos, no solo a los manuales: un paquete de
   * Paquetería mal avanzado por el robot o por la bodega tampoco tenía arreglo.
   */
  const canCorrect = can(role, Permission.ShipmentCorrect);

  /**
   * Tipos que se pueden dar de alta DESDE ESTE TABLERO: el alta hereda el filtro
   * de la vista, porque un trámite creado fuera de el desaparece del listado al
   * guardar. Si la interseccion con los permisos del rol queda vacia, no hay nada
   * que crear aqui y el boton no se ofrece.
   */
  const creatableTypes = useMemo(() => allowedTypesFor(role, TYPES_BY_VIEW[view]), [role, view]);

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
    /**
     * Las vistas del cliente ofrecen los estados de SU flujo. En las dos se cae
     * "En bodega - Pendiente pago", por lo mismo que no se pinta su píldora en la
     * ficha: ofrecerla en el filtro seria enseñarle por la puerta de atras la
     * etiqueta que se le oculta.
     */
    if (view === 'propios') {
      return statesOf(Flow.Paqueteria).filter((s) => s !== State.EnBodegaPendientePago);
    }
    if (view === 'propios-tramites') {
      return [...new Set([...statesOf(Flow.Transporte), ...statesOf(Flow.Agenciamiento)])].filter(
        (s) => s !== State.EnBodegaPendientePago,
      );
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

  /**
   * Lo que se está aplicando ademas del buscador, en el mismo orden en que sale
   * en el panel. Con el panel cerrado esto es lo UNICO que dice por que el
   * listado esta recortado, asi que cada ficha nombra su campo y su valor.
   */
  const chips: FilterChip[] = [
    ...(state ? [{ label: `Estado: ${STATE_LABELS[state as State]}`, onClear: () => setState('') }] : []),
    ...(from ? [{ label: `Desde: ${formatDayInput(from)}`, onClear: () => setFrom('') }] : []),
    ...(to ? [{ label: `Hasta: ${formatDayInput(to)}`, onClear: () => setTo('') }] : []),
  ];

  /** Deja el listado sin recortar. El buscador no entra: se ve y se limpia solo. */
  function clearFilters() {
    setState('');
    setFrom('');
    setTo('');
  }

  const title = isOwnPackages
    ? 'Mis paquetes'
    : view === 'propios-tramites'
      ? 'Otros trámites'
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
          {data && <div className="count">{data.items.length} {isOwnPackages ? 'paquetes' : 'trámites'}</div>}
        </div>
        {isOwn ? (
          /* El alta del titular: en Paqueteria es avisar de una compra que viene
             en camino (prealerta); en los demas flujos es registrar el tramite.
             Son la misma pantalla y el mismo modal, pero no la misma cosa. */
          <button className="btn btn-primary" onClick={() => setRegistering(true)}>
            {isOwnPackages ? '+ Prealertar' : '+ Nuevo trámite'}
          </button>
        ) : (
          canWrite && creatableTypes.length > 0 && (
            <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
              {view === 'paqueteria' ? '+ Nuevo paquete' : '+ Nuevo trámite'}
            </button>
          )
        )}
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <FilterBar
        search={{
          value: q,
          onChange: setQ,
          placeholder: isOwn
            ? 'Buscar por consecutivo, tracking o descripción…'
            : 'Buscar por consecutivo, tracking, descripción o cliente…',
        }}
        chips={chips}
        onClearAll={clearFilters}
      >
        <div>
          <label className="field-label" htmlFor="f-state">Estado</label>
          <select id="f-state" className="input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Todos los estados</option>
            {stateOptions.map((s) => (
              <option key={s} value={s}>{STATE_LABELS[s]}</option>
            ))}
          </select>
        </div>

        {/* El rango va en una fila: son los dos extremos de UN filtro, y
            separados en dos bloques sueltos se leen como dos fechas sin relación. */}
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="f-from">Desde</label>
            <input
              id="f-from" className="input" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="f-to">Hasta</label>
            <input
              id="f-to" className="input" type="date" value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>

        {/* Alternador del tablero de paquetes. Tambien cuando se llega con
            'todos' precargado desde el Resumen: es el mismo tablero abierto en
            su vista amplia, y sin el selector no habria forma de volver.
            No es un filtro que se "quite" (siempre tiene valor), asi que no
            pinta ficha: el titulo de la pantalla ya dice cual esta puesta. */}
        {(initialView === 'paqueteria' || initialView === 'todos') && (
          <div>
            <label className="field-label" htmlFor="f-view">Vista</label>
            <select
              id="f-view" className="input" value={view}
              onChange={(e) => setView(e.target.value as ShipmentView)}
            >
              <option value="paqueteria">Solo paquetería</option>
              <option value="todos">Todos los trámites</option>
            </select>
          </div>
        )}
      </FilterBar>

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
                  <span className="sub-type">{SHIPMENT_TYPE_LABELS[row.shipmentType]}</span>
                  {!isOwn && (
                    <span className="sub-client">
                      {row.client.code} — {row.client.name}
                    </span>
                  )}
                  <span className="sub-date">Ingresó {formatDate(row.createdAt)}</span>
                </div>
              </div>
              <div className="card-item-aside">
                {/* Antes de la píldora de estado: el operador que barre la lista
                    busca primero si el trámite se puede mover, y eso depende del
                    cobro. Sin factura aprobada no pinta nada. */}
                <PayFlag
                  invoiceTotalCrc={row.invoiceTotalCrc}
                  settledCrc={row.settledCrc}
                  settled={row.settled}
                  pendingCrc={row.pendingCrc}
                />
                {/*
                  Al cliente NO se le muestra "En bodega - Pendiente pago". Es la
                  etiqueta operativa de que la factura ya está aprobada y el
                  paquete espera en bodega; junto al botón "Pagar" le dice dos
                  veces lo mismo, y sigue diciéndolo después de pagar —el pago no
                  mueve el trámite—, que es justo cuando le hace dudar de si su
                  pago entró. Lo que le importa de ese momento ya se lo cuenta la
                  bandera de cobro: saldo, en validación o pagado.
                */}
                {!(isOwn && row.state === State.EnBodegaPendientePago) && (
                  <span className="spill"><span className="dot" />{STATE_LABELS[row.state]}</span>
                )}
                {/* Documento del trámite (la factura que adjuntó el cliente al
                    prealertar). Es un <a> y no un botón porque la descarga la
                    resuelve el navegador contra la API, que es quien comprueba
                    el permiso: la clave del almacén no viaja en la URL. */}
                {row.documentFileKey && (
                  <a
                    className="btn btn-ghost btn-sm"
                    href={`${API_BASE}/api/shipments/${row.id}/document`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Documento
                  </a>
                )}
                {canWrite && !isOwn && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ mode: 'edit', row })}>
                    Editar
                  </button>
                )}
                {/* Avance manual, en los TRES flujos. La frontera no es el tipo
                    de trámite sino quién reporta el hecho: `reachableStates` ya
                    descarta los estados que mueve el proveedor, así que en
                    Paquetería el botón aparece de facturación en adelante y calla
                    mientras el paquete está en manos de Helga. Antes se vetaba
                    Paquetería entera y esos estados solo se movían de rebote
                    desde recepción, costos o rutas: no había forma de avanzar
                    un paquete desde el tablero. */}
                {canWrite && !isOwn && reachableStates(row, role).length > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setAdvancing(row)}>
                    Avanzar
                  </button>
                )}
                {canCorrect && !isOwn && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setCorrecting(row)}>
                    Corregir
                  </button>
                )}
                {/*
                  El cobro solo tiene sentido con la factura ya aprobada, que es
                  justo lo que significa "En bodega - Pendiente pago".

                  Pero el estado NO alcanza como condición: el pago no mueve el
                  trámite, así que uno ya cobrado se queda en "Pendiente pago"
                  hasta que la operación lo despacha. Con solo el estado, el
                  cliente seguía viendo "Pagar" después de pagar.

                  Con el saldo cubierto no se ofrece nada; con el comprobante en
                  revisión se ofrece "Ver pago", que abre el mismo modal para
                  consultar sin empujar a pagar de nuevo.
                */}
                {canPay && row.state === State.EnBodegaPendientePago && !row.settled && (
                  awaitingValidation(row) ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setPaying(row)}>
                      Ver pago
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => setPaying(row)}>
                      Pagar
                    </button>
                  )
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

      {advancing && (
        <StateAdvanceModal
          row={advancing}
          role={role}
          onClose={() => setAdvancing(null)}
          onSaved={(message) => {
            setAdvancing(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      )}

      {correcting && (
        <StateCorrectModal
          row={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={(message) => {
            setCorrecting(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      )}

      {paying && (
        <PaymentModal
          shipment={paying}
          /*
            Recargar tambien al cerrar: dentro del modal se puede haber rechazado
            un cobro con tarjeta sin llegar a `onPaid`, y la ficha de atras
            quedaria mostrando un estado de pago viejo.
          */
          onClose={() => {
            setPaying(null);
            void load();
          }}
          /*
            El mensaje lo pone el modal, no esta pantalla: solo el modal sabe si
            fue un deposito (queda por validar) o una tarjeta aprobada (ya esta
            cobrado). Anunciar "pendiente de validación" para los dos casos era
            justo lo que hacia dudar al cliente de un pago que ya paso.
          */
          onPaid={(message) => {
            setPaying(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      )}

      {registering && (
        <ClientShipmentModal
          /* Cada tablero del cliente da de alta LO QUE LISTA: un tramite creado
             fuera de su filtro desapareceria al guardar, que es justo lo que
             pasaba cuando el selector ofrecia los cinco tipos desde "Mis
             paquetes". */
          types={TYPES_BY_VIEW[view]}
          /*
            Recargar tambien al cerrar: el modal se queda abierto tras registrar
            (permite encadenar varios y reintentar el documento), asi que el
            cierre puede llegar con tramites ya creados detras.
          */
          onClose={() => {
            setRegistering(false);
            void load();
          }}
          onCreated={() => {
            setError(null);
            void load();
          }}
        />
      )}

      {modal && (
        <ShipmentFormModal
          mode={modal.mode}
          role={role}
          boardTypes={TYPES_BY_VIEW[view]}
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
