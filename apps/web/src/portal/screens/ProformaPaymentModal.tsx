/**
 * Pago de PROFORMAS desde el portal del cliente (objetivos 16 y 17 del SOW).
 *
 * El cliente elige cuales de sus proformas aprobadas paga y las paga completas en
 * un solo cobro, con tarjeta o con deposito (decisiones D2, P1 y P17). Tres reglas
 * que se ven en pantalla:
 *
 *   - PROFORMAS COMPLETAS: no hay monto que digitar; el saldo lo pone la API.
 *   - UNA MONEDA POR COBRO: las proformas en dolares y las en colones se pagan
 *     por separado. Marcar una de la otra moneda cambia la seleccion entera, y la
 *     pantalla dice por que quito las que estaban marcadas.
 *   - LA COMISION DE LA TARJETA SE DICE ANTES DE PAGAR, con las tres cifras
 *     (saldo, comision y total), y solo si se elige tarjeta.
 *
 * Reemplaza al pago tramite por tramite y al pago consolidado.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  BANK_ACCOUNTS,
  CURRENCY_LABELS,
  Currency,
  FLOW_LABELS,
  PAYMENT_METHOD_LABELS,
  PROOF_ATTACHMENT,
  PaymentMethod,
  PaymentStatus,
  attachmentRejection,
  bankAccountOptionLabel,
  formatMoney,
} from '@courier/shared';
import type {
  BankAccount,
  PaymentGroupDto,
  PaymentIntentDto,
  ProformaPaymentItem,
  ProformaPaymentQuoteDto,
} from '@courier/shared';
import { API_BASE, ApiError, api } from '../lib/api';
import { FileField } from '../components/FileField';
import { Icon } from '../components/Icon';
import { ModalOverlay } from '../components/ModalOverlay';
import { OnvoCardForm } from '../components/OnvoCardForm';
import type { PaymentResult } from './PaymentResultModal';
import { useErrorToast } from '../lib/toast';

const CONFIRM_POLL_MS = 2_000;
const CONFIRM_ATTEMPTS = 15;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Props {
  onClose: () => void;
  onPaid: (result: PaymentResult) => void;
  onProcessing: (result: PaymentResult | null) => void;
}

/** La moneda en plural, para el aviso de "se pagan por separado". */
const CURRENCY_NAMES: Record<Currency, string> = {
  [Currency.USD]: 'dólares',
  [Currency.CRC]: 'colones',
};

