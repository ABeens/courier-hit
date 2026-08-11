/**
 * Pago de un trámite por el cliente — Requerimientos Parte 2, "Pagos".
 *
 * Los medios de pago disponibles los decide la API (`/payments/quote`) cruzando
 * la tarifa del cliente con lo que el sistema puede cobrar hoy. Esta pantalla no
 * los deduce: si la tarifa no admite tarjeta, la opción sencillamente no llega,
 * que es exactamente lo que pide el manual ("no debe mostrar esa opción").
 *
 * Depósito bancario: se registra el abono y luego se sube el comprobante, en dos
 * pasos. El abono queda PENDIENTE hasta que el staff lo valida — subir una foto
 * no es haber pagado, y decirle lo contrario al cliente sería mentirle.
 *
 * Tarjeta: el servidor crea el intento de cobro y devuelve con qué abrir el
 * formulario. De ahí salen dos caminos:
 *
 *   - PASARELA SIMULADA (`intent.simulated`): no hay SDK que montar. Se muestran
 *     dos botones para aprobar o rechazar el cobro, que es lo que permite recorrer
 *     el flujo completo sin credenciales de Onvo.
 *   - PASARELA REAL: TODO(09/onvo) montar el SDK web de Onvo con `publicKey` y
 *     `paymentIntentId`. Quien confirma el pago NO es el navegador sino el webhook,
 *     así que al terminar hay que volver a consultar el pago en vez de darlo por
 *     bueno con el callback del SDK.
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNTS,
  BankAccount,
  CURRENCY_LABELS,
  Currency,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PaymentMethod,
  PaymentStatus,
  bankAccountOptionLabel,
  billingAmounts,
  billingCurrencyFor,
  convertMoney,
  formatMoney,
} from '@courier/shared';
import type { PaymentDto, PaymentIntentDto, Role, ShipmentDto } from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import { formatDate } from '../lib/datetime';

interface Quote {
  shipmentId: string;
  shipmentCode: string;
  description: string;
  invoiceTotalUsd: number | null;
  invoiceTotalCrc: number | null;
  settledUsd: number;
  settledCrc: number;
  pendingCrc: number;
  pendingUsd: number;
  /** Saldo en colones: lo que se le cobra a la tarjeta, se muestre o no así. */
  dueCrc: number;
  settled: boolean;
  /** El saldo ya está cubierto por un abono sin validar: no se puede pagar otra vez. */
  inValidation: boolean;
  availableMethods: PaymentMethod[];
  /**
   * Cuentas a las que este trámite admite depósito: en Paquetería solo las de
   * dólares. Llega de la API porque es la MISMA lista contra la que el servidor
   * revalida; deducirla aquí sería ofrecer opciones que acaban en un 403.
   */
  availableBankAccounts: BankAccount[];
  payableState: boolean;
}

interface Props {
  shipment: ShipmentDto;
  /**
   * Quien abrio el modal. Solo decide en que MONEDA se le habla del cobro
   * (`billingCurrencyFor`): hoy solo el cliente tiene el permiso de pagar, pero
   * dar por supuesto el rol aqui seria enterrar esa condicion en la pantalla.
   */
  role: Role;
  onClose: () => void;
  /**
   * Cierra el modal anunciando lo que PASO. El mensaje viaja desde aqui porque
   * solo este componente distingue un deposito registrado (queda por validar) de
   * un cobro con tarjeta ya aprobado (el tramite queda cubierto), y decirle al
   * cliente que su pago "queda pendiente" cuando ya se cobro es lo que le hace
   * pensar que no paso nada.
   *
   * Un cobro RECHAZADO no llama aqui: el modal se queda abierto para reintentar.
   */
  onPaid: (message: string) => void;
}

