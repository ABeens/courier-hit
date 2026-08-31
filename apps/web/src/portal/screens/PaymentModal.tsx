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
 *   - PASARELA REAL: se monta el SDK de Onvo (`OnvoCardForm`) con `publicKey` y
 *     `paymentIntentId`. Quien confirma el pago NO es el navegador sino el
 *     webhook, así que cuando el SDK termina no se da nada por cobrado: se vuelve
 *     a preguntar por el pago a nuestra API hasta que el webhook lo resuelva
 *     (`waitForResolution`). Creerle al callback del SDK anunciaría como pagado un
 *     cargo que la pasarela todavía puede rechazar.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { Icon } from '../components/Icon';
import { ModalOverlay } from '../components/ModalOverlay';
import { OnvoCardForm } from '../components/OnvoCardForm';
import type { PaymentResult } from './PaymentResultModal';
import { formatDate } from '../lib/datetime';

/**
 * Pildora del estado de un abono. Un `.spill` a secas se pinta sin fondo, o sea
 * como texto suelto: pendiente y rechazado se leian igual y ninguno se leia como
 * un estado.
 */
function statusPill(status: PaymentStatus): string {
  if (status === PaymentStatus.Confirmado) return 'spill ok';
  if (status === PaymentStatus.Rechazado) return 'spill danger';
  return 'spill warn';
}

/**
 * Espera del desenlace del cobro con tarjeta. El SDK termina antes que el
 * webhook: entre que el navegador acaba y Onvo nos avisa pasan segundos, así que
 * la pantalla pregunta en bucle en vez de leer una sola vez y dar por pendiente
 * lo que ya está cobrado.
 *
 * Si se agota, el pago NO se da por perdido ni por hecho: sigue pendiente en el
 * servidor y el webhook lo resolverá cuando llegue. Lo único que se acaba aquí es
 * la espera en pantalla.
 */
const CONFIRM_POLL_MS = 2_000;
const CONFIRM_ATTEMPTS = 15;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Quote {
  shipmentId: string;
  shipmentCode: string;
  description: string;
  /**
   * La cuenta es CONSOLIDADA: este trámite no se paga suelto sino junto con el
   * resto de los paquetes listos del casillero. Lo contesta la API, que es
   * además la que rechaza el pago individual; aquí solo se retira el formulario
   * para no ofrecer un botón que acaba en un 409.
   */
  consolidated: boolean;
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
   * Cierra el modal anunciando lo que PASO. El desenlace viaja desde aqui porque
   * solo este componente distingue un deposito registrado (queda por validar) de
   * un cobro con tarjeta ya aprobado (el tramite queda cubierto), y decirle al
   * cliente que su pago "queda pendiente" cuando ya se cobro es lo que le hace
   * pensar que no paso nada.
   *
   * No es un texto sino un resultado con `kind`: quien lo recibe pinta la
   * confirmacion, y el tono (cobrado / en camino) no puede deducirse de una frase.
   *
   * Un cobro RECHAZADO no llama aqui: el modal se queda abierto para reintentar.
   */
  onPaid: (result: PaymentResult) => void;
  /**
   * El cargo salio y estamos esperando el desenlace. Abre la MISMA pantalla que
   * `onPaid`, en espera, para que luego se transforme en la respuesta en vez de
   * cerrarse y abrirse otra.
   *
   * Este modal NO se cierra al llamarla: la espera vive aqui dentro (el sondeo
   * contra nuestra API), asi que la pantalla de atras solo pinta encima. Con
   * `null` se retira la espera sin desenlace, que es lo que pasa cuando la
   * pasarela rechaza el cobro y el cliente se queda aqui para reintentar.
   */
  onProcessing: (result: PaymentResult | null) => void;
}

