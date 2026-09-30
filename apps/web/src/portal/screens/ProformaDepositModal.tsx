/**
 * El STAFF registra el deposito que el cliente hizo por una proforma aprobada.
 *
 * El monto NO se digita: es el saldo de la proforma completa (no hay pago
 * parcial, regla 6 del SOW) y lo pone la API. Con que situacion nace lo decide el
 * permiso: el Operativo lo deja en validacion y el Administrador, confirmado
 * (`recordedPaymentStatus`, la misma funcion que usa el servidor).
 *
 * Reemplaza al registro de deposito por tramite y al del cobro consolidado: con
 * el modulo de proformas todo se cobra por proforma.
 */
import { useEffect, useState } from 'react';
import {
  PROOF_ATTACHMENT,
  PaymentStatus,
  attachmentRejection,
  bankAccountOptionLabel,
  bankAccountsForStaff,
  canSetExchangeRate,
  formatMoney,
  recordedPaymentStatus,
} from '@courier/shared';
import type { BankAccount, PaymentGroupDto, ProformaDetailDto, ProformaPaymentQuoteDto, Role } from '@courier/shared';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import { ApiError, api } from '../lib/api';
import { startOfLocalDayUtc } from '../lib/datetime';
import { useErrorToast } from '../lib/toast';
import { ProformaLink } from '../components/ProformaLink';

/** Hoy en formato `yyyy-mm-dd`, para precargar la fecha del deposito. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

interface Props {
  proforma: ProformaDetailDto;
  role: Role;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ProformaDepositModal({ proforma, role, onClose, onSaved }: Props) {
  const [quote, setQuote] = useState<ProformaPaymentQuoteDto | null>(null);
  const [bankAccount, setBankAccount] = useState<BankAccount>(bankAccountsForStaff()[0]!);
  const [exchangeRate, setExchangeRate] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState(today());
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const setError = useErrorToast();
  const [saving, setSaving] = useState(false);

  const bornAs = recordedPaymentStatus(role);

  useEffect(() => {
    api
      .get<ProformaPaymentQuoteDto>(`/payments/proformas/quote?ids=${proforma.id}&clientId=${proforma.client.id}`)
      .then(setQuote)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudo cotizar la proforma.'));
  }, [proforma.id, proforma.client.id]);

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
    if (bornAs !== PaymentStatus.Confirmado && !receipt) {
      setError('Adjunta el comprobante que envió el cliente.');
      return;
    }
    setSaving(true);
    try {
      const group = await api.post<PaymentGroupDto>('/payments/proformas/record', {
        clientId: proforma.client.id,
        proformaIds: [proforma.id],
        bankAccount,
        receiptNumber: receiptNumber.trim(),
        depositedAt: startOfLocalDayUtc(depositDate),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(canSetExchangeRate(role) && exchangeRate.trim() ? { exchangeRate: Number(exchangeRate) } : {}),
      });
      if (receipt) {
        try {
          await api.upload(`/payments/groups/${group.id}/receipt`, receipt);
        } catch (err) {
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
        group.status === PaymentStatus.Confirmado
          ? `Depósito registrado y confirmado (${formatMoney(group.amount, group.currency)}). La proforma quedó pagada.`
          : `Depósito registrado (${formatMoney(group.amount, group.currency)}). Queda en validación por el administrador.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el depósito.');
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Registrar depósito</h3>
          <p>
            Proforma {proforma.number ? <ProformaLink id={proforma.id} number={proforma.number} /> : null} · {proforma.client.name}
          </p>
        </div>

        <div className="modal-body">

          <div className="pay-sec is-money">
            <dl className="pay-fields">
              <div className="card-item-field">
                <dt>Saldo de la proforma</dt>
                <dd className="pay-due">{quote ? formatMoney(quote.due, quote.chargeCurrency) : '…'}</dd>
              </div>
            </dl>
            <div className="field-hint">
              La proforma se paga completa: el depósito se registra por el saldo entero.
            </div>
          </div>

          <div className="banner">
            {bornAs === PaymentStatus.Confirmado ? (
              <>El depósito quedará <strong>confirmado</strong> y la proforma, pagada.</>
            ) : (
              <>El depósito quedará <strong>en validación</strong> hasta que el administrador apruebe el comprobante.</>
            )}
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="pdp-account">Cuenta donde entró</label>
              <select
                id="pdp-account" className="input" value={bankAccount} disabled={saving}
                onChange={(e) => setBankAccount(e.target.value as BankAccount)}
              >
                {bankAccountsForStaff().map((account) => (
                  <option key={account} value={account}>{bankAccountOptionLabel(account)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="pdp-date">Fecha del depósito</label>
              <input
                id="pdp-date" className="input" type="date" value={depositDate} disabled={saving}
                onChange={(e) => setDepositDate(e.target.value)}
              />
            </div>
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="pdp-receipt-no">Número de comprobante</label>
              <input
                id="pdp-receipt-no" className="input mono" value={receiptNumber} disabled={saving}
                onChange={(e) => setReceiptNumber(e.target.value)}
              />
            </div>
            {canSetExchangeRate(role) && (
              <div>
                <label className="field-label" htmlFor="pdp-rate">Tasa de cambio (opcional)</label>
                <input
                  id="pdp-rate" className="input" type="number" min="0.0001" max="10000" step="any"
                  placeholder="La de la factura" value={exchangeRate} disabled={saving}
                  onChange={(e) => setExchangeRate(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className="field-pair">
            <FileField
              id="pdp-receipt"
              label={bornAs === PaymentStatus.Confirmado ? 'Comprobante (opcional)' : 'Comprobante'}
              accept={PROOF_ATTACHMENT.accept}
              file={receipt}
              onPick={pickReceipt}
              disabled={saving}
              hint={`El respaldo que envió el cliente. Se aceptan ${PROOF_ATTACHMENT.label}.`}
            />
            <div>
              <label className="field-label" htmlFor="pdp-note">Nota (opcional)</label>
              <input id="pdp-note" className="input" value={note} disabled={saving} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !quote || quote.due <= 0}>
            {saving ? 'Registrando…' : 'Registrar depósito'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
