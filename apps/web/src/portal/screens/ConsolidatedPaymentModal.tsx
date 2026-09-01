/**
 * Pago AGRUPADO de una cuenta consolidada.
 *
 * Es el hermano de `PaymentModal` para las cuentas con tarifa Consolidada: en vez
 * de un trámite, se salda de una sola vez la lista completa de paquetes listos
 * para facturar.
 *
 * LA LISTA NO SE TOCA. No hay casillas, ni botón de quitar, ni total que cambie
 * al elegir: el requerimiento pide que el pago incluya obligatoriamente todos los
 * paquetes listos, así que aquí se muestran para que el cliente sepa qué está
 * pagando, no para que elija. Y el servidor arma el conjunto por su cuenta: esta
 * pantalla no le manda ningún id de trámite, de modo que la restricción no
 * depende de lo que haga el navegador.
 *
 * El resto del flujo es idéntico al pago suelto y por las mismas razones: el
 * depósito queda PENDIENTE hasta que alguien lo valida, y con tarjeta quien dice
 * si se cobró es el webhook, no el SDK — por eso al terminar el formulario se
 * pregunta al servidor en vez de anunciar nada (`waitForResolution`).
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNTS,
  BankAccount,
  CURRENCY_LABELS,
  Currency,
  PAYMENT_METHOD_LABELS,
  PaymentMethod,
  PaymentStatus,
  bankAccountOptionLabel,
  billingAmounts,
  formatMoney,
} from '@courier/shared';
import type {
  ConsolidatedItem,
  ConsolidatedQuoteDto,
  PaymentGroupDto,
  PaymentIntentDto,
} from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { Icon } from '../components/Icon';
import { ModalOverlay } from '../components/ModalOverlay';
import { OnvoCardForm } from '../components/OnvoCardForm';
import type { PaymentResult } from './PaymentResultModal';

/**
 * Espera del desenlace del cobro con tarjeta. El SDK termina antes que el
 * webhook, así que la pantalla pregunta en bucle. Mismos tiempos que el pago
 * suelto: si se agota, el cobro NO se da por perdido ni por hecho.
 */
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_ATTEMPTS = 15;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Props {
  /**
   * Casillero a cobrar. El cliente lo omite (el servidor toma el de su sesión);
   * el staff lo indica desde la ficha del trámite.
   */
  clientId?: string;
  onClose: () => void;
  onPaid: (result: PaymentResult) => void;
  /** El cargo salió y estamos esperando el desenlace (ver `PaymentModal`). */
  onProcessing: (result: PaymentResult | null) => void;
}

