/**
 * Editor de costos: las lineas de UN tramite (permiso costs.manage /
 * costs.tramite.manage) o los servicios adicionales de UNA proforma (permiso
 * proformas.manage). Es la misma pantalla para los dos porque es el mismo
 * trabajo: elegir conceptos del catalogo en filas, con su monto y su moneda.
 *
 * Tres reglas que se ven en pantalla:
 *   - La TASA DE CAMBIO es un valor general del sistema: se muestra siempre (es
 *     la que queda guardada en cada linea, regla M5) pero solo la edita quien
 *     tiene `exchange_rate.write`. Al resto le sale bloqueada. Sin tasa vigente
 *     no se guarda, y quien no puede fijarla tiene que pedirsela a un admin.
 *   - Las lineas de PORCENTAJE no llevan monto: el importe lo calcula la API
 *     sobre el subtotal de las demas. Aqui solo se muestra la estimacion.
 *   - Cada linea tiene COSTO NETO (en codigo, `realAmount`) y COSTO A FACTURAR
 *     (`amount`). El costo a facturar nace igual al neto y lo sigue mientras
 *     nadie lo edite; editarlo factura otro valor. La proforma y los totales
 *     usan el costo a facturar; el neto solo lo leen los reportes, y la
 *     diferencia queda en el margen.
 *   - AQUI NO SE APRUEBA. Aprobar es un acto sobre la PROFORMA (numero, factura
 *     congelada y avance a cobro), y se hace desde su detalle. Con la proforma
 *     aprobada este editor queda en solo lectura; para cambiarla se corrige.
 */
import { useCallback, useEffect, useState } from 'react';
import { IconButton } from '../components/IconButton';
import { ModalOverlay } from '../components/ModalOverlay';
import { OptionPicker } from '../components/OptionPicker';
import type { PickerOption } from '../components/OptionPicker';
import {
  CURRENCY_LABELS,
  CostLineSource,
  Currency,
  ServiceValueType,
  canSetExchangeRate,
  clientFullLabel,
  applyPercentage,
  computeTotals,
  percentageBase,
  roundMoney,
  formatMoney,
} from '@courier/shared';
import type { Role, ShipmentCostsDto, ShipmentDto, SuggestedCostLine } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate } from '../lib/datetime';
import { useErrorToast } from '../lib/toast';

/**
 * Que se edita: las lineas de un tramite, o los servicios de una proforma. De
 * esto sale la direccion de la API y el encabezado.
 */
export type CostsTarget =
  | { kind: 'shipment'; shipment: ShipmentDto }
  | { kind: 'proforma'; id: string; title: string; subtitle: string };

interface Props {
  target: CostsTarget;
  role: Role;
  onClose: () => void;
  /** Tras guardar, para que quien abrio el editor refresque lo suyo. */
  onSaved?: () => void;
}

/** Direccion de la API de cada editor (lectura y guardado van al mismo sitio). */
function endpointOf(target: CostsTarget): string {
  return target.kind === 'shipment' ? `/costs/${target.shipment.id}` : `/proformas/${target.id}/costs`;
}

/**
 * Valor del desplegable cuando la linea no sale del catalogo, sino que el
 * operador escribe el concepto a mano. No colisiona con un uuid de servicio.
 */
const CUSTOM_PICK = '__custom__';

/** Linea en edicion. `key` es local: las lineas nuevas aun no tienen id de BD. */
interface DraftLine {
  key: string;
  costServiceId: string | null;
  label: string;
  source: CostLineSource;
  /** Texto crudo del input: se convierte a numero solo al guardar. */
  percentage: string;
  /** COSTO REAL (texto crudo): del catalogo, de la tarifa o digitado. */
  amount: string;
  /**
   * COSTO FACTURADO digitado (texto crudo). Solo cuenta si `billedTouched`: si
   * no, el facturado es el real (`billedOf`).
   */
  billed: string;
  /** True si el operador fijo el facturado a mano; si no, sigue al real. */
  billedTouched: boolean;
  currency: Currency;
  /**
   * Lo elegido en el desplegable de concepto: id del servicio del catalogo,
   * `CUSTOM_PICK` para un concepto suelto, o vacio en una fila recien agregada
   * que aun no elige. Va aparte de `costServiceId` porque ese es null tanto en
   * "todavia no elige" como en "concepto escrito a mano".
   */
  pick: string;
  /**
   * Como se determina el importe de la linea, copiado del catalogo. `null` = la
   * fila todavia no eligio concepto (o es el flete, que no sale del catalogo).
   */
  valueType: ServiceValueType | null;
}