export function PaymentModal({ shipment, role, onClose, onPaid, onProcessing }: Props) {
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
   * Historial de abonos desplegado. Solo existe en pantallas estrechas: ahi el
   * listado es una consulta ocasional y, fijo en la columna, empujaba el
   * formulario de la tarjeta media pantalla hacia abajo.
   */
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * Lo ya abonado y sin validar, tal como lo calcula el servidor. No se recalcula
   * aqui sobre la lista de pagos: la cifra que se le enseña al cliente y la que
   * usa la guarda que rechaza un segundo abono tienen que ser la misma, o el
   * modal acabaria ofreciendo un boton que la API contesta con un 409.
   */
  const pendingCrc = quote?.pendingCrc ?? 0;

  /**
   * DE QUÉ son los abonos pendientes. Un cobro con tarjeta a la espera del
   * webhook y un depósito a la espera de que alguien mire el comprobante son dos
   * cosas distintas, y las dos se anunciaban con el texto del depósito: al que
   * pagó con tarjeta se le decía "recibimos ₡X y estamos validando el
   * comprobante", o sea que su dinero ya entró (no entró) y que hay un
   * comprobante (no lo hay). Anunciar como recibido un cobro que la pasarela
   * todavía puede rechazar es la versión cara de ese error.
   *
   * Solo cambia CÓMO se dice. El importe sigue saliendo de `quote.pendingCrc`,
   * que es la cifra del servidor, y esto no se usa para decidir si se puede pagar
   * —eso es `inValidation`, y lo decide la API—.
   */
  const pendingPayments = payments.filter((p) => p.status === PaymentStatus.Pendiente);
  const pendingIsOnlyCard =
    pendingPayments.length > 0 && pendingPayments.every((p) => p.method === PaymentMethod.Tarjeta);

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
   * El desenlace que se le entrega a la pantalla de atras para que lo anuncie.
   *
   * El importe es el saldo que se acaba de cubrir, ya formateado en la moneda en
   * que esta pantalla le hablo al cliente (`amounts`): la confirmacion tiene que
   * repetir la MISMA cifra que el cliente vio antes de pagar, no reexpresarla.
   */
  function outcome(kind: PaymentResult['kind'], title: string, message: string): PaymentResult {
    return {
      kind,
      title,
      message,
      code: shipment.code,
      amount: amounts ? formatMoney(amounts.due, amounts.currency) : '',
    };
  }

  /**
   * ¿Se puede pagar ahora mismo? No basta con que quede saldo: un comprobante ya
   * subido y sin resolver deja el tramite EN VALIDACION, y ahi el cliente no
   * vuelve a pagar —pagaria dos veces el mismo saldo, porque un abono pendiente
   * no lo baja—. Solo mira su comprobante y espera.
   */
  const canPay =
    quote != null && !quote.consolidated && !quote.settled && !quote.inValidation;

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

      onPaid(
        outcome(
          'pending',
          'Depósito registrado',
          'Validaremos el comprobante y te avisaremos apenas quede confirmado. Mientras tanto el saldo del trámite sigue abierto.',
        ),
      );
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
        onPaid(outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago y el trámite queda cubierto.'));
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

  /**
   * Pregunta por el desenlace del cobro a NUESTRA API, que es donde el webhook lo
   * deja. Devuelve null si se agotó la espera con el pago todavía sin resolver.
   */
  async function waitForResolution(paymentId: string): Promise<PaymentDto | null> {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const { items } = await api.get<{ items: PaymentDto[] }>(
        `/payments/shipment/${shipment.id}`,
      );
      const row = items.find((p) => p.id === paymentId);
      if (row && row.status !== PaymentStatus.Pendiente) {
        setPayments(items);
        return row;
      }
      await sleep(CONFIRM_POLL_MS);
    }
    return null;
  }

  /**
   * El SDK de Onvo terminó su parte. Aquí TODAVÍA no se sabe si se cobró: quien
   * lo decide es el webhook contra el servidor, y por eso lo primero que se hace
   * es preguntar en vez de anunciar.
   */
  async function confirmCard() {
    if (!cardIntent) return;
    setError(null);
    setNotice(null);
    setSaving(true);

    /**
     * La espera se enseña ya, y en la pantalla del desenlace: es la misma ventana
     * que luego dira si se cobro, asi que el cliente ve un loader que se convierte
     * en la respuesta. Antes era un renglon de aviso dentro del formulario de la
     * tarjeta, donde se lee como un detalle mas y no como "esto todavia no ha
     * terminado".
     */
    onProcessing(
      outcome(
        'processing',
        'Confirmando tu pago…',
        'Estamos esperando la respuesta de la pasarela. No cierres esta ventana.',
      ),
    );

    try {
      /**
       * Primero se le avisa al servidor de que el cargo SALIO. Hasta aqui el pago
       * era solo un formulario abierto (no contaba como abono, no bloqueaba nada);
       * a partir de ahora hay dinero en camino y tiene que contar, aunque el
       * webhook todavia no haya llegado.
       *
       * No confirma nada ni se deja fallar: si esta llamada se pierde, el cobro lo
       * resuelve igual el webhook. Cortar aqui el flujo le enseñaria un error al
       * cliente por un pago que salio bien.
       */
      await api.post(`/payments/${cardIntent.paymentId}/submitted`, {}).catch(() => undefined);

      const resolved = await waitForResolution(cardIntent.paymentId);

      if (resolved?.status === PaymentStatus.Confirmado) {
        setCardIntent(null);
        onPaid(outcome('paid', '¡Pago aprobado!', 'Recibimos tu pago y el trámite queda cubierto.'));
        return;
      }

      if (resolved?.status === PaymentStatus.Rechazado) {
        // Igual que en la simulación: el modal no se cierra, para reintentar aquí
        // mismo. El saldo lo manda el servidor y este intento no lo movió.
        onProcessing(null);
        setCardIntent(null);
        setNotice('La pasarela rechazó el cobro. Puedes intentarlo de nuevo.');
        setQuote(await api.get<Quote>(`/payments/quote/${shipment.id}`));
        return;
      }

      /**
       * Se agotó la espera sin webhook. Es lo único honesto que se le puede decir
       * al cliente: el cargo salió, pero de aquí NO sale un "pagado". El pago
       * sigue pendiente en el servidor y el webhook lo resolverá cuando llegue;
       * lo que se acabó es la espera en pantalla, no el cobro.
       */
      setCardIntent(null);
      onPaid(
        outcome(
          'pending',
          'Pago enviado',
          'La pasarela todavía está confirmando el cobro. Te avisaremos apenas quede registrado; no hace falta que pagues de nuevo.',
        ),
      );
    } catch (err) {
      // Se retira la espera: si se queda puesta, el cliente ve un loader eterno
      // encima del error que explica que hacer.
      onProcessing(null);
      setError(err instanceof ApiError ? err.message : 'No se pudo confirmar el cobro.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * La pasarela rechazó la tarjeta sin llegar a cobrar. El formulario sigue
   * montado y el mismo intento admite otro intento con otra tarjeta, así que solo
   * se muestra el motivo: no se toca el pago ni se cierra nada.
   */
  function cardFailed(message: string) {
    setNotice(null);
    setError(message);
  }

  /**
   * Cierre del modal. Con un cobro con tarjeta a medias hay que avisarle al
   * servidor: ese pago quedó reservado y, si no se suelta, cuenta como abono en
   * validación, bloquea el siguiente intento y le anuncia al cliente un dinero
   * que nadie cobró. Abrir y cerrar dejaba el trámite trabado.
   *
   * Es BEST-EFFORT y por eso se traga el error: quien decide si el cobro se puede
   * soltar es la pasarela, no esta pantalla, y dejar al cliente encerrado en un
   * modal porque no pudimos limpiar sería peor que el rastro que queda. Si Onvo
   * responde que el cobro ya iba en camino, el pago se queda donde está y lo
   * resuelve el webhook.
   */
  async function closeModal() {
    if (cardIntent) {
      await api.post(`/payments/${cardIntent.paymentId}/abandon`, {}).catch(() => undefined);
    }
    onClose();
  }

  /**
   * Cancelar el cobro con tarjeta: cierra SU modal y devuelve al trámite, que
   * sigue abierto detrás con el medio de pago ya elegido.
   *
   * El intento hay que soltarlo en el servidor por lo mismo que al cerrar del
   * todo: reservado cuenta como abono en validación y bloquea el siguiente
   * intento. Y como ese abandono mueve el saldo, se vuelve a pedir la cotización
   * en vez de dejar en pantalla la de antes.
   *
   * Mientras se confirma no se cancela nada: ahí el cargo ya salió y quien lo
   * resuelve es el webhook, así que anularlo dejaría al cliente creyendo que no
   * pagó un cobro que la pasarela puede estar aprobando.
   */
  async function cancelCard() {
    const current = cardIntent;
    if (!current || saving) return;
    setCardIntent(null);
    setError(null);
    setNotice(null);
    await api.post(`/payments/${current.paymentId}/abandon`, {}).catch(() => undefined);
    await Promise.all([
      api.get<Quote>(`/payments/quote/${shipment.id}`),
      api.get<{ items: PaymentDto[] }>(`/payments/shipment/${shipment.id}`),
    ])
      .then(([q, list]) => {
        setQuote(q);
        setPayments(list.items);
      })
      .catch(() => undefined);
  }

  /**
   * Hay un cobro con tarjeta en curso. Ya no cambia de forma este modal: el
   * formulario de la pasarela vive en SU PROPIO modal, encima. Aquí se elige el
   * medio y se llenan los datos del trámite; allí solo se paga, sin el historial
   * ni el selector alrededor.
   */
  const cardOpen = cardIntent != null;

  /**
   * Avisos del cobro. Se pintan en el modal que está delante, no en los dos: con
   * la pasarela abierta, un error del SDK anunciado en la pantalla de atrás queda
   * detrás de su propia capa oscura, que es como no anunciarlo.
   */
  const alerts = (
    <>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
    </>
  );

  const summary = quote && amounts && (
    <div className="pay-sec is-money">
      <div className="card-sec-title">Monto a pagar</div>
      <dl className="pay-fields">
        <div className="card-item-field">
          <dt>Factura</dt>
          <dd>
            {amounts.invoiceTotal != null
              ? formatMoney(amounts.invoiceTotal, amounts.currency)
              : '—'}
            {/*
              El equivalente en la otra moneda solo acompaña al cobro en colones.
              En Paquetería el cobro ES en dólares y ponerle al lado el importe en
              colones sería exactamente la conversión que no se le enseña al
              cliente.
            */}
            {amounts.currency === Currency.CRC && quote.invoiceTotalUsd != null && (
              <> · {formatMoney(quote.invoiceTotalUsd, Currency.USD)}</>
            )}
          </dd>
        </div>
        <div className="card-item-field">
          <dt>Abonado</dt>
          <dd>{formatMoney(amounts.paid, amounts.currency)}</dd>
        </div>
        <div className="card-item-field">
          <dt>Saldo</dt>
          <dd className="pay-due">{formatMoney(amounts.due, amounts.currency)}</dd>
        </div>
      </dl>
    </div>
  );

  /**
   * Un abono ya subido y sin resolver. Se dice explícitamente porque el saldo de
   * arriba sigue completo (un comprobante sin validar no es dinero recibido) y
   * sin este aviso el cliente lee ese saldo como que su depósito nunca llegó.
   *
   * Si ese abono cubre el saldo, además desaparece todo el formulario: el aviso
   * queda como única respuesta, y por eso dice explícitamente que no hay que
   * volver a pagar. Verlo junto a un botón de pagar activo es lo que hacía que el
   * cliente pagara dos veces.
   */
  const pendingNotice = quote && amounts && !quote.settled && pendingCrc > 0 && (
    <div className="banner">
      {pendingIsOnlyCard ? (
        <>
          Tu pago con tarjeta de {formatMoney(amounts.pending, amounts.currency)} está a la espera
          de que la pasarela lo confirme. Te avisaremos apenas quede registrado.
        </>
      ) : (
        <>
          Recibimos {formatMoney(amounts.pending, amounts.currency)} y estamos validando el
          comprobante. Te avisaremos apenas quede confirmado.
        </>
      )}
      {quote.inValidation && <> No hace falta que pagues de nuevo.</>}
    </div>
  );

  /**
   * El listado de abonos, sin envoltorio. Se pinta en dos sitios que no comparten
   * marco: suelto en el cuerpo del modal cuando hay ancho, y dentro de la hoja
   * emergente cuando no lo hay.
   */
  const historyItems = payments.length > 0 && (
    <dl className="pay-list">
      {payments.map((payment) => (
        <div className="card-item-field" key={payment.id}>
          <dt>
            {formatDate(payment.createdAt)} · {PAYMENT_METHOD_LABELS[payment.method]}
          </dt>
          <dd>
            {/*
              El abono se reexpresa a la moneda en que esta pantalla habla del
              cobro, y con SU PROPIA tasa congelada (regla M5), que es la misma
              aritmética de `settledAmount`. Sin esto, el cliente de Paquetería
              leería "Abonado $48.76" arriba y "₡25.000" aquí abajo: dos cifras
              para el mismo depósito.
            */}
            <strong>
              {formatMoney(
                convertMoney(payment.amount, payment.currency, currency, payment.exchangeRate),
                currency,
              )}
            </strong>
            <span className={statusPill(payment.status)}>
              {/*
                "Pendiente de validación" describe el depósito: alguien tiene que
                mirar un comprobante. Un cobro con tarjeta pendiente espera al
                webhook de la pasarela, no a una persona, y el cliente no tiene
                nada que aportar.
              */}
              {payment.status === PaymentStatus.Pendiente &&
              payment.method === PaymentMethod.Tarjeta
                ? 'Pendiente de confirmación'
                : PAYMENT_STATUS_LABELS[payment.status]}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );

  const paymentsList = historyItems && (
    <div className="pay-sec pay-history">
      <div className="card-sec-title">Pagos registrados</div>
      {historyItems}
    </div>
  );

  return (
    /*
      Cerrar (Esc o clic fuera) siempre lo resuelve la capa que está delante. Con
      la pasarela abierta manda su modal, y con la hoja del historial desplegada,
      la hoja. La guarda va aquí y no en escuchas propias porque `ModalOverlay`
      escucha Esc en `window`: dos escuchas para la misma tecla acabarían
      abandonando el cobro por cerrar lo que hay encima.
    */
    <ModalOverlay
      onClose={() => {
        if (cardOpen) return;
        if (historyOpen) {
          setHistoryOpen(false);
          return;
        }
        void closeModal();
      }}
    >
      <form
        className="modal modal-lg fadeUp"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal-head">
          <h3>Pagar trámite</h3>
          <p>
            {shipment.code} · {shipment.description}
          </p>
        </div>

        <div className="modal-body">
          {!cardOpen && alerts}

          {summary}

          {quote?.consolidated && !quote.settled && (
            <div className="banner warn">
              Esta cuenta es consolidada: los paquetes se pagan todos juntos, no uno a uno. Usa
              «Pagar consolidado» desde el listado de paquetes.
            </div>
          )}

          {quote?.settled && <div className="banner ok">Este trámite ya está pagado.</div>}

          {pendingNotice}

          {canPay && quote.availableMethods.length === 0 && (
            <div className="banner warn">
              No hay medios de pago disponibles en este momento. Contáctanos para coordinar.
            </div>
          )}

          {canPay && quote.availableMethods.length > 0 && (
            <div>
              <span className="field-label">Medio de pago</span>
              {/*
                Cada medio es una opción con marco propio, no un radio suelto en
                una línea: el área de clic es la opción entera y cuál está elegida
                se ve sin ir a buscar el punto azul.
              */}
              <div className="pay-methods">
                {quote.availableMethods.map((m) => (
                  <label className={`pay-method${method === m ? ' is-on' : ''}`} key={m}>
                    <input
                      type="radio"
                      name="method"
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
                Validaremos el depósito y te avisaremos.
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
                  <label className="field-label" htmlFor="p-receipt-no">
                    Número de comprobante
                  </label>
                  <input
                    id="p-receipt-no"
                    className="input mono"
                    value={receiptNumber}
                    onChange={(e) => setReceiptNumber(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="p-receipt">
                    Comprobante (imagen o PDF)
                  </label>
                  <input
                    id="p-receipt"
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
              Al continuar abriremos el formulario seguro de pago con tarjeta.
            </div>
          )}

          {paymentsList}

          {/*
            El mismo historial para pantallas estrechas. Cuál de los dos se ve lo
            decide el CSS por el ancho del modal: aquí se pintan los dos porque el
            listado de la hoja no existe hasta que se abre.
          */}
          {historyItems && (
            <button
              type="button"
              className="btn btn-ghost pay-history-toggle"
              onClick={() => setHistoryOpen(true)}
            >
              <Icon name="clock" size={16} />
              Pagos registrados ({payments.length})
            </button>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={() => void closeModal()}>
            Cerrar
          </button>
          {/*
            Con un cobro ya iniciado el botón desaparece: el pago existe en el
            servidor y volver a enviarlo abriría un segundo cobro por el mismo saldo.
            Con un abono en validación desaparece por la misma razón.
          */}
          {canPay && method && !cardOpen && (
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Registrando…' : 'Registrar pago'}
            </button>
          )}
        </div>
      </form>

      {/*
        La hoja va por `createPortal` a <body> y no dentro del formulario: el
        cuerpo del modal es el que scrollea, y un panel absoluto ahí dentro se
        corta en su borde. Su fondo tampoco cierra el modal (está fuera del
        overlay, así que el clic no llega a `ModalOverlay`).
      */}
      {historyOpen &&
        historyItems &&
        createPortal(
          <div
            className="sheet-scrim"
            onMouseDown={() => setHistoryOpen(false)}
            role="presentation"
          >
            <div className="sheet fadeUp" onMouseDown={(e) => e.stopPropagation()}>
              <div className="sheet-head">
                <h4>Pagos registrados</h4>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setHistoryOpen(false)}
                >
                  Cerrar
                </button>
              </div>
              {historyItems}
            </div>
          </div>,
          document.body,
        )}

      {/*
        El cobro, en su propio modal. Encima del trámite y no en su lugar: el
        cliente vuelve aquí si cancela, con el medio de pago que ya había elegido.
        Dentro no hay nada más que el importe y la pasarela; el historial y el
        selector no ayudan a teclear una tarjeta y le quitaban el alto que el
        formulario necesita para no acabar detrás de un scroll.
      */}
      {cardIntent && (
        <ModalOverlay onClose={() => void cancelCard()}>
          <div className="modal modal-pay fadeUp" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head pay-head">
              <div>
                <h3>Pago con tarjeta</h3>
                <p>
                  {shipment.code} · {shipment.description}
                </p>
              </div>
              {amounts && (
                <div className="pay-head-amount">
                  <span>A pagar</span>
                  <strong>{formatMoney(amounts.due, amounts.currency)}</strong>
                </div>
              )}
            </div>

            <div className="modal-body pay-checkout">
              {alerts}

              {cardIntent.intent.simulated ? (
                /* Pasarela de pruebas: no hay SDK que montar, se elige el desenlace. */
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
                /*
                  Pasarela real: el formulario lo pinta Onvo dentro de su propio
                  contenedor. La tarjeta no pasa por aquí, y el desenlace tampoco lo
                  decide este componente: `confirmCard` va a preguntarlo al servidor.
                */
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
              {/* En el pie y no sobre el formulario: es una garantía, no un paso. */}
              <p className="pay-secure">
                <Icon name="lock" size={15} />
                <span>Pago cifrado de extremo a extremo. No guardamos tu tarjeta.</span>
              </p>
              {/*
                Cancelar suelta el cobro en el servidor y vuelve al trámite. Se
                bloquea mientras se confirma: ahí el cargo ya salió y anularlo
                dejaría al cliente creyendo que no pagó.
              */}
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
