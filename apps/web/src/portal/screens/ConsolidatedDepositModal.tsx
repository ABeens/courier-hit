/**
 * Registro por el STAFF del depósito AGRUPADO de una cuenta consolidada.
 *
 * Es el hermano del formulario de `ShipmentPaymentsModal` para las cuentas que se
 * cobran juntas, y se diferencia en dos cosas, las dos del requerimiento:
 *
 * 1. NO SE ELIGEN PAQUETES. La lista es informativa: el pago incluye
 *    obligatoriamente todos los que están listos para facturar. Esta pantalla no
 *    manda ningún id de trámite, así que la regla no depende del navegador.
 * 2. NO SE DIGITA EL MONTO. Un depósito consolidado salda la cuenta entera, así
 *    que el importe es el saldo del grupo y lo pone el servidor. Un depósito por
 *    otra cifra se registra contra su paquete por la vía de siempre, cambiándole
 *    antes la tarifa al casillero si hace falta.
 *
 * Con qué situación nace el cobro lo decide el servidor según el permiso de quien
 * firma (`recordedPaymentStatus`); aquí se usa la misma función solo para
 * anunciarlo antes de enviar.
 */
import { useState } from 'react';
import {
  BANK_ACCOUNTS,
  Currency,
  PAYMENT_STATUS_LABELS,
  PROOF_ATTACHMENT,
  PaymentStatus,
  attachmentRejection,
  bankAccountOptionLabel,
  bankAccountsForStaff,
  billingAmounts,
  canSetExchangeRate,
  formatMoney,
  recordedPaymentStatus,
} from '@courier/shared';
import type {
  BankAccount,
  ConsolidatedItem,
  ConsolidatedQuoteDto,
  PaymentGroupDto,
  Role,
} from '@courier/shared';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import { API_BASE, ApiError, api } from '../lib/api';
import { startOfLocalDayUtc } from '../lib/datetime';