/**
 * True si el importe de la linea se DIGITA aqui.
 *
 * Solo lo admiten los conceptos marcados en el catalogo como manuales ("se define
 * al cargar"): el monto fijo y el porcentaje ya vienen resueltos del catalogo y
 * cambiarlos en un tramite suelto seria cobrar algo distinto a lo publicado. El
 * flete es la excepcion: no es catalogo, sale de la tarifa del casillero y el
 * operador sigue pudiendo ajustarlo.
 */
function isAmountEditable(line: DraftLine): boolean {
  return line.source === CostLineSource.Freight || line.valueType === ServiceValueType.Manual;
}

/** Costo facturado efectivo de la linea: el digitado, o el real si no se toco. */
function billedOf(line: DraftLine): string {
  return line.billedTouched ? line.billed : line.amount;
}

/** True si la linea se factura por un valor distinto a su costo real. */
function isBilledAdjusted(line: DraftLine): boolean {
  return line.billedTouched && Number(line.billed) !== Number(line.amount);
}

let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

/** Sugerencia del catalogo -> linea en edicion. */
function fromSuggestion(s: SuggestedCostLine): DraftLine {
  return {
    key: nextKey(),
    costServiceId: s.costServiceId,
    label: s.label,
    source: s.source,
    percentage: s.percentage !== null ? String(s.percentage) : '',
    amount: s.amount !== null ? String(s.amount) : '',
    billed: '',
    billedTouched: false,
    currency: s.currency,
    pick: s.costServiceId ?? CUSTOM_PICK,
    valueType: s.valueType,
  };
}

