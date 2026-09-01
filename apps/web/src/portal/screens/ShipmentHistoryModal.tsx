/**
 * Historial de estados de un tramite: la trazabilidad completa que ve el titular
 * al pulsar sobre su paquete en el tablero.
 *
 * Se lee de ARRIBA HACIA ABAJO como una cuenta atras: el estado actual encabeza
 * la lista y debajo van los anteriores, del mas reciente al mas antiguo. Es el
 * orden inverso al que devuelve la API (que ordena por fecha ascendente, el orden
 * natural de una tabla append-only) y es el correcto para esta ventana: quien la
 * abre viene a preguntar "¿dónde está mi paquete?" y esa respuesta tiene que
 * estar en la primera linea, no al final de un recorrido que hay que bajar entero.
 *
 * Cada asiento dice tres cosas, en este orden: en que estado entro, donde estaba
 * (`tracePlace`, que traduce la etiqueta operativa a algo que el cliente pueda
 * situar) y cuando. La hora es siempre la LOCAL del usuario: la API manda
 * instantes UTC y la conversion ocurre solo aqui (CLAUDE.md).
 *
 * La linea se pinta ENTERA, sin saltarse tramos. El unico estado que incomodaba
 * ensenarle al cliente era «En bodega - Pendiente pago», que se le sigue
 * pidiendo despues de haber pagado porque el pago no mueve el tramite; eso se
 * resuelve en `tracePlace` contando lo que el cobro dice de verdad, no borrando
 * el tramo. Para la operacion el estado sigue siendo el mismo: lo que cambia es
 * lo que se le cuenta al cliente.
 */
