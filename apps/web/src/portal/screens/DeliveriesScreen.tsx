/**
 * Pantalla "Entregas" (permiso delivery.manage) — Requerimientos Parte 5.
 *
 * Es la pantalla del mensajero y se diseña para eso: se usa de pie, con una mano
 * y en la calle. Por eso lista TARJETAS y no una tabla (una tabla de 10 columnas
 * es inservible en un telefono) y muestra la direccion y el telefono del cliente
 * completos.
 *
 * Sus dos acciones (confirmar o devolver) son iconos como en el resto del
 * portal, pero NO encogen hasta el tamaño de un listado de escritorio: el CSS
 * les reserva un blanco mayor, y en pantalla tactil lo sube a 44px. Aqui se
 * pulsa sin mirar y equivocarse cierra una entrega que no era.
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

export interface DeliveryQueueRow {
  id: string;
  code: string;
  tracking: string;
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
  updatedAt: string;
}

type ModalState = { row: DeliveryQueueRow; outcome: DeliveryOutcome } | null;

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

  /**
   * La cola del dia, paginada. Los dos filtros del manual (nombre/tracking y
   * ruta) se aplican en SQL: el mensajero que filtra por su ruta tiene que ver
   * SU recorrido entero, no la parte de el que cabia en la primera pagina.
   */
  const list = usePagedList<DeliveryQueueRow>(
    '/deliveries/queue',
    { q: q.trim() || undefined, routeNumber: route.trim() || undefined },
    { errorMessage: 'No se pudo cargar la ruta.' },
  );
  const { error, setError, reload: load } = list;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Entregas</div>
          {list.data && (
            <div className="count">{list.total.toLocaleString('es-CR')} paquetes en ruta</div>
          )}
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
        {list.items.map((row) => (
          <article className="card-item tone-info" key={row.id}>
            <div className="card-item-head">
              <div className="card-item-ident">
                <div className="card-item-code">{row.code}</div>
                <div className="card-item-title">{row.clientName}</div>
                <div className="card-item-sub">
                  {SHIPMENT_TYPE_LABELS[row.shipmentType]} · {row.tracking}
                </div>
              </div>
              <div className="card-item-aside">
                {/* El mensajero tiene que saber ANTES de tocar el timbre si el
                    paquete lleva saldo: es lo único de esta tarjeta que cambia lo
                    que hace al llegar. */}
                <PayFlag
                  shipmentType={row.shipmentType}
                  invoiceTotalUsd={row.invoiceTotalUsd}
                  invoiceTotalCrc={row.invoiceTotalCrc}
                  settledUsd={row.settledUsd}
                  settledCrc={row.settledCrc}
                  settled={row.settled}
                  pendingUsd={row.pendingUsd}
                  pendingCrc={row.pendingCrc}
                />
                <span className="spill">
                  <span className="dot" />
                  {row.routeNumber != null ? `Ruta ${row.routeNumber}` : 'Sin ruta'}
                </span>
              </div>
            </div>

            <div className="card-item-body">
              <section className="card-sec">
                <dl className="card-sec-fields">
                  <Field
                    label="Dirección"
                    value={`${findProvince(row.provinceCode)?.name}, ${findCanton(row.cantonCode)?.name}, ${findDistrict(row.districtCode)?.name}`}
                  />
                  <Field label="Otras señas" value={row.addressLine} />
                  {/* Enlace `tel:` a proposito: el mensajero llama desde la propia tarjeta. */}
                  <Field
                    label="Teléfono"
                    value={row.clientPhone ? <a href={`tel:${row.clientPhone}`}>{row.clientPhone}</a> : null}
                    mono
                  />
                  <Field label="Descripción" value={row.description} />
                </dl>
              </section>
            </div>

            {/* Ambas abren un modal que pide confirmacion con texto: aqui el
                icono elige el camino, no cierra la entrega. */}
            <div className="actions">
              <IconButton
                label="Confirmar entrega"
                icon="checkCircle"
                tone="primary"
                onClick={() => setModal({ row, outcome: DeliveryOutcome.Entregado })}
              />
              <IconButton
                label="Devolver a bodega"
                icon="undo"
                onClick={() => setModal({ row, outcome: DeliveryOutcome.DevueltoBodega })}
              />
            </div>
          </article>
        ))}
        </div>

        <Pagination
          page={list.page}
          pageSize={list.pageSize}
          total={list.total}
          totalPages={list.totalPages}
          onPage={list.goToPage}
          busy={list.refreshing}
          noun="paquetes"
        />
      </ListBody>

      <EmptyList loading={list.loading} empty={list.items.length === 0}>
        No hay paquetes en ruta que coincidan.
      </EmptyList>

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

/** Ruta de descarga de la foto de un intento; la usa el historial del trámite. */
export function attemptPhotoUrl(attemptId: string): string {
  return `${API_BASE}/api/deliveries/attempts/${attemptId}/photo`;
}