export function ProformaPaymentModal({ onClose, onPaid, onProcessing }: Props) {
  const [open, setOpen] = useState<ProformaPaymentItem[] | null>(null);
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quote, setQuote] = useState<ProformaPaymentQuoteDto | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [bankAccount, setBankAccount] = useState<BankAccount | null>(null);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [depositDate, setDepositDate] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const setError = useErrorToast();
  const [notice, setNotice] = useState<string | null>(null);
  /** Por que se quitaron proformas de la seleccion al cambiar de moneda. */
  const [currencyNotice, setCurrencyNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [cardIntent, setCardIntent] = useState<{ groupId: string; intent: PaymentIntentDto } | null>(null);

  /** Las proformas por cobrar. Se marcan de entrada todas las de la primera moneda. */
  async function loadOpen() {
    const { items } = await api.get<{ items: ProformaPaymentItem[] }>('/payments/proformas/open');
    const payable = items.filter((i) => i.due > 0 && !i.inValidation);
    setOpen(items);
    const first = payable[0]?.currency ?? null;
    setCurrency(first);
    setSelected(new Set(payable.filter((i) => i.currency === first).map((i) => i.proformaId)));
  }

  useEffect(() => {
    loadOpen().catch((err) =>
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar tus proformas.'),
    );
  }, []);

  const ids = useMemo(() => [...selected].sort(), [selected]);

  /** Cotizacion de lo marcado: saldo, comision de tarjeta y medios disponibles. */
  useEffect(() => {
    if (ids.length === 0) {
      setQuote(null);
      return;
    }
    let alive = true;
    api
      .get<ProformaPaymentQuoteDto>(`/payments/proformas/quote?ids=${ids.join(',')}`)
      .then((q) => {
        if (!alive) return;
        setQuote(q);
        setMethod((m) => (m && q.availableMethods.includes(m) ? m : (q.availableMethods[0] ?? null)));
        setBankAccount((b) => (b && q.availableBankAccounts.includes(b) ? b : (q.availableBankAccounts[0] ?? null)));
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'No se pudo cotizar el pago.'));
    return () => {
      alive = false;
    };
  }, [ids]);

  const chargeCurrency = quote?.chargeCurrency ?? currency ?? Currency.USD;
  const due = quote?.due ?? 0;
  const cardCharge = quote?.cardCharge ?? null;
  const payable = method === PaymentMethod.Tarjeta && cardCharge ? cardCharge.total : due;
  const canPay = quote != null && due > 0 && !quote.inValidation && method != null;

  function toggle(item: ProformaPaymentItem) {
    // Una moneda por cobro: marcar una de la otra moneda cambia la seleccion entera.
    if (item.currency !== currency) {
      const dropped = (open ?? []).filter((i) => selected.has(i.proformaId)).map((i) => i.number);
      setCurrency(item.currency);
      setSelected(new Set([item.proformaId]));
      setCurrencyNotice(
        dropped.length === 0
          ? null
          : `Las proformas en ${CURRENCY_NAMES[item.currency]} se pagan por separado de las de ${CURRENCY_NAMES[currency ?? item.currency]}. ` +
              `Quitamos de este pago ${dropped.length === 1 ? 'la proforma' : 'las proformas'} ${dropped.join(', ')}; ` +
              'puedes pagarlas después en otro pago.',
      );
      return;
    }
    setCurrencyNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.proformaId)) next.delete(item.proformaId);
      else next.add(item.proformaId);
      return next;
    });
  }

  function outcome(kind: PaymentResult['kind'], title: string, message: string): PaymentResult {
    const numbers = (quote?.items ?? []).map((i) => i.number).join(', ');
    return { kind, title, message, code: `Proformas ${numbers}`, amount: formatMoney(payable, chargeCurrency) };
  }

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
    setReceipt(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!method || ids.length === 0) return;
    if (method === PaymentMethod.DepositoBancario && !bankAccount) {
      setError('Elige la cuenta donde hiciste el depósito.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const { group, intent } = await api.post<{ group: PaymentGroupDto; intent: PaymentIntentDto | null }>(
        '/payments/proformas',
        {
          proformaIds: ids,
          method,
          ...(method === PaymentMethod.DepositoBancario
            ? {
                bankAccount,
                ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
                ...(depositDate ? { depositedAt: new Date(depositDate).toISOString() } : {}),
              }
            : {}),
        },
      );

      if (method === PaymentMethod.Tarjeta && intent) {
        setCardIntent({ groupId: group.id, intent });
        setSaving(false);
        return;
      }

      if (receipt) {
        const form = new FormData();
        form.set('file', receipt);
        const res = await fetch(`${API_BASE}/api/payments/groups/${group.id}/receipt`, {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'No se pudo subir el comprobante.');
        }
      }

      onPaid(
        outcome(
          'pending',
          'Depósito registrado',
          'Validaremos el comprobante. Cuando quede confirmado lo verás en tu cuenta.',
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar el pago.');
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    await loadOpen().catch(() => undefined);
  }

  async function simulate(approve: boolean) {
    if (!cardIntent) return;
    setError(null);
    setSaving(true);
    try {
      await api.post<PaymentGroupDto>(`/payments/groups/${cardIntent.groupId}/simulate`, { approve });
      setCardIntent(null);
      if (approve) {
        onPaid(outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago: tus proformas quedan pagadas.'));
        return;
      }
      setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo simular el cobro.');
    } finally {
      setSaving(false);
    }
  }

  async function waitForResolution(groupId: string): Promise<PaymentGroupDto | null> {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const group = await api.get<PaymentGroupDto>(`/payments/groups/${groupId}`);
      if (group.status !== PaymentStatus.Pendiente) return group;
      await sleep(CONFIRM_POLL_MS);
    }
    return null;
  }

  async function confirmCard() {
    if (!cardIntent) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    onProcessing(outcome('processing', 'Confirmando tu pago…', 'Estamos esperando la respuesta de la pasarela. No cierres esta ventana.'));
    try {
      await api.post(`/payments/groups/${cardIntent.groupId}/submitted`, {}).catch(() => undefined);
      const resolved = await waitForResolution(cardIntent.groupId);
      if (resolved?.status === PaymentStatus.Confirmado) {
        setCardIntent(null);
        onPaid(outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago: tus proformas quedan pagadas.'));
        return;
      }
      if (resolved?.status === PaymentStatus.Rechazado) {
        onProcessing(null);
        setCardIntent(null);
        setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
        await reload();
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

  async function closeModal() {
    if (cardIntent) {
      await api.post(`/payments/groups/${cardIntent.groupId}/abandon`, {}).catch(() => undefined);
    }
    onClose();
  }

  async function cancelCard() {
    const current = cardIntent;
    if (!current || saving) return;
    setCardIntent(null);
    setError(null);
    setNotice(null);
    await api.post(`/payments/groups/${current.groupId}/abandon`, {}).catch(() => undefined);
    await reload();
  }

  const cardOpen = cardIntent != null;
  const alerts = (
    <>
      {notice && <div className="banner ok">{notice}</div>}
    </>
  );

  return (
    <ModalOverlay
      onClose={() => {
        if (cardOpen) return;
        void closeModal();
      }}
    >
      <form className="modal modal-lg fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Pagar proformas</h3>
          <p>Elige las proformas que vas a pagar. Cada una se paga completa.</p>
        </div>

        <div className="modal-body">
          {!cardOpen && alerts}

          {open && open.length === 0 && <div className="banner">No tienes proformas pendientes de pago.</div>}

          {open && open.length > 0 && (
            <div className="pay-sec">
              <div className="card-sec-title">Tus proformas por pagar</div>
              <dl className="pay-list">
                {open.map((item) => {
                  const disabled = item.due <= 0 || item.inValidation;
                  return (
                    <div className="card-item-field" key={item.proformaId}>
                      <dt>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={selected.has(item.proformaId)}
                            disabled={disabled || saving || cardOpen}
                            onChange={() => toggle(item)}
                          />
                          Proforma {item.number} · {FLOW_LABELS[item.flow]} · {item.shipmentCount} trámites
                        </label>
                        {item.inValidation && <div className="cell-sub">Tiene un pago en validación.</div>}
                        <a
                          className="btn btn-link"
                          href={`${API_BASE}/api/proformas/${item.proformaId}/document`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Ver proforma
                        </a>
                      </dt>
                      <dd>
                        <strong>{formatMoney(item.due, item.currency)}</strong>
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {currencyNotice ? (
                <div className="banner info" role="status" style={{ marginTop: 10 }}>
                  {currencyNotice}
                </div>
              ) : (
                new Set(open.map((i) => i.currency)).size > 1 && (
                  <div className="field-hint">
                    Las proformas en dólares y en colones se pagan por separado.
                  </div>
                )
              )}
            </div>
          )}

          {quote && (
            <div className="pay-sec is-money">
              <div className="card-sec-title">Monto a pagar</div>
              <dl className="pay-fields">
                <div className="card-item-field">
                  <dt>Proformas</dt>
                  <dd>{quote.items.length}</dd>
                </div>
                <div className="card-item-field">
                  <dt>Saldo</dt>
                  <dd className="pay-due is-debt">{formatMoney(due, chargeCurrency)}</dd>
                </div>
              </dl>
              {quote.inValidation && (
                <div className="banner">Ya hay un pago de estas proformas esperando validación. No hace falta que pagues de nuevo.</div>
              )}
            </div>
          )}

          {quote && due > 0 && !quote.inValidation && quote.availableMethods.length === 0 && (
            <div className="banner warn">No hay medios de pago disponibles en este momento. Contáctanos para coordinar.</div>
          )}

          {quote && due > 0 && !quote.inValidation && quote.availableMethods.length > 0 && (
            <div>
              <span className="field-label">Medio de pago</span>
              <div className="pay-methods">
                {quote.availableMethods.map((m) => (
                  <label className={`pay-method${method === m ? ' is-on' : ''}`} key={m}>
                    <input type="radio" name="pmethod" checked={method === m} onChange={() => setMethod(m)} />
                    <Icon name={m === PaymentMethod.Tarjeta ? 'card' : 'file'} size={17} />
                    <span>{PAYMENT_METHOD_LABELS[m]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {canPay && method === PaymentMethod.DepositoBancario && quote && (
            <>
              <div className="banner">
                Deposita a nombre de <strong>HS Global Services</strong> y adjunta el comprobante. Un solo depósito por el
                total cubre todas las proformas elegidas.
              </div>
              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="pp-bank">Cuenta</label>
                  <select
                    id="pp-bank" className="input" value={bankAccount ?? ''}
                    onChange={(e) => setBankAccount(e.target.value as BankAccount)}
                  >
                    {quote.availableBankAccounts.map((b) => (
                      <option key={b} value={b}>{bankAccountOptionLabel(b)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="pp-date">Fecha del depósito</label>
                  <input id="pp-date" className="input" type="date" value={depositDate} onChange={(e) => setDepositDate(e.target.value)} />
                </div>
              </div>
              {bankAccount && (
                <div className="pay-sec is-bank">
                  <div className="card-sec-title">Información bancaria</div>
                  <dl className="pay-fields">
                    <div className="card-item-field"><dt>Titular</dt><dd>HS Global Services</dd></div>
                    <div className="card-item-field"><dt>Cédula jurídica</dt><dd className="mono">3-102-869317</dd></div>
                    <div className="card-item-field"><dt>Banco</dt><dd>{BANK_ACCOUNTS[bankAccount].bank}</dd></div>
                    <div className="card-item-field"><dt>Moneda</dt><dd>{CURRENCY_LABELS[BANK_ACCOUNTS[bankAccount].currency]}</dd></div>
                    {BANK_ACCOUNTS[bankAccount].number && (
                      <div className="card-item-field"><dt>Cuenta</dt><dd className="mono">{BANK_ACCOUNTS[bankAccount].number}</dd></div>
                    )}
                    <div className="card-item-field"><dt>IBAN</dt><dd className="mono">{BANK_ACCOUNTS[bankAccount].iban}</dd></div>
                  </dl>
                </div>
              )}
              <div className="field-pair">
                <div>
                  <label className="field-label" htmlFor="pp-receipt-no">Número de comprobante</label>
                  <input id="pp-receipt-no" className="input mono" value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} />
                </div>
                <FileField
                  id="pp-receipt"
                  label="Comprobante"
                  accept={PROOF_ATTACHMENT.accept}
                  file={receipt}
                  onPick={pickReceipt}
                  disabled={saving}
                  hint={`Se aceptan ${PROOF_ATTACHMENT.label}.`}
                />
              </div>
            </>
          )}

          {canPay && method === PaymentMethod.Tarjeta && (
            <div className="banner">
              Al continuar abriremos el formulario seguro de pago con tarjeta por {formatMoney(payable, chargeCurrency)}.
              {cardCharge && cardCharge.surcharge > 0 && (
                <>
                  {' '}
                  Saldo {formatMoney(cardCharge.amount, chargeCurrency)} más comisión bancaria por pago con tarjeta{' '}
                  <strong>{formatMoney(cardCharge.surcharge, chargeCurrency)}</strong>.
                </>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={() => void closeModal()}>
            Cerrar
          </button>
          {canPay && !cardOpen && (
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Registrando…' : `Pagar ${formatMoney(payable, chargeCurrency)}`}
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
                <p>{(quote?.items ?? []).map((i) => `Proforma ${i.number}`).join(' · ')}</p>
              </div>
              <div className="pay-head-amount">
                <span>A pagar</span>
                <strong>{formatMoney(cardCharge?.total ?? due, chargeCurrency)}</strong>
              </div>
            </div>
            <div className="modal-body pay-checkout">
              {alerts}
              {cardIntent.intent.simulated ? (
                <>
                  <div className="banner warn">
                    Modo de pruebas: no se cobra nada real. Elige cómo debe responder la pasarela para seguir el flujo.
                  </div>
                  <div className="pay-sec-actions">
                    <button type="button" className="btn" disabled={saving} onClick={() => simulate(false)}>
                      Rechazar cobro
                    </button>
                    <button type="button" className="btn btn-primary" disabled={saving} onClick={() => simulate(true)}>
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
                  onFailed={(message) => {
                    setNotice(null);
                    setError(message);
                  }}
                />
              )}
            </div>
            <div className="modal-foot">
              <p className="pay-secure">
                <Icon name="lock" size={15} />
                <span>Pago cifrado de extremo a extremo. No guardamos tu tarjeta.</span>
              </p>
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void cancelCard()}>
                Cancelar pago
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </ModalOverlay>
  );
}