export function CostsEditorModal({ target, role, onClose, onSaved }: Props) {
  const endpoint = endpointOf(target);
  const [data, setData] = useState<ShipmentCostsDto | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  /** Clave de la ultima fila agregada a mano: es la que lleva el destello. */
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const setError = useErrorToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const dto = await api.get<ShipmentCostsDto>(endpoint);
      setData(dto);
      /**
       * El tipo de valor no se guarda en la linea (la linea es un snapshot de
       * importes, no del catalogo): se reconoce por el servicio del que salio.
       * Si ese servicio ya no esta habilitado, la linea queda como manual, que es
       * lo unico util: nadie puede consultar el valor de catalogo que ya no esta.
       */
      const valueTypeOf = (costServiceId: string | null) =>
        dto.suggestions.find((s) => s.costServiceId === costServiceId)?.valueType ??
        ServiceValueType.Manual;
      const savedLines = dto.lines.map((l) => ({
        key: nextKey(),
        costServiceId: l.costServiceId,
        label: l.label,
        source: l.source,
        percentage: l.percentage !== null ? String(l.percentage) : '',
        // La linea guardada trae los dos: `amount` es el facturado y
        // `realAmount` el real. Si coinciden, el facturado vuelve a seguir al real.
        amount: String(l.realAmount),
        billed: String(l.amount),
        billedTouched: l.realAmount !== l.amount,
        currency: l.currency,
        pick: l.costServiceId ?? CUSTOM_PICK,
        valueType: l.source === CostLineSource.Freight ? null : valueTypeOf(l.costServiceId),
      }));
      /**
       * El flete no se "agrega": es el cobro base del tramite y sale de la tarifa
       * del casillero, asi que entra solo mientras no este ya guardado. El resto
       * del catalogo sigue siendo eleccion del operador.
       */
      const autoLines = dto.approved
        ? []
        : dto.suggestions
            .filter((s) => s.auto && !savedLines.some((l) => l.source === s.source))
            .map(fromSuggestion);
      setLines([...autoLines, ...savedLines]);
      // Recargar no es agregar: nada que resaltar ni a donde saltar.
      setLastAdded(null);
      // La tasa guardada manda sobre la vigente del sistema: si el tramite ya se
      // cargo con una tasa, cambiarla en silencio movería una factura ya cotizada.
      // Solo en la primera carga se toma la global (nunca la publicada, que es
      // referencia). Es el mismo orden que aplica la API en `resolveExchangeRate`.
      const savedRate = dto.lines[0]?.exchangeRate;
      setRate(String(savedRate ?? dto.globalExchangeRate ?? ''));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los costos.');
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const approved = data?.approved ?? false;
  const parsedRate = Number(rate);
  const rateOk = Number.isFinite(parsedRate) && parsedRate > 0;
  /**
   * Fijar la tasa es de admin: al resto se le muestra la vigente en solo lectura.
   * Es espejo de la API, que le impone esa misma tasa aunque el cuerpo traiga otra.
   */
  const canEditRate = canSetExchangeRate(role);

  /** Solo lo que el operador elige: el flete ya viene aplicado como linea. */
  const catalog = (data?.suggestions ?? []).filter((s) => !s.auto);
  /**
   * Opciones del desplegable de concepto: el catalogo tal cual, mas el concepto
   * suelto al final. El picker filtra por escritura sobre esta lista.
   */
  const conceptOptions: PickerOption[] = [
    ...catalog.map((s) => ({
      value: s.costServiceId ?? CUSTOM_PICK,
      label: s.label,
      detail: s.detail,
    })),
    { value: CUSTOM_PICK, label: 'Otro concepto…' },
  ];

  /**
   * Las opciones que ve una fila concreta. Un servicio que ya no esta habilitado
   * se lista desde la propia linea (y se dice que salio del catalogo) para que
   * una factura vieja no pierda el nombre de lo que cobro.
   */
  function optionsFor(line: DraftLine): PickerOption[] {
    if (line.costServiceId === null || catalog.some((s) => s.costServiceId === line.costServiceId)) {
      return conceptOptions;
    }
    return [
      { value: line.costServiceId, label: line.label, detail: 'Fuera del catálogo' },
      ...conceptOptions,
    ];
  }

  /**
   * Las lineas se GUARDAN en el orden del negocio (el flete primero, y luego cada
   * concepto en el orden en que se agrego) pero se PINTAN al reves: lo ultimo
   * agregado va arriba, pegado al boton de agregar. Asi una fila nueva nace a la
   * vista y no hay que ir a buscarla al final de una tabla larga.
   *
   * La inversion vive SOLO aqui, en la pintada. El estado y el cuerpo que se
   * manda a la API conservan su orden: darle la vuelta tambien al guardado
   * voltearia la factura en cada guardado.
   */
  const shownLines = [...lines].reverse();

  /** Moneda con la que arranca una fila nueva: la que propone el catalogo. */
  const defaultCurrency = data?.suggestions[0]?.currency ?? Currency.USD;
  /** De donde sale el flete ("3 kg × 13.45 USD/kg"), para mostrarlo bajo su nombre. */
  const freightDetail =
    data?.suggestions.find((s) => s.source === CostLineSource.Freight)?.detail ?? null;

  /**
   * Totales de la vista previa. Se calculan con el MISMO helper del dominio que
   * usa la API (`computeTotals`), asi lo que el operador ve antes de guardar es
   * lo que se va a congelar. Los porcentajes se estiman sobre el subtotal; en una
   * proforma ese subtotal incluye sus paquetes (`packagesSubtotal`), no solo
   * los servicios que se editan aqui.
   */
  /**
   * Se calcula dos veces con la misma cuenta: con el costo FACTURADO (el total
   * que paga el cliente) y con el REAL, cada uno con su propia base de porcentajes.
   */
  const previewWith = (
    amountOf: (l: DraftLine) => string,
    packages: { usd: number; crc: number },
  ) => {
    if (!rateOk) return null;
    const fixed = lines
      .filter((l) => l.source !== CostLineSource.Percentage)
      .map((l) => ({ amount: Number(amountOf(l)) || 0, currency: l.currency, exchangeRate: parsedRate, source: l.source }));
    const percentages = lines
      .filter((l) => l.source === CostLineSource.Percentage)
      .map((l) => {
        // Mismos helpers que `resolveLines` en la API: base y redondeo en un solo punto.
        const base = roundMoney(
          percentageBase(fixed, l.currency) + (l.currency === Currency.USD ? packages.usd : packages.crc),
          l.currency,
        );
        return {
          amount: applyPercentage(base, Number(l.percentage) || 0, l.currency),
          currency: l.currency,
          exchangeRate: parsedRate,
        };
      });
    return computeTotals([...fixed, ...percentages]);
  };
  const noPackages = { usd: 0, crc: 0 };
  const preview = previewWith(billedOf, data?.packagesSubtotal ?? noPackages);
  const realPreview = previewWith(
    (l) => l.amount,
    data?.packagesRealSubtotal ?? data?.packagesSubtotal ?? noPackages,
  );

  function patchLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /**
   * Fila nueva en blanco: se agrega vacia y el concepto se elige en su propio
   * desplegable. La moneda arranca en la que propone el catalogo del tramite
   * (dolares en Paqueteria, colones en Transporte/Agenciamiento).
   */
  function addLine() {
    const key = nextKey();
    setLastAdded(key);
    setLines((prev) => [
      ...prev,
      {
        key,
        costServiceId: null,
        label: '',
        source: CostLineSource.Service,
        percentage: '',
        amount: '',
        billed: '',
        billedTouched: false,
        currency: defaultCurrency,
        pick: '',
        // Sin concepto elegido no hay nada que digitar todavia.
        valueType: null,
      },
    ]);
  }

  /**
   * Elegir concepto en el desplegable de una fila. Un servicio del catalogo trae
   * consigo su tipo (monto o porcentaje), su valor por defecto y su moneda; el
   * concepto suelto deja el nombre en blanco para que el operador lo escriba.
   */
  function pickService(key: string, value: string) {
    // Volver a elegir lo mismo no rehace la fila: borraria el nombre que el
    // operador ya escribio en un concepto suelto.
    if (lines.find((l) => l.key === key)?.pick === value) return;
    if (value === CUSTOM_PICK) {
      // Se limpia tambien el monto: el valor por defecto era del servicio que se
      // acaba de soltar, y arrastrarlo a otro concepto es un monto heredado sin dueño.
      patchLine(key, {
        pick: CUSTOM_PICK,
        costServiceId: null,
        label: '',
        source: CostLineSource.Service,
        percentage: '',
        amount: '',
        billed: '',
        billedTouched: false,
        // La moneda vuelve a la que propone el catalogo del tramite: la que habia
        // era del servicio que se acaba de soltar, y aqui ya no significa nada.
        currency: defaultCurrency,
        // Un concepto suelto no esta en el catalogo: el importe lo pone quien lo escribe.
        valueType: ServiceValueType.Manual,
      });
      return;
    }
    const service = catalog.find((s) => s.costServiceId === value);
    // Un servicio que ya no esta en el catalogo (deshabilitado despues de
    // guardar) sigue listado desde la propia linea: no hay nada que reescribir.
    if (!service) return;
    patchLine(key, {
      pick: value,
      costServiceId: service.costServiceId,
      label: service.label,
      source: service.source,
      percentage: service.percentage !== null ? String(service.percentage) : '',
      amount: service.amount !== null ? String(service.amount) : '',
      // Concepto nuevo, facturado nuevo: vuelve a seguir al costo real.
      billed: '',
      billedTouched: false,
      currency: service.currency,
      valueType: service.valueType,
    });
  }

  async function save(): Promise<boolean> {
    setError(null);
    if (!rateOk) {
      setError(
        canEditRate
          ? 'Digita la tasa de cambio (colones por 1 dólar) o fíjala en Configuración.'
          : 'No hay tasa de cambio vigente. Pide a un administrador que la registre en Configuración.',
      );
      return false;
    }
    // El concepto sin elegir llega a la API como nombre vacio: se ataja aqui para
    // decir cual es el hueco, en vez de devolver un error de esquema.
    if (lines.some((l) => l.source !== CostLineSource.Freight && l.label.trim() === '')) {
      setError('Elige el concepto de cada línea (o escríbelo, si es un concepto suelto).');
      return false;
    }
    /**
     * Un monto en blanco viajaria como 0 y se guardaria como una linea que no
     * cobra nada. Solo puede pasar en las lineas que se digitan aqui: las del
     * catalogo ya traen su valor.
     */
    if (lines.some((l) => l.source !== CostLineSource.Percentage && l.amount.trim() === '')) {
      setError('Digita el monto de las líneas que se llenan al cargar el costo.');
      return false;
    }
    const payload = {
      lines: lines.map((l) => ({
        costServiceId: l.costServiceId,
        label: l.label.trim(),
        source: l.source,
        percentage: l.source === CostLineSource.Percentage ? Number(l.percentage) : null,
        // En porcentaje el importe lo calcula la API; mandarlo seria ruido.
        // `amount` es el facturado y `realAmount` el real.
        ...(l.source === CostLineSource.Percentage
          ? {}
          : { amount: Number(billedOf(l)), realAmount: Number(l.amount) }),
        currency: l.currency,
        exchangeRate: parsedRate,
      })),
    };
    try {
      await api.put(endpoint, payload);
      // El guardado de la proforma responde su detalle, no este sobre: se relee
      // del mismo sitio para que los dos editores terminen igual.
      await load();
      onSaved?.();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron guardar los costos.');
      return false;
    }
  }

  async function onSave() {
    setBusy(true);
    setNotice(null);
    if (await save()) setNotice('Costos guardados.');
    setBusy(false);
  }

  /** Aprobar guarda primero: nunca se congela un total distinto al que se ve. */
  return (
    <ModalOverlay onClose={onClose}>
      <div className="modal modal-wide fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {target.kind === 'shipment' ? (
            <>
              <h3>Costos · {target.shipment.code}</h3>
              <p>
                {clientFullLabel(target.shipment.client)} · {target.shipment.description}
              </p>
            </>
          ) : (
            <>
              <h3>{target.title}</h3>
              <p>{target.subtitle}</p>
            </>
          )}
        </div>

        <div className="modal-body">
          {notice && <div className="banner ok">{notice}</div>}

          {approved && (
            <div className="banner ok">
              Aprobado el {formatDate(data!.approvedAt!)}
              {data!.approvedByName ? ` por ${data!.approvedByName}` : ''}. La factura quedó congelada.
              Para cambiarla, corrige la proforma desde su detalle.
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="c-rate">
              Tasa de cambio (colones por 1 dólar)
            </label>
            <input
              id="c-rate" className="input" type="number" min="0" step="0.01"
              value={rate} disabled={approved || !canEditRate} placeholder="512.75"
              onChange={(e) => setRate(e.target.value)}
            />
            {/* La vigente es la que manda; la publicada se nombra como lo que es,
                una referencia, para que nadie la lea como "la tasa del sistema". */}
            <div className="field-hint">
              {!canEditRate
                ? 'La tasa de cambio es un valor general del sistema: solo un administrador puede modificarla, en Configuración.'
                : `Viene de la tasa vigente del sistema${
                    data?.globalExchangeRate != null ? ` (${data.globalExchangeRate})` : ''
                  }; puedes ajustarla solo para ${target.kind === 'shipment' ? 'este trámite' : 'esta proforma'}.${
                    data?.referenceExchangeRate != null
                      ? ` Referencia del BCCR hoy: ${data.referenceExchangeRate}.`
                      : ''
                  }`}
            </div>
          </div>

          {/* El boton va ARRIBA porque la fila nueva aparece arriba: el gesto y
              su resultado quedan juntos. El concepto se elige dentro de la fila,
              asi que aqui afuera no hay catalogo que mostrar. */}
          {!approved && (
            <div className="actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={addLine}>
                + Agregar línea
              </button>
            </div>
          )}

          <div className="table-wrap">
            <table className="table table-costs">
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th style={{ width: 130 }}>Costo neto</th>
                  <th style={{ width: 150 }}>Costo a facturar</th>
                  <th style={{ width: 130 }}>Moneda</th>
                  <th style={{ width: 60 }} />
                </tr>
              </thead>
              <tbody>
                {shownLines.map((line) => (
                  <tr key={line.key} className={line.key === lastAdded ? 'is-new' : undefined}>
                    <td>
                      {/* El flete se nombra desde la tarifa del casillero: se muestra, no se digita. */}
                      {line.source === CostLineSource.Freight ? (
                        <>
                          <strong>{line.label}</strong>
                          {freightDetail && <div className="field-hint">{freightDetail}</div>}
                        </>
                      ) : (
                        <>
                          <OptionPicker
                            value={line.pick}
                            options={optionsFor(line)}
                            disabled={approved}
                            ariaLabel="Concepto de la línea"
                            placeholder="Elige el concepto"
                            searchPlaceholder="Escribe para filtrar…"
                            emptyNote="Ningún concepto del catálogo coincide."
                            onChange={(v) => pickService(line.key, v)}
                          />
                          {/* Concepto suelto: el nombre lo escribe el operador. */}
                          {line.pick === CUSTOM_PICK && (
                            <input
                              className="input" value={line.label} disabled={approved}
                              style={{ marginTop: 6 }} placeholder="Nombre del concepto"
                              aria-label="Nombre del concepto"
                              onChange={(e) => patchLine(line.key, { label: e.target.value })}
                            />
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {/* El porcentaje y el monto fijo son del catalogo: se leen.
                          Solo el concepto manual (y el flete) se digitan aqui. */}
                      {line.source === CostLineSource.Percentage ? (
                        <>
                          <strong>{line.percentage || 0}%</strong>
                          <div className="field-hint">Del catálogo</div>
                        </>
                      ) : isAmountEditable(line) ? (
                        <input
                          className="input" type="number" min="0" step="0.01"
                          value={line.amount} disabled={approved}
                          onChange={(e) => patchLine(line.key, { amount: e.target.value })}
                          aria-label={`Monto de ${line.label || 'la línea'}`}
                        />
                      ) : line.pick === '' ? (
                        <span className="muted">Elige el concepto</span>
                      ) : (
                        <>
                          <strong>{formatMoney(Number(line.amount) || 0, line.currency)}</strong>
                          <div className="field-hint">Del catálogo</div>
                        </>
                      )}
                    </td>
                    <td>
                      {/* El facturado nace igual al real y lo sigue hasta que
                          se edita. Vaciarlo lo devuelve a seguir al real. */}
                      {line.source === CostLineSource.Percentage ? (
                        <span className="muted">Calculado</span>
                      ) : line.pick === '' && line.source !== CostLineSource.Freight ? (
                        <span className="muted">-</span>
                      ) : (
                        <>
                          <input
                            className="input" type="number" min="0" step="0.01"
                            value={billedOf(line)} disabled={approved}
                            onChange={(e) =>
                              patchLine(line.key, {
                                billed: e.target.value,
                                billedTouched: e.target.value.trim() !== '',
                              })
                            }
                            aria-label={`Costo a facturar de ${line.label || 'la línea'}`}
                          />
                          {isBilledAdjusted(line) && (
                            <div className="field-hint">
                              {Number(line.billed) > Number(line.amount) ? '+' : '-'}
                              {formatMoney(Math.abs(Number(line.billed) - Number(line.amount)), line.currency)} vs neto
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {line.source === CostLineSource.Percentage ? (
                        <span className="muted">
                          {target.kind === 'proforma' ? '% del subtotal de la proforma' : '% del subtotal'}
                        </span>
                      ) : !isAmountEditable(line) ? (
                        // La moneda del monto fijo tambien viene del catalogo.
                        <span className="muted">
                          {line.pick === '' ? '—' : CURRENCY_LABELS[line.currency]}
                        </span>
                      ) : (
                        <select
                          className="input" value={line.currency} disabled={approved}
                          onChange={(e) => patchLine(line.key, { currency: e.target.value as Currency })}
                          aria-label={`Moneda de ${line.label || 'la línea'}`}
                        >
                          {Object.values(Currency).map((c) => (
                            <option key={c} value={c}>{CURRENCY_LABELS[c]}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {/* El flete es cobro fijo del servicio: se ajusta el monto, no se quita. */}
                      {!approved && line.source !== CostLineSource.Freight && (
                        <IconButton
                          label={`Quitar ${line.label || 'la línea'}`}
                          icon="trash"
                          tone="danger"
                          onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {lines.length === 0 && <div className="empty">Aún no hay líneas de costo.</div>}

          <div className="banner ok" style={{ background: 'var(--paper-2)', color: 'var(--ink)' }}>
            {preview ? (
              <>
                <strong>Total a facturar:</strong> {formatMoney(preview.usd, Currency.USD)} ·{' '}
                {formatMoney(preview.crc, Currency.CRC)}
                {!approved && <span className="muted"> (estimado hasta guardar)</span>}
                {realPreview && (realPreview.usd !== preview.usd || realPreview.crc !== preview.crc) && (
                  <div className="muted">
                    Costo neto: {formatMoney(realPreview.usd, Currency.USD)} ·{' '}
                    {formatMoney(realPreview.crc, Currency.CRC)}
                  </div>
                )}
              </>
            ) : (
              canEditRate
                ? 'Digita la tasa de cambio para ver el total.'
                : 'Sin tasa de cambio vigente no se puede calcular el total.'
            )}
          </div>
        </div>

        <div className="modal-foot modal-foot-compact">
          {/* "Cerrar" y no "Cancelar": lo guardado ya quedo guardado, salir no
              deshace nada. */}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cerrar
          </button>
          {!approved && (
            <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar'}
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