/** Hoy en formato `yyyy-mm-dd`, para precargar la fecha del depósito. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

interface Props {
  /** La cuenta ya cotizada por la API: paquetes, saldo y medios de pago. */
  quote: ConsolidatedQuoteDto;
  role: Role;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ConsolidatedDepositModal({ quote, role, onClose, onSaved }: Props) {
  const [bankAccount, setBankAccount] = useState<BankAccount>(bankAccountsForStaff()[0]!);
  const [exchangeRate, setExchangeRate] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState(today());
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Con qué situación va a nacer el cobro. Sale de la MISMA función que aplica el
   * servidor: prometerle al operario un abono confirmado que el sistema deja en
   * validación es exactamente la contradicción que esto evita.
   */
  const bornAs = recordedPaymentStatus(role);
  const [receiptFieldRequired] = useState(bornAs !== PaymentStatus.Confirmado);

  /**
   * LAS CIFRAS VAN EN LA MONEDA EN QUE SE COBRA EL GRUPO, que la decide la API
   * (`chargeCurrencyFor`: un grupo es siempre de paquetes, así que dólares).
   *
   * No es una preferencia de formato: los abonos que este formulario crea nacen
   * en esa moneda, y el depósito entró a una cuenta de esa moneda. Enseñarle al
   * operario un saldo en colones para que lo coteje contra un comprobante en
   * dólares es pedirle que convierta de cabeza el dato que está validando.
   */
  const chargeCurrency = quote.chargeCurrency;
  const amounts = billingAmounts(quote, chargeCurrency, quote.settled);
  const dueOfItem = (item: ConsolidatedItem): number =>
    chargeCurrency === Currency.USD ? item.dueUsd : item.dueCrc;

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!receiptNumber.trim()) {
      setError('Indica el número de comprobante.');
      return;
    }
    if (!depositDate) {
      setError('Indica la fecha del depósito.');
      return;
    }
    // Quien no puede aprobar TIENE que adjuntar el respaldo: sin él, el
    // administrador se encuentra un cobro que no puede validar contra nada.
    if (receiptFieldRequired && !receipt) {
      setError('Adjunta el comprobante que envió el cliente.');
      return;
    }

    setSaving(true);
    try {
      /*
        Sin `amount`: el importe es el saldo del grupo y lo pone el servidor. Sin
        lista de trámites: entran todos los que estén listos.
      */
      const group = await api.post<PaymentGroupDto>('/payments/consolidated/record', {
        clientId: quote.clientId,
        bankAccount,
        receiptNumber: receiptNumber.trim(),
        depositedAt: startOfLocalDayUtc(depositDate),
        ...(note.trim() ? { note: note.trim() } : {}),
        // La tasa solo la manda quien puede fijarla, y solo si la escribió; en
        // cualquier otro caso el servidor congela la de cada factura (regla M5).
        ...(canSetExchangeRate(role) && exchangeRate.trim()
          ? { exchangeRate: Number(exchangeRate) }
          : {}),
      });

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

      onSaved(
        bornAs === PaymentStatus.Confirmado
          ? `Cobro consolidado registrado y confirmado: ${group.itemCount} paquetes por ${formatMoney(group.amount, group.currency)}.`
          : `Cobro consolidado registrado (${group.itemCount} paquetes). Queda en validación.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el depósito.');
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={() => !saving && onClose()}>
      <form
        className="modal modal-wide fadeUp"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <h3>Depósito consolidado</h3>
          <p>
            {quote.clientCode} · {quote.clientName} · tarifa {quote.rateName}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}

          <div className="banner">
            El cobro incluye <strong>todos</strong> los paquetes listos para facturar de esta
            cuenta. No se pueden quitar ni agregar paquetes, y el importe es el saldo completo.
          </div>

          <div className="pay-sec is-money">
            <div className="card-sec-title">Cobro de la cuenta</div>
            <dl className="pay-fields">
              <div className="card-item-field">
                <dt>Paquetes</dt>
                <dd>{quote.items.length}</dd>
              </div>
              <div className="card-item-field">
                <dt>Facturado</dt>
                <dd>
                  {amounts.invoiceTotal != null
                    ? formatMoney(amounts.invoiceTotal, chargeCurrency)
                    : '—'}
                </dd>
              </div>
              <div className="card-item-field">
                <dt>Confirmado</dt>
                <dd>{formatMoney(amounts.paid, chargeCurrency)}</dd>
              </div>
              <div className="card-item-field">
                <dt>Saldo a cobrar</dt>
                <dd className="pay-due">{formatMoney(quote.due, chargeCurrency)}</dd>
              </div>
            </dl>
          </div>

          <div className="pay-sec">
            <div className="card-sec-title">Paquetes incluidos ({quote.items.length})</div>
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

          <div className="pay-sec">
            <div className="card-sec-title">Datos del depósito</div>

            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="cd-bank">Cuenta donde entró</label>
                <select
                  id="cd-bank"
                  className="input"
                  value={bankAccount}
                  disabled={saving}
                  onChange={(e) => setBankAccount(e.target.value as BankAccount)}
                >
                  {bankAccountsForStaff().map((b) => (
                    <option key={b} value={b}>
                      {bankAccountOptionLabel(b)}
                    </option>
                  ))}
                </select>
                <div className="field-hint">{BANK_ACCOUNTS[bankAccount].iban}</div>
              </div>
              <div>
                <label className="field-label" htmlFor="cd-date">Fecha del depósito</label>
                <input
                  id="cd-date"
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
                <label className="field-label" htmlFor="cd-receipt-no">Número de comprobante</label>
                <input
                  id="cd-receipt-no"
                  className="input mono"
                  value={receiptNumber}
                  disabled={saving}
                  onChange={(e) => setReceiptNumber(e.target.value)}
                />
              </div>
              {/*
                La tasa es un valor general del sistema: solo la digita quien puede
                fijarla. Para el resto la congela el servidor con la de cada
                factura, que es la que cuadra el abono con lo cobrado (regla M5).
              */}
              {canSetExchangeRate(role) && (
                <div>
                  <label className="field-label" htmlFor="cd-rate">
                    Tasa de cambio (opcional)
                  </label>
                  <input
                    id="cd-rate"
                    className="input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={exchangeRate}
                    disabled={saving}
                    onChange={(e) => setExchangeRate(e.target.value)}
                  />
                  <div className="field-hint">
                    Sin valor se usa la de las facturas de cada paquete.
                  </div>
                </div>
              )}
            </div>

            <div className="field-pair">
              <FileField
                id="cd-receipt"
                label={receiptFieldRequired ? 'Comprobante' : 'Comprobante (opcional)'}
                accept={PROOF_ATTACHMENT.accept}
                file={receipt}
                onPick={pickReceipt}
                disabled={saving}
                hint={`Un solo respaldo para todo el cobro. Se aceptan ${PROOF_ATTACHMENT.label}.`}
              />

              <div>
                <label className="field-label" htmlFor="cd-note">Nota (opcional)</label>
                <input
                  id="cd-note"
                  className="input"
                  value={note}
                  disabled={saving}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>

            <div className="field-hint">
              El cobro quedará como <strong>{PAYMENT_STATUS_LABELS[bornAs]}</strong>.
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || quote.items.length === 0}
          >
            {saving
              ? 'Registrando…'
              : `Registrar ${formatMoney(quote.due, chargeCurrency)}`}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
