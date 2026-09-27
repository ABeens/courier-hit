/**
 * Pantalla "Entregas" (permiso delivery.manage) — Requerimientos Parte 5.
 *
 * Es la pantalla del mensajero y se diseña para eso: se usa de pie, con una mano
 * y en la calle. Por eso lista TARJETAS y no una tabla (una tabla de 10 columnas
 * es inservible en un telefono) y muestra la direccion y el telefono del cliente
 * completos.
 *
 * La cola va POR PROFORMA: una tarjeta por proforma con sus paquetes en ruta y
 * un solo boton, "Entregar", que abre la entrega de la proforma. Ahi se elige
 * paquete por paquete: entregado, devuelto a bodega (con motivo) o sigue en
 * ruta. Si parte de la proforma sigue en bodega, la tarjeta lo avisa: el
 * mensajero no puede salir creyendo que lleva todo.
 *
 * Los botones por paquete (confirmar o devolver) solo quedan para un paquete en
 * ruta SIN proforma, anterior al modulo.
 *
 * La foto se toma con la camara del propio telefono: `capture="environment"`
 * abre la camara trasera directamente en vez del explorador de archivos.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  DELIVERY_OUTCOME_LABELS,
  DeliveryOutcome,
  SHIPMENT_TYPE_LABELS,
  findCanton,
  findDistrict,
  findProvince,
  usesPackageFields,
} from '@courier/shared';
import type { ShipmentType } from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { FilterBar } from '../components/FilterBar';
import { CardsSkeleton, EmptyList, ListBody } from '../components/ListLoading';
import { Pagination } from '../components/Pagination';
import { PayFlag } from '../components/PayFlag';
import { API_BASE } from '../lib/api';
import { usePagedList } from '../lib/usePagedList';
import { DeliveryConfirmModal } from './DeliveryConfirmModal';
import { ProformaDeliveryModal } from './ProformaDeliveryModal';

export interface DeliveryQueueRow {
  id: string;
  code: string;
  tracking: string;
  /**
   * HAWB (LES): el identificador que la bodega de Miami imprime en la etiqueta de
   * la caja. Aqui no es un dato de oficina: es el numero que el mensajero lee en
   * el paquete que tiene en la mano, y con el que casa la tarjeta con el bulto.
   * Null mientras el paquete no ha pasado por Miami.
   */
  hawb: string | null;
  description: string;
  shipmentType: ShipmentType;
  clientName: string;
  clientPhone: string | null;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  routeNumber: number | null;
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  /**
   * Estado del cobro, derivado por la API de los pagos confirmados. En esta
   * pantalla no es un dato mas: la guarda de la maquina de estados exige el pago
   * antes de sacar el paquete a ruta, asi que un saldo aqui significa que alguien
   * adelanto el trámite a mano y el mensajero va a llegar a cobrar.
   *
   * Las dos monedas, porque la bandera decide en la que se cobra el trámite
   * (`chargeBasisFor`) y en Paquetería son dólares.
   */
  settledUsd: number;
  settledCrc: number;
  settled: boolean;
  pendingUsd: number;
  pendingCrc: number;
  /** Proforma del paquete: el mensajero entrega proformas, no paquetes sueltos. */
  proformaId: string | null;
  proformaNumber: number | null;
  updatedAt: string;
}

type ModalState = { row: DeliveryQueueRow; outcome: DeliveryOutcome } | null;

/** Paquetes de la proforma por estado (lo que la tarjeta cuenta ademas de lo que va en ruta). */
interface StopCounts {
  total: number;
  inRoute: number;
  inWarehouse: number;
  delivered: number;
  returned: number;
}

/** Una parada: una proforma con sus paquetes en ruta, o un paquete suelto sin proforma. */
interface DeliveryStop {
  proformaId: string | null;
  proformaNumber: number | null;
  shipments: DeliveryQueueRow[];
  /** Null en un paquete sin proforma. */
  counts: StopCounts | null;
}

/** La bandera de cobro de la parada: la del primer paquete con saldo, o la del primero si todo esta pagado. */
function payRow(stop: DeliveryStop): DeliveryQueueRow {
  return stop.shipments.find((s) => !s.settled) ?? stop.shipments[0]!;
}

