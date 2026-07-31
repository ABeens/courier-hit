/**
 * Pantalla "Configuración" (permiso exchange_rate.write para escribir).
 *
 * Ajustes GENERALES del sistema: los valores que se aplican igual a todos los
 * trámites. Hoy solo la tasa de cambio; es el sitio donde van a entrar los que
 * vengan, por eso la pantalla se arma por bloques y no como un formulario suelto.
 *
 * La tasa vigente y la del BCCR NO son lo mismo y se muestran separadas a
 * propósito: la primera es la que el sistema usa para convertir, la segunda es
 * información para decidirla. La API revalida cada acción.
 */
import { useCallback, useEffect, useState } from 'react';
import { Currency, formatMoney } from '@courier/shared';
import type { ExchangeRateHistoryEntryDto, ExchangeRateSettingDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/datetime';

/** La tasa son colones por 1 USD: se muestra como dinero en colones. */
function formatRate(rate: number): string {
  return `${formatMoney(rate, Currency.CRC)} por 1 USD`;
}

export function SettingsScreen({ canEdit }: { canEdit: boolean }) {
  const [setting, setSetting] = useState<ExchangeRateSettingDto | null>(null);
  const [history, setHistory] = useState<ExchangeRateHistoryEntryDto[]>([]);
  const [rate, setRate] = useState('');
  const [note, setNote] = useState('');
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
              Referencia del BCCR
              {reference.date ? ` (${formatDate(reference.date)})` : ''}:{' '}
              <strong>{formatRate(reference.rate)}</strong>. Es solo referencia: el sistema convierte
              con la tasa vigente de arriba.
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
            'No hay referencia del BCCR disponible ahora mismo.'
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
                    <td>{formatMoney(row.rate, Currency.CRC)}</td>
                    <td>
                      {row.previousRate != null ? formatMoney(row.previousRate, Currency.CRC) : '—'}
                    </td>
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
