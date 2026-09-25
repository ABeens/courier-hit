/**
 * Ajustes del modulo de proformas en "Configuración" (permiso config.manage):
 *
 *   - HORA DE LOS CORREOS DIARIOS al cliente (decision P16). Todos los avisos de
 *     cambios salen en un solo correo al dia a esta hora, en hora de Costa Rica.
 *   - SIGUIENTE NUMERO DE PROFORMA. La serie se asigna al aprobar y no tiene
 *     huecos; el arranque se fija antes de salir a produccion y nunca puede quedar
 *     por debajo del ultimo emitido (P15).
 */
import { useEffect, useState } from 'react';
import type { DailyDigestSettingDto, ProformaCounterDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/datetime';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'a. m.' : 'p. m.';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${suffix}`;
}

export function ProformaSettings() {
  const [digest, setDigest] = useState<DailyDigestSettingDto | null>(null);
  const [counter, setCounter] = useState<ProformaCounterDto | null>(null);
  const [hour, setHour] = useState('6');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<DailyDigestSettingDto>('/settings/daily-digest'),
      api.get<ProformaCounterDto>('/proformas/counter'),
    ])
      .then(([d, c]) => {
        setDigest(d);
        setHour(String(d.hour));
        setCounter(c);
        setNext(String(c.nextNumber));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'No se pudieron cargar los ajustes de proformas.'));
  }, []);

  async function saveHour(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const d = await api.put<DailyDigestSettingDto>('/settings/daily-digest', { hour: Number(hour) });
      setDigest(d);
      setNotice(`El correo diario saldrá a las ${hourLabel(d.hour)}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la hora.');
    } finally {
      setBusy(false);
    }
  }

  async function saveCounter(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const c = await api.put<ProformaCounterDto>('/proformas/counter', { nextNumber: Number(next) });
      setCounter(c);
      setNotice(`La próxima proforma aprobada será la ${c.nextNumber}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el número.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-stack" style={{ marginTop: 18 }}>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <form className="form-stack" onSubmit={saveHour}>
        <div>
          <label className="field-label" htmlFor="s-digest-hour">Hora del correo diario al cliente</label>
          <select id="s-digest-hour" className="input" value={hour} disabled={busy} onChange={(e) => setHour(e.target.value)}>
            {HOURS.map((h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </select>
          <div className="field-hint">
            Hora de Costa Rica. A esta hora le llegan al cliente el reporte de sus trámites en curso y, si tiene
            paquetes en Recibido en Miami, En Aduanas o En ruta de entrega, el de todos sus paquetes en proceso.
            {digest?.lastRunAt && ` El último salió el ${formatDateTime(digest.lastRunAt)}.`}
          </div>
        </div>
        <div>
          <button className="btn btn-primary" type="submit" disabled={busy || !digest || Number(hour) === digest.hour}>
            Guardar hora
          </button>
        </div>
      </form>

      <form className="form-stack" onSubmit={saveCounter}>
        <div>
          <label className="field-label" htmlFor="s-proforma-next">Siguiente número de proforma</label>
          <input
            id="s-proforma-next" className="input" type="number" min={1} step={1}
            value={next} disabled={busy} onChange={(e) => setNext(e.target.value)}
          />
          <div className="field-hint">
            El número se asigna al aprobar la proforma, sin saltos.
            {counter?.lastIssued != null
              ? ` La última emitida es la ${counter.lastIssued}: el siguiente tiene que ser mayor.`
              : ' Todavía no se ha aprobado ninguna.'}
          </div>
        </div>
        <div>
          <button
            className="btn btn-primary" type="submit"
            disabled={busy || !counter || !Number.isInteger(Number(next)) || Number(next) === counter.nextNumber}
          >
            Guardar número
          </button>
        </div>
      </form>
    </div>
  );
}