export function PaymentModal({ shipment, role, onClose, onPaid }: Props) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [payments, setPayments] = useState<PaymentDto[]>([]);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  /**
   * Cuenta elegida. Arranca en null y la fija la cotización con la primera que
   * el trámite admite: cuál es la primera depende del tipo de trámite, así que
   * un valor por defecto escrito aquí sería justo el que Paquetería no acepta.
   */
  const [bankAccount, setBankAccount] = useState<BankAccount | null>(null);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * Cobro con tarjeta ya iniciado, a la espera de resolverse. Mientras exista, el
   * formulario cede el paso al bloque de la pasarela: el pago ya está creado en el
   * servidor y volver a enviarlo abriría un segundo cobro por el mismo saldo.
   */
  const [cardIntent, setCardIntent] = useState<{ paymentId: string; intent: PaymentIntentDto } | null>(
    null,
  );

  /**
   * Lo ya abonado y sin validar, tal como lo calcula el servidor. No se recalcula
   * aqui sobre la lista de pagos: la cifra que se le enseña al cliente y la que
   * usa la guarda que rechaza un segundo abono tienen que ser la misma, o el
   * modal acabaria ofreciendo un boton que la API contesta con un 409.
   */
  const pendingCrc = quote?.pendingCrc ?? 0;

  /**
   * Las cifras del cobro en la moneda que le toca leer a quien abrio el modal: en
   * Paqueteria, dolares sin convertir a colones (`billingCurrencyFor`). Es la
   * MISMA proyeccion que hace la ficha del listado, para que el saldo de la
   * bandera y el de esta pantalla no se lean en monedas distintas.
   *
   * Solo cambia como se DICE el importe. Lo que se le cobra a la tarjeta lo
   * decide el servidor, y eso sigue siendo el saldo en colones.
   */
  const currency = billingCurrencyFor(shipment.shipmentType, role);
  const amounts = quote ? billingAmounts(quote, currency, quote.settled) : null;

  /**
   * ¿Se puede pagar ahora mismo? No basta con que quede saldo: un comprobante ya
   * subido y sin resolver deja el tramite EN VALIDACION, y ahi el cliente no
   * vuelve a pagar —pagaria dos veces el mismo saldo, porque un abono pendiente
   * no lo baja—. Solo mira su comprobante y espera.
   */
  const canPay = quote != null && !quote.settled && !quote.inValidation;

  useEffect(() => {
    Promise.all([
      api.get<Quote>(`/payments/quote/${shipment.id}`),
      api.get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`),
    ])
      .then(([q, list]) => {
        setQuote(q);
        setPayments(list.items);
        setMethod(q.availableMethods[0] ?? null);
        setBankAccount(q.availableBankAccounts[0] ?? null);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el pago.'),
      );
  }, [shipment.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method) return;
    // Un depósito sin cuenta no se puede conciliar: quien valida tendría que
    // buscar el comprobante en los cuatro estados de cuenta. El servidor lo
    // rechaza igual; decirlo aquí ahorra el viaje.
    if (method === PaymentMethod.DepositoBancario && !bankAccount) {
      setError('Elige la cuenta donde hiciste el depósito.');
      return;
    }
    setError(null);
    setSaving(true);

    try {
      const { payment, intent } = await api.post<{
        payment: PaymentDto;
        intent: PaymentIntentDto | null;
      }>('/payments', {
        shipmentId: shipment.id,
        method,
        ...(method === PaymentMethod.DepositoBancario
          ? {
              bankAccount,
              ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
              // La fecha se manda como instante UTC, igual que el resto de la API.
              ...(depositDate ? { depositedAt: new Date(depositDate).toISOString() } : {}),
            }
          : {}),
      });

      // Tarjeta: el pago queda PENDIENTE hasta que la pasarela lo resuelva. No se
      // avisa de nada todavia ni se cierra el modal; el cobro aun no ocurrio.
      if (method === PaymentMethod.Tarjeta && intent) {
        setCardIntent({ paymentId: payment.id, intent });
        setSaving(false);
        return;
      }

      // El comprobante va en una segunda petición porque es multipart: mezclarlo
      // con el JSON obligaría a validar abono y archivo en la misma transacción.
      if (receipt) {
        const form = new FormData();
        form.set('file', receipt);
        const res = await fetch(`${API_BASE}/api/payments/${payment.id}/receipt`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiError(
            res.status,
            body?.error?.code ?? 'UNKNOWN',
            body?.error?.message ?? 'No se pudo subir el comprobante.',
          );
        }
      }

      onPaid('Registramos tu depósito. Queda pendiente de validación por nuestro equipo.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el pago.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Resuelve el cobro SIMULADO. Solo aparece con la pasarela de pruebas; contra la
   * pasarela real este endpoint responde 404 y quien confirma es el webhook.
   */
  async function simulate(approve: boolean) {
    if (!cardIntent) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.post<PaymentDto>(`/payments/${cardIntent.paymentId}/simulate`, {
        approve,
      });
      setPayments((prev) => [updated, ...prev.filter((p) => p.id !== updated.id)]);
      setCardIntent(null);

      if (approve) {
        onPaid('Pago aprobado. El trámite queda cubierto.');
        return;
      }

      /**
       * Rechazado: el modal NO se cierra. Cerrarlo dejaba al cliente en el
       * listado sin nada que hacer con un trámite que sigue sin pagar; aqui puede
       * reintentar de una vez. Se recarga la cotización porque el saldo lo manda
       * el servidor y este intento no lo movió.
       */
      setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
      setQuote(await api.get<Quote>(`/payments/quote/${shipment.id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo simular el cobro.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Pagar trámite</h3>
          <p>
            {shipment.code} · {shipment.description}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {notice && <div className="banner ok">{notice}</div>}

          {quote && amounts && (
            <div className="card-sec is-money">
              <div className="card-sec-title">Monto a pagar</div>
              <dl className="card-sec-fields">
                <div className="card-item-field">
                  <span className="field-label">Factura</span>
                  <span>
                    {amounts.invoiceTotal != null
                      ? formatMoney(amounts.invoiceTotal, amounts.currency)
                      : '—'}
                    {/*
                      El equivalente en la otra moneda solo acompaña al cobro en
                      colones. En Paquetería el cobro ES en dólares y ponerle al
                      lado el importe en colones sería exactamente la conversión
                      que no se le enseña al cliente.
                    */}
                    {amounts.currency === Currency.CRC && quote.invoiceTotalUsd != null && (
                      <> · {formatMoney(quote.invoiceTotalUsd, Currency.USD)}</>
                    )}
                  </span>
                </div>
                <div className="card-item-field">
                  <span className="field-label">Abonado</span>
                  <span>{formatMoney(amounts.paid, amounts.currency)}</span>
                </div>
                <div className="card-item-field">
                  <span className="field-label">Saldo</span>
                  <span>
                    <strong>{formatMoney(amounts.due, amounts.currency)}</strong>
                  </span>
                </div>
              </dl>
            </div>
          )}

          {quote?.settled && (
            <div className="banner ok">Este trámite ya está pagado.</div>
          )}

          {/*
            Un abono ya subido y sin resolver. Se dice explícitamente porque el
            saldo de arriba sigue completo —un comprobante sin validar no es
            dinero recibido— y sin este aviso el cliente lee ese saldo como que
            su depósito nunca llegó.

            Si ese abono cubre el saldo, además desaparece todo el formulario: el
            aviso queda como única respuesta, y por eso dice explícitamente que no
            hay que volver a pagar. Verlo junto a un botón de pagar activo es lo
            que hacía que el cliente pagara dos veces.
          */}
          {quote && amounts && !quote.settled && pendingCrc > 0 && (
            <div className="banner">
              Recibimos {formatMoney(amounts.pending, amounts.currency)} y estamos validando el
              comprobante. Te avisaremos apenas quede confirmado.
              {quote.inValidation && <> No hace falta que pagues de nuevo.</>}
            </div>
          )}

          {canPay && quote.availableMethods.length === 0 && (
            <div className="banner warn">
              No hay medios de pago disponibles en este momento. Contáctanos para coordinar.
            </div>
          )}

          {canPay && quote.availableMethods.length > 0 && !cardIntent && (
            <div>
              <span className="field-label">Medio de pago</span>
              {quote.availableMethods.map((m) => (
                <label className="check-row" key={m}>
                  <input
                    type="radio"
                    name="method"
                    checked={method === m}
                    onChange={() => setMethod(m)}
                  />
                  {PAYMENT_METHOD_LABELS[m]}
                </label>
              ))}
            </div>
          )}

          {method === PaymentMethod.DepositoBancario && canPay && (
            <>
              <div className="banner">
                Deposita a nombre de <strong>HS Global Services</strong> y adjunta el
                comprobante. Validaremos el depósito y te avisaremos.
              </div>

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="p-bank">Cuenta</label>
                  <select
                    id="p-bank"
                    className="input"
                    value={bankAccount ?? ''}
                    onChange={(e) => setBankAccount(e.target.value as BankAccount)}
                  >
                    {quote.availableBankAccounts.map((b) => (
                      <option key={b} value={b}>
                        {bankAccountOptionLabel(b)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="p-date">Fecha del depósito</label>
                  <input
                    id="p-date"
                    className="input"
                    type="date"
                    value={depositDate}
                    onChange={(e) => setDepositDate(e.target.value)}
                  />
                </div>
              </div>

              {/*
                Los datos completos de la cuenta elegida. El select ya lleva el
                número, pero el IBAN es lo que se necesita para transferir desde
                otro banco y no cabe en una opción: sin esto el cliente tiene que
                pedirlo por WhatsApp, que es exactamente el problema del ticket.
              */}
              {bankAccount && (
                <div className="card-sec">
                  <div className="card-sec-title">Datos de la cuenta</div>
                  <dl className="card-sec-fields">
                    <div className="card-item-field">
                      <span className="field-label">Titular</span>
                      <span>HS Global Services</span>
                    </div>
                    <div className="card-item-field">
                      <span className="field-label">Banco</span>
                      <span>{BANK_ACCOUNTS[bankAccount].bank}</span>
                    </div>
                    <div className="card-item-field">
                      <span className="field-label">Moneda</span>
                      <span>{CURRENCY_LABELS[BANK_ACCOUNTS[bankAccount].currency]}</span>
                    </div>
                    {BANK_ACCOUNTS[bankAccount].number && (
                      <div className="card-item-field">
                        <span className="field-label">Cuenta</span>
                        <span className="mono">{BANK_ACCOUNTS[bankAccount].number}</span>
                      </div>
                    )}
                    <div className="card-item-field">
                      <span className="field-label">IBAN</span>
                      <span className="mono">{BANK_ACCOUNTS[bankAccount].iban}</span>
                    </div>
                  </dl>
                </div>
              )}

              <div>
                <label className="field-label" htmlFor="p-receipt-no">Número de comprobante</label>
                <input
                  id="p-receipt-no"
                  className="input mono"
                  value={receiptNumber}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                />
              </div>

              <div>
                <label className="field-label" htmlFor="p-receipt">Comprobante (imagen o PDF)</label>
                <input
                  id="p-receipt"
                  className="input"
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                />
              </div>
            </>
          )}

          {method === PaymentMethod.Tarjeta && !cardIntent && canPay && (
            <div className="banner">
              Al continuar abriremos el formulario seguro de pago con tarjeta.
            </div>
          )}

          {/* Cobro ya iniciado: manda la pasarela, el formulario de arriba ya no. */}
          {cardIntent?.intent.simulated && (
            <div className="card-sec">
              <div className="card-sec-title">Pasarela simulada</div>
              <div className="banner warn">
                Modo de pruebas: no se cobra nada real. Elige cómo debe responder la
                pasarela para seguir el flujo.
              </div>
              <div className="modal-foot">
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => simulate(false)}
                >
                  Rechazar cobro
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={saving}
                  onClick={() => simulate(true)}
                >
                  Aprobar cobro
                </button>
              </div>
            </div>
          )}

          {cardIntent && !cardIntent.intent.simulated && (
            <div className="banner">
              Abriendo el formulario seguro de pago con tarjeta. El cobro queda
              confirmado cuando la pasarela nos lo notifique.
              {/* TODO(09/onvo): montar aquí el SDK web con publicKey y paymentIntentId. */}
            </div>
          )}

          {payments.length > 0 && (
            <div className="card-sec">
              <div className="card-sec-title">Pagos registrados</div>
              <dl className="card-sec-fields">
                {payments.map((payment) => (
                  <div className="card-item-field" key={payment.id}>
                    <span className="field-label">
                      {formatDate(payment.createdAt)} · {PAYMENT_METHOD_LABELS[payment.method]}
                    </span>
                    <span>
                      {/*
                        El abono se reexpresa a la moneda en que esta pantalla
                        habla del cobro, y con SU PROPIA tasa congelada (regla
                        M5), que es la misma aritmética de `settledAmount`. Sin
                        esto, el cliente de Paquetería leería "Abonado $48.76"
                        arriba y "₡25.000" aquí abajo: dos cifras para el mismo
                        depósito.
                      */}
                      {formatMoney(
                        convertMoney(
                          payment.amount,
                          payment.currency,
                          currency,
                          payment.exchangeRate,
                        ),
                        currency,
                      )}{' '}
                      —{' '}
                      <span
                        className={
                          payment.status === PaymentStatus.Confirmado ? 'spill ok' : 'spill'
                        }
                      >
                        {PAYMENT_STATUS_LABELS[payment.status]}
                      </span>
                    </span>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          {/*
            Con un cobro ya iniciado el botón desaparece: el pago existe en el
            servidor y volver a enviarlo abriría un segundo cobro por el mismo saldo.
            Con un abono en validación desaparece por la misma razón.
          */}
          {canPay && method && !cardIntent && (
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Registrando…' : 'Registrar pago'}
            </button>
          )}
        </div>
      </form>
    </ModalOverlay>
  );
}
