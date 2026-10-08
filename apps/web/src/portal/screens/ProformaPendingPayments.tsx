/**
 * Pagos de una proforma que esperan validacion, dentro de su detalle.
 *
 * Aqui es donde el administrador (`payments.validate`) aprueba o rechaza un
 * deposito: el cobro se registra por proforma completa, asi que se valida en el
 * mismo sitio. Se muestra el COBRO entero (total, proformas que cubre,
 * comprobante), porque eso es lo que hay que contrastar contra el comprobante, y
 * al aprobarlo quedan pagadas todas las proformas que cubre, no solo esta.
 *
 * El Operativo ve la seccion sin los botones: le sirve para no registrar el
 * mismo deposito dos veces. La API aplica la misma regla.
 */
import { useEffect, useState } from 'react';
import {
  BANK_ACCOUNT_LABELS,
  PAYMENT_METHOD_LABELS,
  PROOF_ATTACHMENT,
  Permission,
  attachmentRejection,
  can,
  formatMoney,
} from '@courier/shared';
import type { PendingProformaPaymentDto, Role } from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { formatDate, formatStamp } from '../lib/datetime';
import { useErrorToast } from '../lib/toast';

interface Props {
  proformaId: string;
  /** Numero formateado de ESTA proforma, para distinguirla en la lista del cobro. */
  proformaNumber: string | null;
  role: Role;
  /** Avisa lo que cambio (para recargar la proforma) con el mensaje a mostrar. */
  onResolved: (message: string, ok: boolean) => void;
  /** Avisa si hay algo en validacion: el detalle esconde "Registrar deposito". */
  onLoaded?: (pending: boolean) => void;
}

/** "la proforma 12" o "las proformas 12 y 15". */
function proformasPhrase(numbers: readonly string[]): string {
  if (numbers.length === 1) return `la proforma ${numbers[0]}`;
  const head = numbers.slice(0, -1).join(', ');
  return `las proformas ${head} y ${numbers[numbers.length - 1]}`;
}

export function ProformaPendingPayments({ proformaId, proformaNumber, role, onResolved, onLoaded }: Props) {
  const canValidate = can(role, Permission.PaymentsValidate);
  const setError = useErrorToast();
  const [items, setItems] = useState<PendingProformaPaymentDto[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  async function reload() {
    try {
      const list = await api.get<{ items: PendingProformaPaymentDto[] }>(`/payments/proformas/${proformaId}/pending`);
      setItems(list.items);
      onLoaded?.(list.items.length > 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los pagos en validación.');
    }
  }

  useEffect(() => {
    void reload();
  }, [proformaId]);

  /** Llave de cada pago: el cobro, o el abono si es suelto. */
  const keyOf = (p: PendingProformaPaymentDto) => p.groupId ?? p.paymentId;

  async function resolve(item: PendingProformaPaymentDto, confirm: boolean) {
    const note = rejectNote.trim();
    if (!confirm && !note) {
      setError('Indica por qué se rechaza el pago.');
      return;
    }
    if (confirm) {
      const others = item.proformaNumbers.filter((n) => n !== proformaNumber);
      const scope =
        others.length > 0
          ? `\n\nEste depósito cubre ${proformasPhrase(item.proformaNumbers)}: al aprobarlo quedan pagadas todas.`
          : '';
      const total = formatMoney(item.amount, item.currency);
      if (!window.confirm(`Se dará por recibido el pago de ${total}.${scope}\n\n¿Continuar?`)) return;
    }
    setError(null);
    setSaving(true);
    try {
      const body = { confirm, ...(note ? { note } : {}) };
      if (item.groupId) await api.post(`/payments/groups/${item.groupId}/resolve`, body);
      else await api.post(`/payments/${item.paymentId}/resolve`, body);
      setRejecting(null);
      setRejectNote('');
      await reload();
      onResolved(
        confirm
          ? `Pago aprobado. ${item.proformaNumbers.length > 1 ? 'Las proformas cubiertas quedan pagadas.' : 'La proforma queda pagada.'}`
          : 'Pago rechazado. La proforma conserva su saldo.',
        confirm,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo resolver el pago.');
    } finally {
      setSaving(false);
    }
  }

  /** Sube el comprobante que falta: uno para todo el cobro. */
  async function attach(item: PendingProformaPaymentDto, file: File) {
    const rejection = attachmentRejection(PROOF_ATTACHMENT, file.type, file.name);
    if (rejection) {
      setError(rejection);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const path = item.groupId ? `/payments/groups/${item.groupId}/receipt` : `/payments/${item.paymentId}/receipt`;
      await api.upload(path, file);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo subir el comprobante.');
    } finally {
      setSaving(false);
    }
  }

  if (!items || items.length === 0) return null;

  return (
    <div className="pay-sec">
      <div className="card-sec-title">Pago en validación</div>
      <div className="pay-rows">
        {items.map((item) => (
          <div className="pay-row" key={keyOf(item)}>
            <div className="pay-row-head">
              <div className="pay-row-sum">
                <span className="pay-row-amount">{formatMoney(item.amount, item.currency)}</span>
                <span className="spill warn">En validación</span>
              </div>
              <div className="pay-row-meta">
                {formatDate(item.depositedAt ?? item.createdAt)} · {PAYMENT_METHOD_LABELS[item.method]}
                {item.bankAccount && <> · {BANK_ACCOUNT_LABELS[item.bankAccount]}</>}
              </div>
            </div>

            {/* Lo que cubre el cobro. Si son varias proformas se dice siempre:
                aprobar aqui tambien paga las otras. */}
            {item.proformaNumbers.length > 1 && (
              <div className="banner warn">
                Este depósito cubre {proformasPhrase(item.proformaNumbers)} ({item.shipmentCount} trámites). Se
                aprueba o se rechaza completo.
              </div>
            )}

            <dl className="pay-row-fields">
              <div className="card-item-field">
                <dt>Registró</dt>
                <dd>
                  {item.createdByName ?? 'El cliente'} · {formatStamp(item.createdAt)}
                  {item.receiptNumber && (
                    <>
                      {' '}
                      · comprobante <span className="mono">{item.receiptNumber}</span>
                    </>
                  )}
                </dd>
              </div>
              {item.note && (
                <div className="card-item-field">
                  <dt>Nota</dt>
                  <dd>{item.note}</dd>
                </div>
              )}
            </dl>

            <dl className="pay-row-proof">
              <div className="card-item-field">
                <dt>Comprobante</dt>
                <dd>
                  {item.hasReceipt ? (
                    <a
                      className="btn btn-link"
                      href={`${API_BASE}/api/payments/${item.paymentId}/receipt`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver comprobante
                    </a>
                  ) : (
                    <label className="btn btn-link">
                      Adjuntar
                      <input
                        type="file"
                        accept={PROOF_ATTACHMENT.accept}
                        style={{ display: 'none' }}
                        disabled={saving}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void attach(item, file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                </dd>
              </div>
            </dl>

            {canValidate ? (
              <div className="pay-row-actions">
                {rejecting === keyOf(item) ? (
                  <>
                    <input
                      className="input"
                      placeholder="Motivo del rechazo"
                      value={rejectNote}
                      onChange={(e) => setRejectNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        void resolve(item, false);
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
                      onClick={() => void resolve(item, false)}
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
                      onClick={() => setRejecting(keyOf(item))}
                    >
                      Rechazar
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={saving}
                      onClick={() => void resolve(item, true)}
                    >
                      Aprobar pago
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="field-hint">El administrador valida este pago.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
