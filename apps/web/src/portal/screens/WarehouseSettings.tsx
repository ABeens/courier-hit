/**
 * Dirección del casillero de HS Global en Miami, en "Configuración" (permiso
 * config.manage).
 *
 * Es la que el cliente copia al comprar en USA ("Mi casillero", registro, API
 * pública). Es la misma para todos: lo único propio de cada cliente es la línea
 * de Nombre, que no se edita aquí. Se guarda completa, nunca por campos sueltos.
 */
import { useEffect, useState } from 'react';
import type { MiamiWarehouse, MiamiWarehouseSettingDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/datetime';

/** Campos del formulario, en el orden en que se llena un checkout en USA. */
const FIELDS: { key: keyof MiamiWarehouse; label: string; placeholder: string; maxLength: number }[] = [
  { key: 'addressLine1', label: 'Dirección', placeholder: '1350 NW 121 ST Ave', maxLength: 120 },
  { key: 'addressLine2', label: 'Apto / Suite', placeholder: 'Suite 700 SJO 008835', maxLength: 120 },
  { key: 'city', label: 'Ciudad', placeholder: 'Miami', maxLength: 60 },
  { key: 'state', label: 'Estado', placeholder: 'Florida', maxLength: 60 },
  { key: 'zipCode', label: 'Código postal', placeholder: '33182-1542', maxLength: 20 },
  { key: 'country', label: 'País', placeholder: 'USA', maxLength: 60 },
  { key: 'phone', label: 'Teléfono', placeholder: '+1 305 714 0023', maxLength: 40 },
];

export function WarehouseSettings() {
  const [setting, setSetting] = useState<MiamiWarehouseSettingDto | null>(null);
  const [form, setForm] = useState<MiamiWarehouse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<MiamiWarehouseSettingDto>('/settings/miami-warehouse')
      .then((dto) => {
        setSetting(dto);
        setForm(dto.warehouse);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar la dirección del casillero.'),
      );
  }, []);

  const complete = form != null && FIELDS.every((f) => form[f.key].trim() !== '');
  /**
   * Con la dirección de FÁBRICA vigente el botón sigue activo aunque nada cambie:
   * guardar es hacerla propia y deja el rastro de quién la revisó.
   */
  const unchanged =
    setting != null &&
    form != null &&
    !setting.isDefault &&
    FIELDS.every((f) => form[f.key].trim() === setting.warehouse[f.key]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const dto = await api.put<MiamiWarehouseSettingDto>('/settings/miami-warehouse', form);
      setSetting(dto);
      setForm(dto.warehouse);
      setNotice('Dirección del casillero actualizada. Los clientes ya ven la nueva en "Mi casillero".');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la dirección.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form-stack" style={{ marginTop: 18 }}>
      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>
          Casillero de HS Global en Miami
        </div>
        <div className="field-hint">
          {setting == null
            ? 'Cargando…'
            : setting.isDefault
              ? 'Dirección de fábrica: la confirmada por HS Global. Nadie la ha revisado todavía.'
              : `Fijada por ${setting.updatedByName ?? 'un administrador'}${
                  setting.updatedAt ? ` el ${formatDateTime(setting.updatedAt)}` : ''
                }.`}
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      {form && (
        <form className="form-stack" onSubmit={save}>
          <div className="field-pair">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="field-label" htmlFor={`s-wh-${f.key}`}>
                  {f.label}
                </label>
                <input
                  id={`s-wh-${f.key}`} className="input" type="text" maxLength={f.maxLength}
                  value={form[f.key]} placeholder={f.placeholder} disabled={busy}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <div className="field-hint">
            Es la dirección que todos los clientes copian al comprar en Estados Unidos. A cada uno
            se le antepone su nombre y su número de casillero en la línea de Nombre. Un error aquí
            manda paquetes a ninguna parte: cámbiala solo con confirmación escrita de la bodega.
          </div>
          <div>
            <button className="btn btn-primary" type="submit" disabled={busy || !complete || unchanged}>
              {busy ? 'Guardando…' : 'Guardar dirección'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
