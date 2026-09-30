/**
 * Pagos de un trámite vistos por el STAFF: los abonos que tiene, su comprobante
 * y, para quien puede (`payments.validate`, solo Administrador), aprobarlos o
 * rechazarlos.
 *
 * Con el modulo de proformas los depositos ya NO se registran aqui: todo se
 * cobra por proforma completa, y el registro vive en el detalle de la proforma.
 * Un abono que es parte de un COBRO DE PROFORMAS se aprueba o rechaza con su
 * cobro entero (fue un solo deposito por varias proformas).
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNT_LABELS,
  Currency,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PROOF_ATTACHMENT,
  PaymentStatus,
  Permission,
  attachmentRejection,
  can,
  convertMoney,
  formatMoney,
  chargeBasisFor,
  isSettled,
  outstanding,
  pendingAmount,
  settledAmount,
} from '@courier/shared';
import type {
  PaymentDto,
  Role,
  ShipmentDto,
} from '@courier/shared';
import { ModalOverlay } from '../components/ModalOverlay';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatStamp } from '../lib/datetime';
import { useErrorToast } from '../lib/toast';
import { ProformaLink } from '../components/ProformaLink';

/**
 * Pildora del estado de un abono. Rechazado NO es un estado neutro: es dinero
 * que no entro, y pintado en gris como el pendiente obliga a leer la etiqueta
 * para distinguir lo que falta validar de lo que ya se descarto.
 */
function statusPill(status: PaymentStatus): string {
  if (status === PaymentStatus.Confirmado) return 'spill ok';
  if (status === PaymentStatus.Rechazado) return 'spill danger';
  return 'spill warn';
}

interface Props {
  shipment: ShipmentDto;
  role: Role;
  onClose: () => void;
  /**
   * Cierra anunciando lo que pasó. El mensaje sale de aquí porque solo esta
   * pantalla sabe si el depósito quedó en validación o confirmado, y el listado
   * de fondo se recarga igual en los dos casos.
   */
  onSaved: (message: string) => void;
}

/** Cifras del cobro, recalculadas sobre los abonos que devuelve la API. */
interface Figures {
  settled: boolean;
  settledCrc: number;
  settledUsd: number;
  pendingCrc: number;
  dueCrc: number;
  dueUsd: number;
}

/**
 * El cobro del trámite a partir de sus abonos.
 *
 * Se calcula aquí y no se lee del `ShipmentDto` a propósito: la ficha del
 * listado se cargó antes de abrir el modal y queda vieja en cuanto se registra o
 * se resuelve un abono. Son las MISMAS funciones del dominio con las que el
 * servidor responde `settled` y `pendingCrc`, así que el número no se bifurca:
 * lo único que cambia es cuándo se evalúa.
 */
function figuresOf(payments: readonly PaymentDto[], shipment: ShipmentDto): Figures {
  const settledCrc = settledAmount(payments, Currency.CRC);
  const settledUsd = settledAmount(payments, Currency.USD);

  return {
    // En la moneda con la que se cobra el trámite (`chargeBasisFor`), la misma
    // con la que responde la API: en Paquetería, dólares.
    settled: isSettled(payments, chargeBasisFor(shipment.shipmentType, shipment)),
    settledCrc,
    settledUsd,
    pendingCrc: pendingAmount(payments, Currency.CRC),
    dueCrc: outstanding(settledCrc, shipment.invoiceTotalCrc, Currency.CRC),
    dueUsd: outstanding(settledUsd, shipment.invoiceTotalUsd, Currency.USD),
  };
}

