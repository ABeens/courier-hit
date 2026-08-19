/**
 * Pantalla "Configuración" (permiso exchange_rate.write para escribir).
 *
 * Ajustes GENERALES del sistema: los valores que se aplican igual a todos los
 * trámites. Hoy la tasa de cambio y la tarifa de transporte internacional; es el
 * sitio donde van a entrar los que vengan, por eso la pantalla se arma por
 * bloques y no como un formulario suelto.
 *
 * Los dos valores se parecen pero no son lo mismo: la tasa CONVIERTE (afecta lo
 * que se le cobra al cliente) y la tarifa de flete es un COSTO nuestro que no
 * aparece en ninguna factura, solo en el margen del reporte. Por eso van en
 * bloques separados y con permisos distintos.
 *
 * La tasa vigente y la de referencia NO son lo mismo y se muestran separadas a
 * propósito: la primera es la que el sistema usa para convertir, la segunda es
 * información para decidirla. La API revalida cada acción.
 */
import { useCallback, useEffect, useState } from 'react';
import { CURRENCY_SYMBOLS, Currency, formatMoney } from '@courier/shared';
import type {
  ExchangeRateHistoryEntryDto,
  ExchangeRateSettingDto,
  FreightRateSettingDto,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatDayInput } from '../lib/datetime';

/**
 * La tasa son colones por 1 USD.
 *
 * NO pasa por `formatMoney`: ese redondea los colones a cero decimales, que es
 * correcto para un IMPORTE (una factura en colones no lleva céntimos) pero no
 * para una TASA, donde los decimales son parte del número (450,40 se veía como
 * ₡450 y ya no era la tasa que publica la fuente ni la que se guarda).
 */