import { useEffect, useState } from 'react';
import { STATE_LABELS } from '@courier/shared';
import type {
  ShipmentDto,
  ShipmentEventDto,
  ShipmentEventsResponse,
  ShipmentPhotoDto,
  ShipmentPhotosResponse,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import { formatStamp } from '../lib/datetime';
import { STATE_TONE } from '../lib/tone';
import { tracePlace } from '../lib/trace';

interface Props {
  row: ShipmentDto;
  onClose: () => void;
}

/** Marca del asiento actual: el paquete esta AQUI. */
function MarkCurrent() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

/** Marca de un asiento ya superado. */
function MarkDone() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

/** Chincheta de la linea de ubicacion. */
function PinIcon() {
  return (
    <svg className="trace-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

/** Lupa de la esquina de cada miniatura: dice que la foto se puede ampliar. */
function ZoomIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
    </svg>
  );
}

export function ShipmentHistoryModal({ row, onClose }: Props) {
  const [events, setEvents] = useState<ShipmentEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<ShipmentPhotoDto[]>([]);
  /** Foto abierta a tamaño completo, o null. Es la ampliacion del criterio. */
  const [zoomed, setZoomed] = useState<ShipmentPhotoDto | null>(null);

  /**
   * Las fotos van en su propia peticion y con su propio estado: las sirve el
   * proveedor y pueden tardar (o no llegar). El historial no espera por ellas.
   *
   * Un fallo aqui no se le cuenta al cliente ni ocupa el hueco del banner de
   * error: la API ya distingue "no tiene fotos" de "no se pudieron pedir", y en
   * los dos casos la respuesta correcta de la pantalla es la misma, no ensenar la
   * seccion. Quien abre esta ventana viene a ver donde esta su paquete.
   */
  useEffect(() => {
    let alive = true;
    api
      .get<ShipmentPhotosResponse>(`/shipments/${row.id}/photos`)
      .then((res) => {
        if (alive) setPhotos(res.items);
      })
      .catch(() => {
        if (alive) setPhotos([]);
      });
    return () => {
      alive = false;
    };
  }, [row.id]);

  /**
   * Cierra SOLO la capa de encima. Sin esto, la tecla Esc con una foto ampliada
   * cerraria las dos ventanas a la vez: cada `ModalOverlay` escucha en window y
   * las dos reciben la misma pulsacion.
   */
  function closeTop() {
    if (zoomed) {
      setZoomed(null);
      return;
    }
    onClose();
  }

  useEffect(() => {
    let alive = true;
    api
      .get<ShipmentEventsResponse>(`/shipments/${row.id}/events`)
      .then((res) => {
        if (!alive) return;
        // La API ordena del mas antiguo al mas reciente; la lista se lee al reves.
        setEvents([...res.items].reverse());
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof ApiError ? err.message : 'No se pudo cargar el historial.');
        }
      });
    return () => {
      alive = false;
    };
  }, [row.id]);

  return (
    <>
      <ModalOverlay onClose={closeTop}>
        <div
          className="modal modal-sm fadeUp"
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Historial de ${row.code}`}
        >
          <div className="modal-head">
            <h3>Historial</h3>
            <p>
              {row.code} · {row.description}
            </p>
          </div>

          <div className="modal-body">
            {error && <div className="banner err">{error}</div>}

            {/* Las fotos van ARRIBA del recorrido: son lo primero que se mira
                cuando existen (es la foto de "mi paquete"), y sin ellas la ventana
                queda exactamente como estaba. La seccion entera desaparece cuando
                no hay: un titulo con un hueco vacio debajo se lee como un error. */}
            {photos.length > 0 && (
              <section className="pkg-photos">
                <h4 className="pkg-photos-title">
                  {photos.length === 1 ? 'Foto del paquete en bodega' : 'Fotos del paquete en bodega'}
                </h4>
                <div className="pkg-photo-grid">
                  {photos.map((photo, i) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="pkg-photo"
                      onClick={() => setZoomed(photo)}
                      aria-label={`Ampliar la foto ${i + 1} de ${photos.length}`}
                    >
                      <img src={photo.url} alt={`Paquete ${row.code}, foto ${i + 1}`} loading="lazy" />
                      <span className="pkg-photo-zoom" aria-hidden="true">
                        <ZoomIcon />
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {!events && !error && <div className="empty">Cargando historial…</div>}

            {events && events.length === 0 && !error && (
              <div className="empty">Este trámite todavía no registra movimientos.</div>
            )}

            {events && events.length > 0 && (
              <ol className="trace">
                {events.map((event, i) => {
                  /* El primero de la lista es el ultimo que ocurrio: es DONDE esta
                     el tramite ahora, y por eso se resalta. El resto ya se cumplio. */
                  const isCurrent = i === 0;
                  return (
                    <li
                      key={event.id}
                      className={`trace-step tone-${STATE_TONE[event.state]}${isCurrent ? ' is-current' : ''}`}
                    >
                      <span className="trace-mark" aria-hidden="true">
                        {isCurrent ? <MarkCurrent /> : <MarkDone />}
                      </span>

                      <div className="trace-body">
                        <div className="trace-head">
                          <span className="trace-state">{STATE_LABELS[event.state]}</span>
                          {isCurrent && <span className="trace-now">Actual</span>}
                        </div>

                        <div className="trace-place">
                          <PinIcon />
                          {tracePlace(row, event.state, isCurrent)}
                        </div>

                        {/* La nota solo aparece cuando la hay: la mayoria de avances
                            no llevan, y una linea vacia por tramo alargaria la
                            columna sin decir nada. Al titular la API ya le manda
                            unicamente las notas escritas para el. */}
                        {event.note && <p className="trace-note">{event.note}</p>}
                        {event.createdByName && (
                          <p className="trace-note">Registrado por {event.createdByName}</p>
                        )}

                        <time className="trace-when" dateTime={event.createdAt}>
                          {formatStamp(event.createdAt)}
                        </time>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
      </ModalOverlay>

      {/* La ampliacion es otra capa, no un modal con cabecera y pie: la foto es
          todo el contenido y cualquier marco le quitaria sitio. Se cierra con un
          clic fuera, con la X o con Esc, como el resto de ventanas del portal. */}
      {zoomed && (
        <ModalOverlay onClose={() => setZoomed(null)}>
          <div
            className="photo-zoom fadeUp"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Foto del paquete ${row.code}`}
          >
            <img src={zoomed.url} alt={`Paquete ${row.code} en la bodega de Miami`} />
            {zoomed.takenAt && (
              <time className="photo-zoom-when" dateTime={zoomed.takenAt}>
                Tomada el {formatStamp(zoomed.takenAt)}
              </time>
            )}
            <button
              type="button"
              className="photo-zoom-close"
              onClick={() => setZoomed(null)}
              aria-label="Cerrar la foto"
            >
              ×
            </button>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}