/** Hoy en formato `yyyy-mm-dd` local: el depósito casi siempre es del día. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function ShipmentPaymentsModal({ shipment, role, onClose, onSaved }: Props) {
  const canRecord = can(role, Permission.PaymentsRecord);
  const canValidate = can(role, Permission.PaymentsValidate);
  /**
   * Cómo va a quedar el depósito que se registre aquí. Se pregunta al dominio,
   * no al rol: es la misma regla que aplica el servidor al insertarlo.
   */

  const [payments, setPayments] = useState<PaymentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const setError = useErrorToast();
  /**
   * Aviso de lo que acaba de pasar. Lleva el tono aparte porque no todo lo que
   * sale bien es una buena noticia: rechazar un abono funciona, pero anunciarlo
   * en verde lo lee como "abono correcto", que es justo lo contrario.
   */
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Formulario de registro ---
  const figures = figuresOf(payments, shipment);

  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  /**
   * La cuenta del casillero, para saber si se cobra agrupada. Null mientras no se
   * ha preguntado o el trámite no tiene dueño.
   */
  useEffect(() => {
    api
      .get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`)
      .then((list) => setPayments(list.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los pagos.'),
      )
      .finally(() => setLoading(false));
  }, [shipment.id]);

  /**
   * ¿Este casillero se cobra agrupado? Se pregunta una vez al abrir, y solo si
   * quien mira puede registrar depósitos: es lo único que cambia con la respuesta.
   */
  async function reload(): Promise<PaymentDto[]> {
    const list = await api.get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`);
    setPayments(list.items);
    return list.items;
  }

  async function attach(paymentId: string, file: File) {
    const rejection = attachmentRejection(PROOF_ATTACHMENT, file.type, file.name);
    if (rejection) {
      setError(rejection);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.upload<PaymentDto>(`/payments/${paymentId}/receipt`, file);
      await reload();
      setNotice({ text: 'Comprobante adjuntado.', ok: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo subir el comprobante.');
    } finally {
      setSaving(false);
    }
  }

  /** Confirma o rechaza un abono pendiente. Solo con `payments.validate`. */
  async function resolve(paymentId: string, confirm: boolean) {
    if (!confirm && !rejectNote.trim()) {
      // "Abono" y no "depósito": `resolve` vale para los dos medios, y por aquí
      // pasa tambien un cobro con tarjeta, que no tiene ningun deposito detras.
      setError('Indica por qué se rechaza el abono.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      /**
       * Un abono de un COBRO DE PROFORMAS se valida con su cobro entero: fue un
       * solo deposito por varias proformas, y aprobarlo a medias dejaria unas
       * proformas pagadas y otras no con el mismo comprobante.
       */
      const payment = payments.find((p) => p.id === paymentId);
      const body = { confirm, ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}) };
      if (payment?.groupId) {
        await api.post(`/payments/groups/${payment.groupId}/resolve`, body);
      } else {
        await api.post<PaymentDto>(`/payments/${paymentId}/resolve`, body);
      }
      const items = await reload();
      setRejecting(null);
      setRejectNote('');
      setNotice({
        text: confirm
          ? isSettled(items, chargeBasisFor(shipment.shipmentType, shipment))
            ? 'Abono confirmado. El trámite queda pagado.'
            : 'Abono confirmado. El trámite conserva saldo.'
          : 'Abono rechazado. El trámite conserva su saldo.',
        ok: confirm,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo resolver el depósito.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      {/*
        `modal-wide` y no el ancho base: aqui no hay un formulario, hay un
        historial. Cada abono trae cuatro datos largos (quien lo registro, quien
        lo resolvio, la nota y el comprobante) y en 560px caian en columnas de
        ~120px donde "Abraham Beens · 28 ago 2026 · 21:51" se partia en tres
        renglones. El ancho es lo que evita ese picado.
      */}
      <div className="modal modal-wide fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Pagos del trámite</h3>
          <p>
            {shipment.code} · {shipment.description}
          </p>
        </div>

        <div className="modal-body">
          {notice && <div className={`banner${notice.ok ? ' ok' : ''}`}>{notice.text}</div>}

          {/*
            Sin factura aprobada no hay nada que cobrar: el monto se congela al
            aprobar los costos y hasta entonces un depósito no tendría contra qué
            aplicarse. El servidor responde lo mismo; decirlo aquí ahorra el viaje.
          */}
          {shipment.invoiceTotalCrc == null ? (
            <div className="banner warn">
              Este trámite todavía no tiene factura aprobada, así que no hay monto que cobrar.
              Aprueba su proforma primero.
            </div>
          ) : (
            <div className="pay-sec is-money">
              <div className="card-sec-title">Cobro del trámite</div>
              <dl className="pay-fields">
                <div className="card-item-field">
                  <dt>Factura</dt>
                  <dd>{formatMoney(shipment.invoiceTotalCrc, Currency.CRC)}</dd>
                </div>
                <div className="card-item-field">
                  <dt>Confirmado</dt>
                  <dd>{formatMoney(figures.settledCrc, Currency.CRC)}</dd>
                </div>
                {/* En validación va aparte del confirmado a propósito: no es
                    dinero recibido y sumarlo diría que el trámite está cobrado. */}
                <div className="card-item-field">
                  <dt>En validación</dt>
                  <dd>{formatMoney(figures.pendingCrc, Currency.CRC)}</dd>
                </div>
                <div className="card-item-field">
                  <dt>Saldo</dt>
                  <dd className="pay-due">{formatMoney(figures.dueCrc, Currency.CRC)}</dd>
                </div>
              </dl>
            </div>
          )}

          {figures.settled && <div className="banner ok">Este trámite ya está pagado.</div>}

          {/* --- Abonos registrados --- */}
          {!loading && payments.length > 0 && (
            <div className="pay-sec">
              <div className="card-sec-title">Abonos registrados</div>
              {/*
                Cada abono en su propia fila enmarcada, no encadenados en una
                sola rejilla. Enfilados, los campos del segundo continuaban las
                columnas del primero y no habia forma de ver donde acababa un
                movimiento y empezaba el siguiente. Arriba lo que identifica al
                abono (importe y estado); debajo, separado por un filete, su
                rastro (quien, cuando, con que respaldo).
              */}
              <div className="pay-rows">
                {payments.map((payment) => (
                  <div
                    className={`pay-row${
                      payment.status === PaymentStatus.Rechazado ? ' is-off' : ''
                    }`}
                    key={payment.id}
                  >
                    <div className="pay-row-head">
                      <div className="pay-row-sum">
                        <span className="pay-row-amount">
                          {formatMoney(payment.amount, payment.currency)}
                        </span>
                        {/* El equivalente en colones es la cifra con la que se
                            decide si el trámite está cubierto (`isSettled`), y se
                            reexpresa con SU propia tasa congelada (regla M5). */}
                        {payment.currency !== Currency.CRC && (
                          <span className="pay-row-alt">
                            ·{' '}
                            {formatMoney(
                              convertMoney(
                                payment.amount,
                                payment.currency,
                                Currency.CRC,
                                payment.exchangeRate,
                              ),
                              Currency.CRC,
                            )}
                          </span>
                        )}
                        <span className={statusPill(payment.status)}>
                          {PAYMENT_STATUS_LABELS[payment.status]}
                        </span>
                      </div>
                      <div className="pay-row-meta">
                        {formatDate(payment.depositedAt ?? payment.createdAt)} ·{' '}
                        {PAYMENT_METHOD_LABELS[payment.method]}
                        {payment.bankAccount && <> · {BANK_ACCOUNT_LABELS[payment.bankAccount]}</>}
                        {/* Qué parte del abono fue la comisión de la pasarela.
                            El importe ya la incluye: se cobró junto con el saldo
                            y quedó asentada como línea de costo en la factura. */}
                        {payment.surchargeAmount > 0 && (
                          <>
                            {' '}
                            · incluye {formatMoney(payment.surchargeAmount, payment.currency)} de
                            comisión
                          </>
                        )}
                      </div>
                    </div>

                    {/*
                      QUIÉN lo hizo. Son dos sellos distintos porque son dos actos:
                      registrar el comprobante y darlo por cobrado. Un abono que
                      espera validación solo tiene el primero, y eso es justo lo que
                      el administrador necesita ver para saber a quién preguntarle.
                    */}
                    <dl className="pay-row-fields">
                      <div className="card-item-field">
                        <dt>Registró</dt>
                        <dd>
                          {payment.createdByName ?? '—'} · {formatStamp(payment.createdAt)}
                          {payment.receiptNumber && (
                            <>
                              {' '}
                              · comprobante <span className="mono">{payment.receiptNumber}</span>
                            </>
                          )}
                        </dd>
                      </div>
                      {payment.confirmedByName && payment.confirmedAt && (
                        <div className="card-item-field">
                          <dt>
                            {payment.status === PaymentStatus.Rechazado ? 'Rechazó' : 'Aprobó'}
                          </dt>
                          <dd>
                            {payment.confirmedByName} · {formatStamp(payment.confirmedAt)}
                          </dd>
                        </div>
                      )}
                      {payment.note && (
                        <div className="card-item-field">
                          <dt>Nota</dt>
                          <dd>{payment.note}</dd>
                        </div>
                      )}
                    </dl>

                    {/*
                      El comprobante NO entra en la rejilla del rastro: va en su
                      propio renglon y pegado a la derecha. No es un dato mas del
                      abono sino la accion de la fila (abrirlo o subirlo), y como
                      una columna mas quedaba flotando a media fila con hueco a su
                      derecha. Fuera de la rejilla y no con `grid-column: 1 / -1`
                      porque las pistas de arriba son `auto-fit` y ahi el tramo
                      hasta la ultima linea no es de fiar.
                    */}
                    <dl className="pay-row-proof">
                      <div className="card-item-field">
                        <dt>Comprobante</dt>
                        <dd>
                          {/*
                            Es un <a> y no un botón porque la descarga la resuelve
                            el navegador contra la API, que es quien comprueba el
                            permiso: la clave del almacén no viaja en la URL.

                            `btn-link` y no `btn-ghost btn-sm`: aquí la acción
                            ocupa el sitio de un valor, entre campos que son texto
                            de 13px. Con caja de botón quedaba un escalón por
                            debajo de "Registró" y con su texto desplazado de la
                            etiqueta "Comprobante" que la encabeza.
                          */}
                          {payment.receiptFileKey ? (
                            <a
                              className="btn btn-link"
                              href={`${API_BASE}/api/payments/${payment.id}/receipt`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Ver comprobante
                            </a>
                          ) : payment.status === PaymentStatus.Rechazado ? (
                            <>—</>
                          ) : (
                            /* Sin respaldo todavía: se puede subir desde aquí, que es
                           donde se descubre el hueco (p. ej. si la subida falló
                           al registrar el abono). */
                            <label className="btn btn-link">
                              Adjuntar
                              <input
                                type="file"
                                accept={PROOF_ATTACHMENT.accept}
                                style={{ display: 'none' }}
                                disabled={saving}
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) void attach(payment.id, file);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                          )}
                        </dd>
                      </div>
                    </dl>

                    {/*
                      APROBAR ES SOLO DEL ADMINISTRADOR. El operario ve el abono y
                      su comprobante, pero no estos botones: registrar no es cobrar.
                      La API aplica la misma regla (`payments.validate`), así que
                      esconderlos es comodidad, no la barrera.
                    */}
                    {canValidate && payment.status === PaymentStatus.Pendiente && (
                      <div className="pay-row-actions">
                        {rejecting === payment.id ? (
                          <>
                            <input
                              className="input"
                              placeholder="Motivo del rechazo"
                              value={rejectNote}
                              onChange={(e) => setRejectNote(e.target.value)}
                              /* Enter aquí NO envía el formulario de registro que
                               envuelve la lista: son dos acciones distintas y
                               una tecla no puede disparar la equivocada. */
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                void resolve(payment.id, false);
                              }}
                            />
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={saving}
                              onClick={() => {
                                setRejecting(null);
                                setRejectNote('');
                              }}
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={saving}
                              onClick={() => void resolve(payment.id, false)}
                            >
                              Confirmar rechazo
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={saving}
                              onClick={() => setRejecting(payment.id)}
                            >
                              Rechazar
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={saving}
                              onClick={() => void resolve(payment.id, true)}
                            >
                              Aprobar pago
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/*
            Los depositos ya no se registran contra un tramite suelto: todo se
            cobra por proforma completa (decision D2), asi que el registro vive
            en el detalle de la proforma.
          */}
          {canRecord && !figures.settled && shipment.invoiceTotalCrc != null && (
            <div className="banner">
              Los depósitos se registran por proforma completa.
              {shipment.proforma?.number && <> Este trámite está en la proforma <strong><ProformaLink id={shipment.proforma.id} number={shipment.proforma.number} /></strong>.</>}{' '}
              Regístralo desde su detalle en <strong>Proformas</strong>.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>

    </ModalOverlay>
  );
}
