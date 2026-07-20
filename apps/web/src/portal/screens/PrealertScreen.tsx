/**
 * Prealerta del titular del casillero ("Requerimientos Parte 2 - Portal Cliente",
 * L45-71). Un selector de Tramite que arranca SIEMPRE en Paqueteria y, al
 * cambiarlo, reduce el formulario a lo que ese tipo necesita:
 *   - Paqueteria                  -> tienda, transportista, tracking, descripcion.
 *   - Transporte / Agenciamiento  -> solo guia (AWB/BL) y descripcion (REF).
 *
 * El dueño de la prealerta NO se elige: lo pone la API desde la sesion.
 */
import { useState } from 'react';
import {
  CARRIERS,
  MANUAL_SHIPMENT_TYPES,
  SHIPMENT_TYPE_LABELS,
  STORES,
  ShipmentType,
  prealertShipmentSchema,
  usesPackageFields,
} from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';

/** Paqueteria primero: es el caso por defecto del requisito. */
const TYPE_OPTIONS: ShipmentType[] = [ShipmentType.Paqueteria, ...MANUAL_SHIPMENT_TYPES];

export function PrealertScreen({ onCreated }: { onCreated?: () => void }) {
  const [shipmentType, setShipmentType] = useState<ShipmentType>(ShipmentType.Paqueteria);
  const [tracking, setTracking] = useState('');
  const [description, setDescription] = useState('');
  const [store, setStore] = useState('');
  const [carrier, setCarrier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ShipmentDto | null>(null);
  const [busy, setBusy] = useState(false);

  const isPackage = usesPackageFields(shipmentType);

  function reset() {
    setTracking('');
    setDescription('');
    setStore('');
    setCarrier('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const parsed = prealertShipmentSchema.safeParse({
        shipmentType,
        tracking,
        description,
        ...(isPackage ? { store: store || undefined, carrier: carrier || undefined } : {}),
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
        setBusy(false);
        return;
      }
      const result = await api.post<ShipmentDto>('/shipments/prealert', parsed.data);
      setCreated(result);
      reset();
      onCreated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar la prealerta.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Prealertar un trámite</div>
          <div className="count">Avísanos qué viene en camino para darle seguimiento.</div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {created && (
        <div className="banner ok" style={{ marginBottom: 14 }}>
          Prealerta registrada con el consecutivo <strong>{created.code}</strong> ({created.tracking}).
          Puedes seguir su estado en «Mis trámites».
        </div>
      )}

      <form className="card" onSubmit={submit} style={{ maxWidth: 620, display: 'grid', gap: 14 }}>
        <div>
          <label className="field-label" htmlFor="p-type">Trámite</label>
          <select
            id="p-type" className="input" value={shipmentType}
            onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{SHIPMENT_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="p-tracking">
            {isPackage ? 'Tracking' : 'Tracking (AWB / BL)'}
          </label>
          <input
            id="p-tracking" className="input" value={tracking}
            placeholder={isPackage ? '1Z999AA10123456784' : 'FLO-26-0755'}
            onChange={(e) => setTracking(e.target.value)}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="p-desc">Descripción (REF)</label>
          <input
            id="p-desc" className="input" value={description}
            placeholder={isPackage ? 'Audífonos bluetooth' : 'CHEVROLET SPARK VIN583378'}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {isPackage && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="field-label" htmlFor="p-store">Tienda</label>
              <select id="p-store" className="input" value={store} onChange={(e) => setStore(e.target.value)}>
                <option value="">Elige…</option>
                {STORES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="p-carrier">Transportista</label>
              <select id="p-carrier" className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">Elige…</option>
                {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
        )}

        <div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Registrando…' : 'Prealertar'}
          </button>
        </div>
      </form>
    </div>
  );
}