export function ConsolidatedPaymentModal({ clientId, onClose, onPaid, onProcessing }: Props) {
  const [quote, setQuote] = useState<ConsolidatedQuoteDto | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [bankAccount, setBankAccount] = useState<BankAccount | null>(null);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cardIntent, setCardIntent] = useState<{ groupId: string; intent: PaymentIntentDto } | null>(
    null,
  );

  const quoteUrl = clientId
    ? `/payments/consolidated/quote?clientId=${encodeURIComponent(clientId)}`
    : '/payments/consolidated/quote';

  /**
   * EL GRUPO SE COBRA EN SU MONEDA, y esta pantalla habla en esa y solo en esa.
   *
   * Un grupo consolidado es siempre de paquetes, y la Paquetería se cobra en
   * dólares (`chargeCurrencyFor`): son la moneda de sus líneas de costo, la de
   * las cuentas a las que se deposita y la cifra contra la que se cancela. La
   * moneda y el importe los decide la API y viajan en la cotización; la pantalla
   * no los deduce, porque el único error que no se puede cometer aquí es
   * anunciar un monto distinto del que se va a cobrar.
   *
   * Y se enseña UNA sola: dos números para la misma deuda obligan al cliente a
   * preguntar con cuál se le va a cobrar.
   */
  const chargeCurrency = quote?.chargeCurrency ?? Currency.CRC;
  const due = quote?.due ?? 0;

  /** Las demás cifras del grupo, proyectadas a esa misma moneda. */
  const amounts = quote ? billingAmounts(quote, chargeCurrency, quote.settled) : null;

  /** El saldo de UN paquete del grupo, en la moneda en que se cobra. */
  const dueOfItem = (item: ConsolidatedItem): number =>
    chargeCurrency === Currency.USD ? item.dueUsd : item.dueCrc;

  /**
   * ¿Se puede pagar ahora mismo? Hace falta que la cuenta sea consolidada, que
   * haya paquetes, que quede saldo y que no haya un abono cubriéndolo ya a la
   * espera de validación. Los cuatro los decide la API.
   */
  const canPay =
    quote != null &&
    quote.consolidated &&
    quote.items.length > 0 &&
    !quote.settled &&
    !quote.inValidation;

  function outcome(kind: PaymentResult['kind'], title: string, message: string): PaymentResult {
    return {
      kind,
      title,
      message,
      code: quote ? `${quote.clientCode} · ${quote.items.length} paquetes` : '',
      amount: formatMoney(due, chargeCurrency),
    };
  }

  useEffect(() => {
    api
      .get<ConsolidatedQuoteDto>(quoteUrl)
      .then((q) => {
        setQuote(q);
        setMethod(q.availableMethods[0] ?? null);
        setBankAccount(q.availableBankAccounts[0] ?? null);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el cobro.'),
      );
  }, [quoteUrl]);

  async function reloadQuote() {
    setQuote(await api.get<ConsolidatedQuoteDto>(quoteUrl));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method) return;
    if (method === PaymentMethod.DepositoBancario && !bankAccount) {
      setError('Elige la cuenta donde hiciste el depósito.');
      return;
    }
    setError(null);
    setSaving(true);

    try {
      /*
        El cuerpo NO lleva ni monto ni lista de paquetes: los dos los resuelve el
        servidor. Es lo que hace que "entran todos" sea una regla del sistema y no
        una promesa de esta pantalla.
      */
      const { group, intent } = await api.post<{
        group: PaymentGroupDto;
        intent: PaymentIntentDto | null;
      }>('/payments/consolidated', {
        method,
        ...(method === PaymentMethod.DepositoBancario
          ? {
              bankAccount,
              ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
              ...(depositDate ? { depositedAt: new Date(depositDate).toISOString() } : {}),
            }
          : {}),
      });

      if (method === PaymentMethod.Tarjeta && intent) {
        setCardIntent({ groupId: group.id, intent });
        setSaving(false);
        return;
      }

      // Un solo comprobante para todo el cobro: el depósito fue uno.
      if (receipt) {
        const form = new FormData();
        form.set('file', receipt);
        const res = await fetch(`${API_BASE}/api/payments/consolidated/${group.id}/receipt`, {
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

      onPaid(
        outcome(
          'pending',
          'Depósito registrado',
          'Validaremos el comprobante y te avisaremos apenas quede confirmado. Mientras tanto los paquetes siguen con saldo abierto.',
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el pago.');
    } finally {
      setSaving(false);
    }
  }

  /** Resuelve el cobro SIMULADO. Solo con la pasarela de pruebas. */
  async function simulate(approve: boolean) {
    if (!cardIntent) return;
    setError(null);
    setSaving(true);
    try {
      await api.post<PaymentGroupDto>(`/payments/consolidated/${cardIntent.groupId}/simulate`, {
        approve,
      });
      setCardIntent(null);

      if (approve) {
        onPaid(
          outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago y todos los paquetes quedan cubiertos.'),
        );
        return;
      }

      setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
      await reloadQuote();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo simular el cobro.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Pregunta por el desenlace a NUESTRA API, que es donde el webhook lo deja.
   * Null si se agotó la espera con el cobro todavía sin resolver.
   */
  async function waitForResolution(groupId: string): Promise<PaymentGroupDto | null> {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const group = await api.get<PaymentGroupDto>(`/payments/consolidated/group/${groupId}`);
      if (group.status !== PaymentStatus.Pendiente) return group;
      await sleep(CONFIRM_POLL_MS);
    }
    return null;
  }

  /** El SDK terminó. Aquí todavía NO se sabe si se cobró: se pregunta al servidor. */
  async function confirmCard() {
    if (!cardIntent) return;
    setError(null);
    setNotice(null);
    setSaving(true);

    onProcessing(
      outcome(
        'processing',
        'Confirmando tu pago…',
        'Estamos esperando la respuesta de la pasarela. No cierres esta ventana.',
      ),
    );

    try {
      // El cargo SALIÓ. No confirma nada y no se deja fallar: si esta llamada se
      // pierde, el cobro lo resuelve igual el webhook.
      await api
        .post(`/payments/consolidated/${cardIntent.groupId}/submitted`, {})
        .catch(() => undefined);

      const resolved = await waitForResolution(cardIntent.groupId);

      if (resolved?.status === PaymentStatus.Confirmado) {
        setCardIntent(null);
        onPaid(
          outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago y todos los paquetes quedan cubiertos.'),
        );
        return;
      }

      if (resolved?.status === PaymentStatus.Rechazado) {
        onProcessing(null);
        setCardIntent(null);
        setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
        await reloadQuote();
        return;
      }

      setCardIntent(null);
      onPaid(
        outcome(
          'pending',
          'Pago enviado',
          'La pasarela todavía está confirmando el cobro. Te avisaremos apenas quede registrado; no hace falta que pagues de nuevo.',
        ),
      );
    } catch (err) {
      onProcessing(null);
      setError(err instanceof ApiError ? err.message : 'No se pudo confirmar el cobro.');
    } finally {
      setSaving(false);
    }
  }

  function cardFailed(message: string) {
    setNotice(null);
    setError(message);
  }

  /**
   * Cierre. Con un cobro con tarjeta a medias hay que soltarlo en el servidor: si
   * no, cuenta como abono en validación y bloquea el siguiente intento. Es
   * best-effort por lo mismo que en el pago suelto.
   */
  async function closeModal() {
    if (cardIntent) {
      await api
        .post(`/payments/consolidated/${cardIntent.groupId}/abandon`, {})
        .catch(() => undefined);
    }
    onClose();
  }

  async function cancelCard() {
    const current = cardIntent;
    if (!current || saving) return;
    setCardIntent(null);
    setError(null);
    setNotice(null);
    await api.post(`/payments/consolidated/${current.groupId}/abandon`, {}).catch(() => undefined);
    await reloadQuote().catch(() => undefined);
  }

  const cardOpen = cardIntent != null;

  const alerts = (
    <>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
    </>
  );

  const summary = quote && quote.consolidated && (
    <div className="pay-sec is-money">
      <div className="card-sec-title">Monto a pagar</div>
      <dl className="pay-fields">
        <div className="card-item-field">
          <dt>Paquetes</dt>
          <dd>{quote.items.length}</dd>
        </div>
        <div className="card-item-field">
          <dt>Facturado</dt>
          <dd>
            {amounts?.invoiceTotal != null
              ? formatMoney(amounts.invoiceTotal, chargeCurrency)
              : '—'}
          </dd>
        </div>
        <div className="card-item-field">
          <dt>Abonado</dt>
          <dd>{formatMoney(amounts?.paid ?? 0, chargeCurrency)}</dd>
        </div>
        <div className="card-item-field">
          <dt>Saldo</dt>
          <dd className="pay-due">{formatMoney(due, chargeCurrency)}</dd>
        </div>
      </dl>
    </div>
  );

  /**
   * Los paquetes del cobro. Solo lectura, y se dice por qué: sin la frase, la
   * lista se lee como una selección a la que le faltan las casillas.
   */
  const itemsBlock = quote && quote.items.length > 0 && (
    <div className="pay-sec">
      <div className="card-sec-title">Paquetes incluidos ({quote.items.length})</div>
      <div className="banner">
        La cuenta es consolidada: el pago cubre <strong>todos</strong> los paquetes listos para
        facturar. No se pueden quitar ni agregar paquetes al cobro.
      </div>
      <dl className="pay-list">
        {quote.items.map((item) => (
          <div className="card-item-field" key={item.shipmentId}>
            <dt>
              {item.code} · {item.description}
              {item.weightKg != null && <> · {item.weightKg} kg</>}
            </dt>
            <dd>
              <strong>{formatMoney(dueOfItem(item), chargeCurrency)}</strong>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <ModalOverlay
      onClose={() => {
        if (cardOpen) return;
        void closeModal();
      }}
    >
      <form
        className="modal modal-lg fadeUp"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <h3>Pago consolidado</h3>
          <p>
            {quote
              ? `${quote.clientCode} · ${quote.clientName}${quote.rateName ? ` · tarifa ${quote.rateName}` : ''}`
              : 'Cargando…'}
          </p>
        </div>

        <div className="modal-body">
          {!cardOpen && alerts}

          {quote && !quote.consolidated && (
            <div className="banner warn">
              Esta cuenta no tiene tarifa consolidada: sus paquetes se pagan por separado.
            </div>
          )}

          {quote?.consolidated && quote.items.length === 0 && (
            <div className="banner">No hay paquetes listos para pagar en esta cuenta.</div>
          )}

          {summary}

          {quote?.settled && <div className="banner ok">Esta cuenta ya está al día.</div>}

          {quote?.consolidated && !quote.settled && (amounts?.pending ?? 0) > 0 && (
            <div className="banner">
              Hay {formatMoney(amounts!.pending, chargeCurrency)} a la espera de validación.
              {quote.inValidation && <> No hace falta que pagues de nuevo.</>}
            </div>
          )}

          {itemsBlock}

          {canPay && quote.availableMethods.length === 0 && (
            <div className="banner warn">
              No hay medios de pago disponibles en este momento. Contáctanos para coordinar.
            </div>
          )}

          {canPay && quote.availableMethods.length > 0 && (
            <div>
              <span className="field-label">Medio de pago</span>
              <div className="pay-methods">
                {quote.availableMethods.map((m) => (
                  <label className={`pay-method${method === m ? ' is-on' : ''}`} key={m}>
                    <input
                      type="radio"
                      name="cmethod"
                      checked={method === m}
                      onChange={() => setMethod(m)}
                    />
                    <Icon name={m === PaymentMethod.Tarjeta ? 'card' : 'file'} size={17} />
                    <span>{PAYMENT_METHOD_LABELS[m]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {method === PaymentMethod.DepositoBancario && canPay && (
            <>
              <div className="banner">
                Deposita a nombre de <strong>HS Global Services</strong> y adjunta el comprobante.
                Un solo depósito por el total: el comprobante queda ligado a los{' '}
                {quote.items.length} paquetes.
              </div>

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="cp-bank">Cuenta</label>
                  <select
                    id="cp-bank"
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
                  <label className="field-label" htmlFor="cp-date">Fecha del depósito</label>
                  <input
                    id="cp-date"
                    className="input"
                    type="date"
                    value={depositDate}
                    onChange={(e) => setDepositDate(e.target.value)}
                  />
                </div>
              </div>

              {bankAccount && (
                <div className="pay-sec">
                  <div className="card-sec-title">Datos de la cuenta</div>
                  <dl className="pay-fields">
                    <div className="card-item-field">
                      <dt>Titular</dt>
                      <dd>HS Global Services</dd>
                    </div>
                    <div className="card-item-field">
                      <dt>Banco</dt>
                      <dd>{BANK_ACCOUNTS[bankAccount].bank}</dd>
                    </div>
                    <div className="card-item-field">
                      <dt>Moneda</dt>
                      <dd>{CURRENCY_LABELS[BANK_ACCOUNTS[bankAccount].currency]}</dd>
                    </div>
                    {BANK_ACCOUNTS[bankAccount].number && (
                      <div className="card-item-field">
                        <dt>Cuenta</dt>
                        <dd className="mono">{BANK_ACCOUNTS[bankAccount].number}</dd>
                      </div>
                    )}
                    <div className="card-item-field">
                      <dt>IBAN</dt>
                      <dd className="mono">{BANK_ACCOUNTS[bankAccount].iban}</dd>
                    </div>
                  </dl>
                </div>
              )}

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="cp-receipt-no">
                    Número de comprobante
                  </label>
                  <input
                    id="cp-receipt-no"
                    className="input mono"
                    value={receiptNumber}
                    onChange={(e) => setReceiptNumber(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="cp-receipt">
                    Comprobante (imagen o PDF)
                  </label>
                  <input
                    id="cp-receipt"
                    className="input"
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                  />
                </div>
              </div>
            </>
          )}

          {method === PaymentMethod.Tarjeta && canPay && (
            <div className="banner">
              Al continuar abriremos el formulario seguro de pago con tarjeta por{' '}
              {formatMoney(due, chargeCurrency)}.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={() => void closeModal()}>
            Cerrar
          </button>
          {canPay && method && !cardOpen && (
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Registrando…' : `Pagar ${formatMoney(due, chargeCurrency)}`}
            </button>
          )}
        </div>
      </form>

      {cardIntent && (
        <ModalOverlay onClose={() => void cancelCard()}>
          <div className="modal modal-pay fadeUp" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head pay-head">
              <div>
                <h3>Pago con tarjeta</h3>
                <p>
                  {quote?.clientCode} · {quote?.items.length} paquetes
                </p>
              </div>
              <div className="pay-head-amount">
                <span>A pagar</span>
                <strong>{formatMoney(due, chargeCurrency)}</strong>
              </div>
            </div>

            <div className="modal-body pay-checkout">
              {alerts}

              {cardIntent.intent.simulated ? (
                <>
                  <div className="banner warn">
                    Modo de pruebas: no se cobra nada real. Elige cómo debe responder la pasarela
                    para seguir el flujo.
                  </div>
                  <div className="pay-sec-actions">
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
                      className="btn btn-primary"
                      disabled={saving}
                      onClick={() => simulate(true)}
                    >
                      Aprobar cobro
                    </button>
                  </div>
                </>
              ) : (
                <OnvoCardForm
                  publicKey={cardIntent.intent.publicKey}
                  paymentIntentId={cardIntent.intent.paymentIntentId}
                  customerId={cardIntent.intent.customerId}
                  onCompleted={confirmCard}
                  onFailed={cardFailed}
                />
              )}
            </div>

            <div className="modal-foot">
              <p className="pay-secure">
                <Icon name="lock" size={15} />
                <span>Pago cifrado de extremo a extremo. No guardamos tu tarjeta.</span>
              </p>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving}
                onClick={() => void cancelCard()}
              >
                Cancelar pago
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </ModalOverlay>
  );
}
