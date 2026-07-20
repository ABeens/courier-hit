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
 * Tarjeta: TODO(09/onvo). La estructura está lista de punta a punta (el servidor
 * crea el intento de cobro y devuelve el `clientSecret`), pero falta montar el
 * SDK de Onvo Pay aquí. Mientras la pasarela esté apagada, la API no ofrece este
 * medio y el bloque no se llega a mostrar.
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNT_LABELS,
  BankAccount,
  Currency,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PaymentMethod,
  PaymentStatus,
  formatMoney,
} from '@courier/shared';
import type { PaymentDto, ShipmentDto } from '@courier/shared';
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
  dueCrc: number;
  settled: boolean;
  availableMethods: PaymentMethod[];
  payableState: boolean;
}

interface Props {
  shipment: ShipmentDto;
  onClose: () => void;
  onPaid: () => void;
}

export function PaymentModal({ shipment, onClose, onPaid }: Props) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [payments, setPayments] = useState<PaymentDto[]>([]);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [bankAccount, setBankAccount] = useState<BankAccount>(BankAccount.BAC);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Quote>(`/payments/quote/${shipment.id}`),
      api.get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`),
    ])
      .then(([q, list]) => {
        setQuote(q);
        setPayments(list.items);
        setMethod(q.availableMethods[0] ?? null);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar el pago.'),
      );
  }, [shipment.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method) return;
    setError(null);
    setSaving(true);

    try {
      const { payment } = await api.post<{ payment: PaymentDto }>('/payments', {
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

      setNotice(
        'Registramos tu depósito. Queda pendiente de validación por nuestro equipo.',
      );
      onPaid();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el pago.');
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

          {quote && (
            <div className="card-sec is-money">
              <div className="card-sec-title">Monto a pagar</div>
              <dl className="card-sec-fields">
                <div className="card-item-field">
                  <span className="field-label">Factura</span>
                  <span>
                    {quote.invoiceTotalCrc != null
                      ? formatMoney(quote.invoiceTotalCrc, Currency.CRC)
                      : '—'}
                    {quote.invoiceTotalUsd != null && (
                      <> · {formatMoney(quote.invoiceTotalUsd, Currency.USD)}</>
                    )}
                  </span>
                </div>
                <div className="card-item-field">
                  <span className="field-label">Abonado</span>
                  <span>{formatMoney(quote.settledCrc, Currency.CRC)}</span>
                </div>
                <div className="card-item-field">
                  <span className="field-label">Saldo</span>
                  <span>
                    <strong>{formatMoney(quote.dueCrc, Currency.CRC)}</strong>
                  </span>
                </div>
              </dl>
            </div>
          )}

          {quote?.settled && (
            <div className="banner ok">Este trámite ya está pagado.</div>
          )}

          {quote && !quote.settled && quote.availableMethods.length === 0 && (
            <div className="banner warn">
              No hay medios de pago disponibles en este momento. Contáctanos para coordinar.
            </div>
          )}

          {quote && !quote.settled && quote.availableMethods.length > 0 && (
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

          {method === PaymentMethod.DepositoBancario && quote && !quote.settled && (
            <>
              <div className="banner">
                Deposita a nombre de <strong>HS Global Courier</strong> y adjunta el
                comprobante. Validaremos el depósito y te avisaremos.
              </div>

              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="p-bank">Cuenta</label>
                  <select
                    id="p-bank"
                    className="input"
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value as BankAccount)}
                  >
                    {Object.values(BankAccount).map((b) => (
                      <option key={b} value={b}>
                        {BANK_ACCOUNT_LABELS[b]}
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

          {method === PaymentMethod.Tarjeta && (
            <div className="banner">
              Al continuar abriremos el formulario seguro de pago con tarjeta.
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
                      {formatMoney(payment.amount, payment.currency)} —{' '}
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
          {quote && !quote.settled && method && (
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Registrando…' : 'Registrar pago'}
            </button>
          )}
        </div>
      </form>
    </ModalOverlay>
  );
}