/** "2 siguen en bodega, 1 ya entregado": lo que NO va en ruta de la proforma. */
function outsideRoute(counts: StopCounts): string | null {
  const parts = [
    counts.inWarehouse > 0 && `${counts.inWarehouse} ${counts.inWarehouse === 1 ? 'sigue' : 'siguen'} en bodega`,
    counts.delivered > 0 && `${counts.delivered} ya ${counts.delivered === 1 ? 'entregado' : 'entregados'}`,
    counts.returned > 0 && `${counts.returned} ${counts.returned === 1 ? 'devuelto' : 'devueltos'} a bodega`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Par etiqueta/valor de la ficha, el mismo de Paqueteria y Clientes. Antes esta
 * pantalla usaba `.field-label` con un `<span>` suelto: eso es el atomo de un
 * formulario, no de una ficha, y traia consigo el cuerpo grande de un campo de
 * captura. En `dt`/`dd` hereda la densidad del listado y ademas queda como lo
 * que es, una lista de definiciones.
 */
function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const isEmpty = value == null || value === '';
  const classes = [mono && !isEmpty ? 'mono' : '', isEmpty ? 'empty-val' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="card-item-field">
      <dt>{label}</dt>
      <dd className={classes || undefined}>{isEmpty ? '—' : value}</dd>
    </div>
  );
}

export function DeliveriesScreen() {
  const [q, setQ] = useState('');
  const [route, setRoute] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  /** Proforma cuya entrega se esta registrando (visita completa o parcial). */
  const [delivering, setDelivering] = useState<string | null>(null);

  /**
   * La cola del dia, paginada. Los dos filtros del manual (nombre/tracking y
   * ruta) se aplican en SQL: el mensajero que filtra por su ruta tiene que ver
   * SU recorrido entero, no la parte de el que cabia en la primera pagina.
   */
  const list = usePagedList<DeliveryStop, { packagesInRoute: number }>(
    '/deliveries/stops',
    { q: q.trim() || undefined, routeNumber: route.trim() || undefined },
    { errorMessage: 'No se pudo cargar la ruta.' },
  );
  const { error, setError, reload: load } = list;

  /**
   * La hoja de ruta imprimible, con el MISMO filtro que se esta viendo: si hay
   * una ruta puesta sale la de esa ruta, y si no, la del dia entero. Se abre en
   * otra pestaña y no con `fetch`: es un documento HTML para imprimir o guardar
   * como PDF, y la cookie de sesion viaja igual por ser el mismo origen (mismo
   * criterio que las proformas y la descarga del CSV).
   */
  function openReport() {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (route.trim()) params.set('routeNumber', route.trim());
    window.open(`${API_BASE}/api/deliveries/queue/report?${params.toString()}`, '_blank');
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Entregas</div>
          {list.data && (
            <div className="count">
              {list.total.toLocaleString('es-CR')} {list.total === 1 ? 'entrega' : 'entregas'} ·{' '}
              {list.data.packagesInRoute.toLocaleString('es-CR')} paquetes en ruta
            </div>
          )}
        </div>
        <div className="actions">
          {/* Deshabilitado mientras no haya nada que imprimir: una hoja de ruta
              en blanco se confunde con "no hay entregas hoy". */}
          <button
            className="btn btn-ghost"
            onClick={openReport}
            disabled={list.loading || list.total === 0}
            title={
              route
                ? `Hoja de ruta de la ruta ${route}, para imprimir o guardar como PDF`
                : 'Hoja de ruta de todas las rutas, para imprimir o guardar como PDF'
            }
          >
            Descargar reporte
          </button>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <FilterBar
        search={{ value: q, onChange: setQ, placeholder: 'Buscar por nombre o tracking…' }}
        chips={route ? [{ label: `Ruta: ${route}`, onClear: () => setRoute('') }] : []}
        onClearAll={() => setRoute('')}
      >
        <div>
          <label className="field-label" htmlFor="f-route">Ruta</label>
          <input
            id="f-route"
            className="input"
            type="number"
            min={1}
            placeholder="Todas las rutas"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
          />
        </div>
      </FilterBar>

      {list.loading && <CardsSkeleton rows={3} />}

      <ListBody refreshing={list.refreshing}>
        <div className="cards">
        {list.items.map((stop) => {
          const first = stop.shipments[0]!;
          const pay = payRow(stop);
          const outside = stop.counts ? outsideRoute(stop.counts) : null;
          return (
            <article className="card-item tone-info" key={stop.proformaId ?? first.id}>
              <div className="card-item-head">
                <div className="card-item-ident">
                  <div className="card-item-code">
                    {stop.proformaNumber != null ? `Proforma ${stop.proformaNumber}` : first.code}
                  </div>
                  <div className="card-item-title">{first.clientName}</div>
                  <div className="card-item-sub">
                    {stop.counts
                      ? `${stop.counts.inRoute} de ${stop.counts.total} ${stop.counts.total === 1 ? 'paquete' : 'paquetes'} en ruta`
                      : `${SHIPMENT_TYPE_LABELS[first.shipmentType]} · ${first.tracking}`}
                  </div>
                </div>
                <div className="card-item-aside">
                  {/* El mensajero tiene que saber ANTES de tocar el timbre si lleva
                      algo con saldo: es lo unico de la tarjeta que cambia lo que
                      hace al llegar. */}
                  <PayFlag
                    shipmentType={pay.shipmentType}
                    invoiceTotalUsd={pay.invoiceTotalUsd}
                    invoiceTotalCrc={pay.invoiceTotalCrc}
                    settledUsd={pay.settledUsd}
                    settledCrc={pay.settledCrc}
                    settled={pay.settled}
                    pendingUsd={pay.pendingUsd}
                    pendingCrc={pay.pendingCrc}
                  />
                  <span className="spill">
                    <span className="dot" />
                    {first.routeNumber != null ? `Ruta ${first.routeNumber}` : 'Sin ruta'}
                  </span>
                </div>
              </div>

              {/* Lo que falta de la proforma, a la vista: si algo sigue en bodega,
                  esta visita va a quedar como entrega parcial. */}
              {outside && (
                <div className={stop.counts!.inWarehouse > 0 ? 'banner warn' : 'banner info'}>
                  No van en ruta: {outside}.
                </div>
              )}

              <div className="card-item-body">
                <section className="card-sec">
                  <dl className="card-sec-fields">
                    <Field
                      label="Dirección"
                      value={`${findProvince(first.provinceCode)?.name}, ${findCanton(first.cantonCode)?.name}, ${findDistrict(first.districtCode)?.name}`}
                    />
                    <Field label="Otras señas" value={first.addressLine} />
                    {/* Enlace `tel:` a proposito: el mensajero llama desde la propia tarjeta. */}
                    <Field
                      label="Teléfono"
                      value={first.clientPhone ? <a href={`tel:${first.clientPhone}`}>{first.clientPhone}</a> : null}
                      mono
                    />
                  </dl>
                </section>
                {/* Los paquetes que lleva: codigo, HAWB (el numero impreso en la
                    etiqueta de la caja, con el que casa la tarjeta con el bulto) y
                    descripcion. */}
                <section className="card-sec">
                  <div className="card-sec-title">
                    {stop.shipments.length === 1 ? 'Paquete en ruta' : `Paquetes en ruta (${stop.shipments.length})`}
                  </div>
                  <dl className="card-sec-fields">
                    {stop.shipments.map((row) => (
                      <Field
                        key={row.id}
                        label={row.code}
                        value={
                          <>
                            {usesPackageFields(row.shipmentType) && <span className="mono">{row.hawb ?? '—'}</span>}
                            {usesPackageFields(row.shipmentType) && ' · '}
                            {row.description}
                          </>
                        }
                      />
                    ))}
                  </dl>
                </section>
              </div>

              <div className="actions">
                {stop.proformaId ? (
                  <button type="button" className="btn btn-primary" onClick={() => setDelivering(stop.proformaId)}>
                    Entregar
                  </button>
                ) : (
                  <>
                    {/* Paquete sin proforma (anterior al modulo): se entrega suelto. */}
                    <IconButton
                      label="Confirmar entrega"
                      icon="checkCircle"
                      onClick={() => setModal({ row: first, outcome: DeliveryOutcome.Entregado })}
                    />
                    <IconButton
                      label="Devolver a bodega"
                      icon="undo"
                      onClick={() => setModal({ row: first, outcome: DeliveryOutcome.DevueltoBodega })}
                    />
                  </>
                )}
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
          noun="entregas"
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        No hay entregas en ruta que coincidan.
      </EmptyList>

      {delivering && (
        <ProformaDeliveryModal
          proformaId={delivering}
          onClose={() => setDelivering(null)}
          onSaved={(message) => {
            setNotice(message);
            setError(null);
            setDelivering(null);
            void load();
          }}
        />
      )}

      {modal && (
        <DeliveryConfirmModal
          row={modal.row}
          outcome={modal.outcome}
          onClose={() => setModal(null)}
          onSaved={() => {
            setNotice(
              `${modal.row.code}: ${DELIVERY_OUTCOME_LABELS[modal.outcome].toLowerCase()}.`,
            );
            setError(null);
            setModal(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
