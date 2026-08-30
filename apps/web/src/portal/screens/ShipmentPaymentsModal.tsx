/**
 * Pagos de un trámite vistos por el STAFF: registrar el depósito que el cliente
 * envió y, para quien puede, aprobarlo o rechazarlo.
 *
 * Es la contraparte de `PaymentModal`, que es la del cliente. Van separados
 * porque no son la misma pantalla con otro botón: el cliente elige CÓMO paga y
 * el servidor le pone el importe (nunca lo declara él), mientras que aquí se
 * asienta un depósito que YA ocurrió y el importe lo dice el comprobante.
 *
 * DOS ACTOS, DOS PERMISOS, UNA PANTALLA:
 *
 *   - REGISTRAR (`payments.record`, Operativo y Administrador): el cliente manda
 *     el comprobante por fuera del portal y el staff lo mete al sistema con el
 *     archivo de respaldo. Quién lo hizo queda en el abono.
 *   - APROBAR (`payments.validate`, solo Administrador): dar el dinero por
 *     recibido. Por eso los botones de confirmar y rechazar preguntan por ese
 *     permiso y no por el de registrar.
 *
 * Con qué situación nace el abono NO lo decide esta pantalla: lo decide el
 * servidor a partir de quién firma la sesión (`recordedPaymentStatus`). Aquí se
 * usa la misma función solo para ANUNCIARLO antes de enviar; si las dos
 * respondieran distinto, al operario se le prometería un cobro que el sistema no
 * dio por recibido.
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNTS,
  BANK_ACCOUNT_LABELS,
  CURRENCY_LABELS,
  Currency,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PROOF_ATTACHMENT,
  PaymentStatus,
  Permission,
  attachmentRejection,
  bankAccountOptionLabel,
  bankAccountsForStaff,
  can,
  canSetExchangeRate,
  convertMoney,
  formatMoney,
  isSettled,
  outstanding,
  pendingAmount,
  recordedPaymentStatus,
  settledAmount,
} from '@courier/shared';
import type { BankAccount, PaymentDto, Role, ShipmentDto } from '@courier/shared';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatStamp, startOfLocalDayUtc } from '../lib/datetime';

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
    settled: isSettled(payments, shipment.invoiceTotalCrc),
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
  const bornStatus = recordedPaymentStatus(role);

  const [payments, setPayments] = useState<PaymentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Aviso de lo que acaba de pasar. Lleva el tono aparte porque no todo lo que
   * sale bien es una buena noticia: rechazar un abono funciona, pero anunciarlo
   * en verde lo lee como "abono correcto", que es justo lo contrario.
   */
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Formulario de registro ---
  const [amount, setAmount] = useState('');
  /** El importe ya lo tocó una persona: dejar de precargarlo con el saldo. */
  const [amountTouched, setAmountTouched] = useState(false);
  const [currency, setCurrency] = useState<Currency>(Currency.CRC);
  const [bankAccount, setBankAccount] = useState<BankAccount>(bankAccountsForStaff()[0]!);
  const [exchangeRate, setExchangeRate] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState(today());
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);

  /** Abono que se está rechazando: el rechazo exige motivo, y va inline. */
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const figures = figuresOf(payments, shipment);
  const invoiceTotal =
    currency === Currency.USD ? shipment.invoiceTotalUsd : shipment.invoiceTotalCrc;
  const due = currency === Currency.USD ? figures.dueUsd : figures.dueCrc;

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
   * Precarga el importe con el saldo mientras nadie lo haya escrito. Casi todo
   * depósito es por lo que se debe, y al cambiar de moneda hay que reexpresarlo:
   * dejar ₡25.000 en un campo que ahora dice dólares es el error de digitación
   * que este efecto evita.
   */
  useEffect(() => {
    if (amountTouched || loading) return;
    setAmount(due > 0 ? String(due) : '');
  }, [due, amountTouched, loading]);

  /**
   * La moneda sigue a la CUENTA elegida: se depositó en la cuenta en dólares,
   * el monto viene en dólares. Sigue siendo editable (un banco acepta un
   * depósito en otra moneda y lo convierte), pero el valor por defecto deja de
   * ser una suposición.
   */
  function pickAccount(account: BankAccount) {
    setBankAccount(account);
    setCurrency(BANK_ACCOUNTS[account].currency);
  }

  /** Mismo catálogo que aplica la API, para que el rechazo llegue al elegirlo. */
  function pickReceipt(file: File | null) {
    if (!file) {
      setReceipt(null);
      return;
    }
    const rejection = attachmentRejection(PROOF_ATTACHMENT, file.type, file.name);
    if (rejection) {
      setError(rejection);
      setReceipt(null);
      return;
    }
    setError(null);
    setReceipt(file);
  }

  async function reload(): Promise<PaymentDto[]> {
    const list = await api.get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`);
    setPayments(list.items);
    return list.items;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Sin permiso de registrar no hay formulario que enviar: el <form> sigue
    // envolviendo la lista de abonos, y un Enter en cualquier campo llegaria aqui.
    if (!canRecord || shipment.invoiceTotalCrc == null) return;
    setError(null);

    const value = Number(amount);
    if (!amount.trim() || Number.isNaN(value) || value <= 0) {
      setError('Indica el monto del depósito.');
      return;
    }
    if (!receiptNumber.trim()) {
      setError('Indica el número de comprobante.');
      return;
    }
    if (!depositDate) {
      setError('Indica la fecha del depósito.');
      return;
    }
    /**
     * Quien no puede aprobar TIENE que adjuntar el comprobante: registrar sin
     * respaldo le deja al administrador un abono que no puede validar contra
     * nada. Quien sí puede aprobar registra a veces leyendo el estado de cuenta,
     * donde no hay archivo que subir, así que ahí es opcional.
     */
    if (!canValidate && !receipt) {
      setError('Adjunta el comprobante que envió el cliente.');
      return;
    }

    setSaving(true);
    try {
      const created = await api.post<PaymentDto>('/payments/record', {
        shipmentId: shipment.id,
        amount: value,
        currency,
        bankAccount,
        receiptNumber: receiptNumber.trim(),
        // La fecha viaja como instante UTC, igual que el resto de la API.
        depositedAt: startOfLocalDayUtc(depositDate),
        ...(note.trim() ? { note: note.trim() } : {}),
        /**
         * La tasa solo la manda quien puede fijarla, y solo si la escribió. En
         * cualquier otro caso el servidor congela la de la factura, que es la
         * que cuadra el abono con lo cobrado (regla M5).
         */
        ...(canSetExchangeRate(role) && exchangeRate.trim()
          ? { exchangeRate: Number(exchangeRate) }
          : {}),
      });

      /**
       * El comprobante va en una segunda petición porque es multipart. Si esta
       * falla, el abono YA existe: no se puede deshacer en silencio, así que se
       * dice exactamente eso y el archivo se puede volver a subir desde la lista.
       */
      if (receipt) {
        try {
          await api.upload<PaymentDto>(`/payments/${created.id}/receipt`, receipt);
        } catch (err) {
          await reload();
          setError(
            err instanceof ApiError
              ? `El depósito quedó registrado, pero el comprobante no se adjuntó: ${err.message}`
              : 'El depósito quedó registrado, pero el comprobante no se adjuntó.',
          );
          setSaving(false);
          return;
        }
      }

      onSaved(
        created.status === PaymentStatus.Confirmado
          ? `Depósito registrado y confirmado (${formatMoney(created.amount, created.currency)}).`
          : `Depósito registrado (${formatMoney(created.amount, created.currency)}). Queda en validación por el administrador.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el depósito.');
      setSaving(false);
    }
  }

  /** Adjunta (o reemplaza) el comprobante de un abono ya registrado. */
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
      await api.post<PaymentDto>(`/payments/${paymentId}/resolve`, {
        confirm,
        ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}),
      });
      const items = await reload();
      setRejecting(null);
      setRejectNote('');
      setNotice({
        text: confirm
          ? isSettled(items, shipment.invoiceTotalCrc)
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
      <form
        className="modal modal-wide fadeUp"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <h3>Pagos del trámite</h3>
          <p>
            {shipment.code} · {shipment.description}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {notice && <div className={`banner${notice.ok ? ' ok' : ''}`}>{notice.text}</div>}

          {/*
            Sin factura aprobada no hay nada que cobrar: el monto se congela al
            aprobar los costos y hasta entonces un depósito no tendría contra qué
            aplicarse. El servidor responde lo mismo; decirlo aquí ahorra el viaje.
          */}
          {shipment.invoiceTotalCrc == null ? (
            <div className="banner warn">
              Este trámite todavía no tiene factura aprobada, así que no hay monto que cobrar.
              Aprueba los costos primero.
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

                      {/*
                        El comprobante va en su propio renglon, debajo del rastro
                        y arrancando donde arranca "Registro": no es un dato mas
                        de la fila sino lo que se abre o se sube, y como cuarta
                        columna su accion quedaba descolgada de los valores
                        vecinos.
                      */}
                      <div className="card-item-field pay-row-proof">
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

          {/* --- Registro de un depósito nuevo --- */}
          {canRecord && shipment.invoiceTotalCrc != null && (
            <div className="pay-sec">
              <div className="card-sec-title">Registrar depósito recibido</div>

              <div className="banner">
                {bornStatus === PaymentStatus.Confirmado ? (
                  <>
                    El depósito quedará <strong>confirmado</strong>: registrarlo y aprobarlo son el
                    mismo acto cuando quien lo digita es quien lo valida contra el estado de cuenta.
                  </>
                ) : (
                  <>
                    El depósito quedará en <strong>“Pagado - en validación”</strong>. El trámite
                    conserva su saldo hasta que el administrador apruebe el comprobante, así que el
                    paquete no sale a ruta por registrarlo.
                  </>
                )}
              </div>

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="sp-account">
                    Cuenta donde entró
                  </label>
                  <select
                    id="sp-account"
                    className="input"
                    value={bankAccount}
                    disabled={saving}
                    onChange={(e) => pickAccount(e.target.value as BankAccount)}
                  >
                    {/*
                      TODAS las cuentas, sin el filtro por tipo de trámite que se
                      le aplica al cliente: aquí se registra dónde dice el banco
                      que entró el dinero, y ahí el sistema no tiene nada que
                      opinar (`bankAccountsForStaff`).
                    */}
                    {bankAccountsForStaff().map((account) => (
                      <option key={account} value={account}>
                        {bankAccountOptionLabel(account)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="sp-date">
                    Fecha del depósito
                  </label>
                  <input
                    id="sp-date"
                    className="input"
                    type="date"
                    value={depositDate}
                    disabled={saving}
                    onChange={(e) => setDepositDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="sp-amount">
                    Monto depositado
                  </label>
                  <input
                    id="sp-amount"
                    className="input"
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    disabled={saving}
                    onChange={(e) => {
                      setAmountTouched(true);
                      setAmount(e.target.value);
                    }}
                  />
                  <p className="field-hint">
                    Saldo del trámite: {formatMoney(due, currency)}
                    {invoiceTotal != null && <> de {formatMoney(invoiceTotal, currency)}</>}. Un
                    abono parcial es válido: el trámite conserva el resto.
                  </p>
                </div>
                <div>
                  <label className="field-label" htmlFor="sp-currency">
                    Moneda
                  </label>
                  <select
                    id="sp-currency"
                    className="input"
                    value={currency}
                    disabled={saving}
                    onChange={(e) => setCurrency(e.target.value as Currency)}
                  >
                    {Object.values(Currency).map((c) => (
                      <option key={c} value={c}>
                        {CURRENCY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/*
                La tasa solo la digita quien puede fijarla. Para el resto la pone
                el servidor con la de la factura, así que un campo aquí sería un
                número que se escribe y se descarta.
              */}
              {/*
                De dos en dos, como los campos de arriba: en un modal ancho un
                campo por fila se estira a mil pixeles para escribir un numero de
                comprobante, y el formulario se lee como una lista de renglones
                vacios en vez de como una ficha.
              */}
              <div className="field-pair">
                {canSetExchangeRate(role) && (
                  <div>
                    <label className="field-label" htmlFor="sp-rate">
                      Tasa de cambio (opcional)
                    </label>
                    <input
                      id="sp-rate"
                      className="input"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="La de la factura"
                      value={exchangeRate}
                      disabled={saving}
                      onChange={(e) => setExchangeRate(e.target.value)}
                    />
                    <p className="field-hint">
                      Colones por 1 USD. En blanco se congela la tasa de la factura, que es la que
                      cuadra el abono con lo cobrado.
                    </p>
                  </div>
                )}

                <div>
                  <label className="field-label" htmlFor="sp-receipt-no">
                    Número de comprobante
                  </label>
                  <input
                    id="sp-receipt-no"
                    className="input mono"
                    value={receiptNumber}
                    disabled={saving}
                    onChange={(e) => setReceiptNumber(e.target.value)}
                  />
                </div>
              </div>

              <div className="field-pair">
                <FileField
                  id="sp-receipt"
                  label={canValidate ? 'Comprobante (opcional)' : 'Comprobante'}
                  accept={PROOF_ATTACHMENT.accept}
                  file={receipt}
                  onPick={pickReceipt}
                  disabled={saving}
                  hint={`El respaldo que envió el cliente. Se aceptan ${PROOF_ATTACHMENT.label}.`}
                />

                <div>
                  <label className="field-label" htmlFor="sp-note">
                    Nota (opcional)
                  </label>
                  <input
                    id="sp-note"
                    className="input"
                    value={note}
                    disabled={saving}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          {canRecord && shipment.invoiceTotalCrc != null && (
            <button type="submit" className="btn btn-primary" disabled={saving || loading}>
              {saving ? 'Registrando…' : 'Registrar depósito'}
            </button>
          )}
        </div>
      </form>
    </ModalOverlay>
  );
}