function formatRateAmount(rate: number): string {
  const amount = rate.toLocaleString('es-CR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${CURRENCY_SYMBOLS[Currency.CRC]}${amount}`;
}

/**
 * La misma tasa con su unidad. Se separa de `formatRateAmount` porque en prosa
 * hace falta ("₡450,40 por 1 USD") y en la columna de una tabla estorba: ahi la
 * unidad ya la dice el encabezado y repetirla en cada fila es ruido.
 */
function formatRate(rate: number): string {
  return `${formatRateAmount(rate)} por 1 USD`;
}

/** La tarifa de flete son dólares por libra: dinero en dólares, por unidad de peso. */
function formatFreight(usdPerLb: number): string {
  return `${formatMoney(usdPerLb, Currency.USD)} por libra`;
}

export function SettingsScreen({
  canEdit,
  canEditFreight,
}: {
  canEdit: boolean;
  canEditFreight: boolean;
}) {
  const [setting, setSetting] = useState<ExchangeRateSettingDto | null>(null);
  const [history, setHistory] = useState<ExchangeRateHistoryEntryDto[]>([]);
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
  const [freight, setFreight] = useState<FreightRateSettingDto | null>(null);
  const [freightRate, setFreightRate] = useState('');
  const [freightNote, setFreightNote] = useState('');
  const [savingFreight, setSavingFreight] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const dto = await api.get<ExchangeRateSettingDto>('/settings/exchange-rate');
      setSetting(dto);
      // El campo arranca con la vigente: lo normal es corregirla, no digitarla
      // de cero, y así se ve de una que cambiarla es reemplazar un valor.
      setRate(dto.rate != null ? String(dto.rate) : '');
      setError(null);
      // El historial es auditoría: solo lo puede leer quien fija la tasa.
      if (canEdit) {
        const log = await api.get<{ items: ExchangeRateHistoryEntryDto[] }>(
          '/settings/exchange-rate/history',
        );
        setHistory(log.items);
      }

      const freightDto = await api.get<FreightRateSettingDto>('/settings/freight-rate');
      setFreight(freightDto);
      setFreightRate(freightDto.usdPerLb != null ? String(freightDto.usdPerLb) : '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la configuración.');
    }
  }, [canEdit]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = Number(rate);
  const rateOk = rate.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  const unchanged = setting?.rate != null && parsed === setting.rate;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!rateOk) {
      setError('Digita la tasa de cambio (colones por 1 dólar).');
      return;
    }
    setSaving(true);
    try {
      await api.put<ExchangeRateSettingDto>('/settings/exchange-rate', {
        rate: parsed,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote('');
      setNotice(`Tasa de cambio actualizada: ${formatRate(parsed)}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la tasa.');
    } finally {
      setSaving(false);
    }
  }

  const parsedFreight = Number(freightRate);
  const freightOk = freightRate.trim() !== '' && Number.isFinite(parsedFreight) && parsedFreight > 0;
  const freightUnchanged = freight?.usdPerLb != null && parsedFreight === freight.usdPerLb;

  async function saveFreight(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!freightOk) {
      setError('Digita la tarifa de transporte internacional (dólares por libra).');
      return;
    }
    setSavingFreight(true);
    try {
      await api.put<FreightRateSettingDto>('/settings/freight-rate', {
        usdPerLb: parsedFreight,
        ...(freightNote.trim() ? { note: freightNote.trim() } : {}),
      });
      setFreightNote('');
      setNotice(`Tarifa de transporte internacional actualizada: ${formatFreight(parsedFreight)}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la tarifa.');
    } finally {
      setSavingFreight(false);
    }
  }

  const reference = setting?.reference;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Configuración</div>
          <div className="count">Valores generales que el sistema aplica a todos los trámites</div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="card form-stack">
        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Tasa de cambio vigente
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--ink)' }}>
            {setting?.rate != null ? formatRate(setting.rate) : 'Sin definir'}
          </div>
          <div className="field-hint">
            {setting?.rate != null
              ? `Fijada por ${setting.updatedByName ?? 'un administrador'}${
                  setting.updatedAt ? ` el ${formatDateTime(setting.updatedAt)}` : ''
                }.`
              : 'Mientras no haya una tasa vigente no se pueden cargar costos ni registrar pagos.'}
          </div>
        </div>

        {/* Referencia: informa, no manda. Va separada del valor vigente para que
            no se lea como "la tasa del sistema". */}
        <div className="banner info">
          {reference?.rate != null ? (
            <>
              Hacienda publica hoy
              {reference.day ? `, ${formatDayInput(reference.day)},` : ''} un tipo de cambio de venta
              de <strong>{formatRate(reference.rate)}</strong>. El sistema sigue convirtiendo con la
              tasa vigente de arriba.
              {canEdit && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setRate(String(reference.rate))}
                  >
                    Usar esta
                  </button>
                </>
              )}
            </>
          ) : (
            'No hay tipo de cambio de referencia disponible ahora mismo.'
          )}
        </div>

        {canEdit ? (
          <form className="form-stack" onSubmit={save}>
            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="s-rate">
                  Nueva tasa (colones por 1 dólar)
                </label>
                <input
                  id="s-rate" className="input" type="number" min="0" step="0.01"
                  value={rate} placeholder="512.75" disabled={saving}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="s-note">
                  Nota (opcional)
                </label>
                <input
                  id="s-note" className="input" type="text" maxLength={200}
                  value={note} placeholder="Por qué se cambia" disabled={saving}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
            <div className="field-hint">
              Los trámites que ya tienen costos cargados conservan la tasa con la que se
              cotizaron: cambiarla aquí afecta a las cargas nuevas.
            </div>
            <div>
              <button className="btn btn-primary" type="submit" disabled={saving || !rateOk || unchanged}>
                {saving ? 'Guardando…' : 'Guardar tasa'}
              </button>
            </div>
          </form>
        ) : (
          <div className="field-hint">
            La tasa de cambio es un valor general del sistema: solo un administrador puede
            modificarla.
          </div>
        )}
      </div>

      {/* Tarifa de transporte internacional: el otro valor general del sistema.
          Es lo que a HS Global le CUESTA traer una libra, no lo que cobra, y de
          ahí sale el margen del reporte de Paquetería. */}
      <div className="card form-stack" style={{ marginTop: 18 }}>
        <div>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Transporte internacional (costo por libra)
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--ink)' }}>
            {freight?.usdPerLb != null ? formatFreight(freight.usdPerLb) : 'Sin definir'}
          </div>
          <div className="field-hint">
            {freight?.usdPerLb != null
              ? `Fijada por ${freight.updatedByName ?? 'un administrador'}${
                  freight.updatedAt ? ` el ${formatDateTime(freight.updatedAt)}` : ''
                }.`
              : 'Sin esta tarifa el reporte de Paquetería no puede calcular el costo del flete ni el margen.'}
          </div>
        </div>

        {canEditFreight ? (
          <form className="form-stack" onSubmit={saveFreight}>
            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="s-freight">
                  Nueva tarifa (dólares por libra)
                </label>
                <input
                  id="s-freight" className="input" type="number" min="0" step="0.01"
                  value={freightRate} placeholder="3.66" disabled={savingFreight}
                  onChange={(e) => setFreightRate(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="s-freight-note">
                  Nota (opcional)
                </label>
                <input
                  id="s-freight-note" className="input" type="text" maxLength={200}
                  value={freightNote} placeholder="Por qué se cambia" disabled={savingFreight}
                  onChange={(e) => setFreightNote(e.target.value)}
                />
              </div>
            </div>
            <div className="field-hint">
              Los trámites ya facturados conservan la tarifa con la que se cerraron: cambiarla
              aquí no reescribe el margen de los meses anteriores.
            </div>
            <div>
              <button
                className="btn btn-primary" type="submit"
                disabled={savingFreight || !freightOk || freightUnchanged}
              >
                {savingFreight ? 'Guardando…' : 'Guardar tarifa'}
              </button>
            </div>
          </form>
        ) : (
          <div className="field-hint">
            La tarifa de transporte internacional es un valor general del sistema: solo un
            administrador puede modificarla.
          </div>
        )}
      </div>

      {canEdit && (
        <>
          <div className="head-row" style={{ marginTop: 26 }}>
            <div>
              <div className="title">Historial de la tasa</div>
              <div className="count">Cada cambio, con quién lo hizo y cuándo</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tasa</th>
                  <th>Anterior</th>
                  <th>Quién</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.setAt)}</td>
                    <td>{formatRateAmount(row.rate)}</td>
                    <td>{row.previousRate != null ? formatRateAmount(row.previousRate) : '—'}</td>
                    <td>{row.setByName ?? '—'}</td>
                    <td>{row.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.length === 0 && <div className="empty">Todavía no se ha fijado ninguna tasa.</div>}
        </>
      )}
    </div>
  );
}
