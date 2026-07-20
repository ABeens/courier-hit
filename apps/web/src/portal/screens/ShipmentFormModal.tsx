/**
 * Modal de alta / edicion de tramites por el administrador
 * (docs/manuales/flujo.md L73-121).
 *
 * El TIPO de tramite manda sobre el formulario:
 *   - Paqueteria       -> tienda, transportista, HAWB/HBL y peso.
 *   - Transporte y Ag. -> notas para facturar; almacen y DUA solo al EDITAR,
 *                         porque el manual los pide despues de guardar (L80-83).
 *
 * Los tipos ofrecidos dependen del rol: quien solo tiene package.write ve
 * Paqueteria; quien tiene tramite.manage ve los manuales. La API revalida.
 */
import { useCallback, useEffect, useState } from 'react';
import { ModalOverlay } from '../components/ModalOverlay';
import {
  MANUAL_SHIPMENT_TYPES,
  Permission,
  SHIPMENT_TYPE_LABELS,
  ShipmentType,
  STORES,
  CARRIERS,
  can,
  createShipmentSchema,
  updateShipmentSchema,
  usesPackageFields,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';

interface ClientOption {
  id: string;
  code: string;
  name: string;
  idNumber: string;
}

interface Props {
  mode: 'create' | 'edit';
  role: Role;
  row?: ShipmentDto;
  onClose: () => void;
  onSaved: (message?: string) => void;
}

/** Tipos que el rol puede dar de alta, en el orden del manual. */
function allowedTypesFor(role: Role): ShipmentType[] {
  const types: ShipmentType[] = [];
  if (can(role, Permission.PackageWrite)) types.push(ShipmentType.Paqueteria);
  if (can(role, Permission.TramiteManage)) types.push(...MANUAL_SHIPMENT_TYPES);
  return types;
}

export function ShipmentFormModal({ mode, role, row, onClose, onSaved }: Props) {
  const typeOptions = allowedTypesFor(role);

  const [shipmentType, setShipmentType] = useState<ShipmentType>(
    row?.shipmentType ?? typeOptions[0] ?? ShipmentType.Paqueteria,
  );
  const [clientId, setClientId] = useState(row?.client.id ?? '');
  const [clientQuery, setClientQuery] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [tracking, setTracking] = useState(row?.tracking ?? '');
  const [description, setDescription] = useState(row?.description ?? '');
  const [store, setStore] = useState(row?.store ?? '');
  const [carrier, setCarrier] = useState(row?.carrier ?? '');
  const [hawb, setHawb] = useState(row?.hawb ?? '');
  const [weight, setWeight] = useState(row?.weightKg != null ? String(row.weightKg) : '');
  const [billingNotes, setBillingNotes] = useState(row?.billingNotes ?? '');
  const [warehouse, setWarehouse] = useState(row?.warehouse ?? '');
  const [dua, setDua] = useState(row?.dua ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isPackage = usesPackageFields(shipmentType);

  const loadClients = useCallback(async () => {
    if (mode === 'edit') return; // el cliente de un tramite no se reasigna aqui
    const qs = clientQuery.trim() ? `?q=${encodeURIComponent(clientQuery.trim())}` : '';
    try {
      const res = await api.get<{ items: ClientOption[] }>(`/clients${qs}`);
      setClients(res.items);
    } catch {
      setClients([]); // el error se vera al enviar; no bloqueamos el formulario
    }
  }, [clientQuery, mode]);

  useEffect(() => {
    const t = setTimeout(loadClients, 250); // debounce de la busqueda
    return () => clearTimeout(t);
  }, [loadClients]);

  /** El peso se redondea hacia arriba al guardar; se avisa antes de enviar. */
  const weightPreview =
    isPackage && weight && Number(weight) > 0 && !Number.isInteger(Number(weight))
      ? Math.ceil(Number(weight))
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'create') {
        const parsed = createShipmentSchema.safeParse({
          clientId,
          shipmentType,
          tracking,
          description,
          ...(isPackage
            ? {
                store: store || undefined,
                carrier: carrier || undefined,
                hawb: hawb.trim() || undefined,
                weightKg: weight ? Number(weight) : undefined,
              }
            : { billingNotes: billingNotes.trim() || undefined }),
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        const created = await api.post<ShipmentDto>('/shipments', parsed.data);
        onSaved(`Trámite ${created.code} creado.`);
        return;
      }

      if (!row) return;
      // Editar: solo lo que cambio. `null` limpia el campo en la API.
      const patch: Record<string, unknown> = {};
      const put = (key: string, next: string, prev: string | null) => {
        const value = next.trim() || null;
        if (value !== prev) patch[key] = value;
      };
      if (tracking.trim().toUpperCase() !== row.tracking) patch.tracking = tracking.trim().toUpperCase();
      if (description.trim() !== row.description) patch.description = description.trim();
      if (isPackage) {
        if ((store || null) !== row.store) patch.store = store || null;
        if ((carrier || null) !== row.carrier) patch.carrier = carrier || null;
        put('hawb', hawb, row.hawb);
        const nextWeight = weight ? Number(weight) : null;
        if (nextWeight !== row.weightKg) patch.weightKg = nextWeight;
      } else {
        put('warehouse', warehouse, row.warehouse);
        put('dua', dua, row.dua);
        put('billingNotes', billingNotes, row.billingNotes);
      }

      if (Object.keys(patch).length === 0) {
        onSaved();
        return;
      }
      const check = updateShipmentSchema.safeParse(patch);
      if (!check.success) {
        setError(check.error.issues[0]?.message ?? 'Datos inválidos.');
        setBusy(false);
        return;
      }
      await api.patch(`/shipments/${row.id}`, patch);
      onSaved(`Trámite ${row.code} actualizado.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal modal-lg fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Nuevo trámite' : `Editar trámite ${row?.code}`}</h3>
          <p>
            {isPackage
              ? 'Paquete comprado en USA que llega por la bodega de Miami.'
              : 'Trámite de transporte o agenciamiento, gestionado manualmente.'}
          </p>
        </div>

        <div className="modal-body modal-form">
          {error && <div className="banner err col-full">{error}</div>}

          <div>
            <label className="field-label" htmlFor="t-type">Trámite</label>
            <select
              id="t-type" className="input" value={shipmentType} disabled={mode === 'edit'}
              onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>{SHIPMENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
            {mode === 'edit' && (
              <div className="field-hint">
                El tipo no se cambia: movería el trámite a otra máquina de estados y su historial
                perdería sentido.
              </div>
            )}
          </div>

          {mode === 'create' ? (
            <div className="col-full">
              <label className="field-label" htmlFor="t-client">Cliente</label>
              <input
                className="input" placeholder="Buscar por nombre, casillero o cédula…"
                value={clientQuery} onChange={(e) => setClientQuery(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <select
                id="t-client" className="input" value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Elige un cliente…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name} ({c.idNumber})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="col-full">
              <label className="field-label">Cliente</label>
              <div className="input" style={{ background: 'var(--paper-2)' }}>
                {row?.client.code} — {row?.client.name}
              </div>
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="t-tracking">
              {isPackage ? 'Tracking' : 'Tracking (AWB / BL)'}
            </label>
            <input
              id="t-tracking" className="input" value={tracking}
              placeholder={isPackage ? '1Z999AA10123456784' : 'FLO-26-0755'}
              onChange={(e) => setTracking(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="t-desc">Descripción (REF)</label>
            <input
              id="t-desc" className="input" value={description}
              placeholder={isPackage ? 'Audífonos bluetooth' : 'CHEVROLET SPARK VIN583378'}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {isPackage ? (
            <>
              <div>
                <label className="field-label" htmlFor="t-store">Tienda</label>
                <select id="t-store" className="input" value={store} onChange={(e) => setStore(e.target.value)}>
                  <option value="">Elige…</option>
                  {STORES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="t-carrier">Transportista</label>
                <select id="t-carrier" className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                  <option value="">Elige…</option>
                  {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div>
                <label className="field-label" htmlFor="t-hawb">HAWB / HBL</label>
                <input
                  id="t-hawb" className="input" inputMode="numeric" value={hawb}
                  placeholder="Solo números" onChange={(e) => setHawb(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="t-weight">Peso (kg)</label>
                <input
                  id="t-weight" className="input" type="number" min="0" step="0.01" value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
                {weightPreview !== null && (
                  <div className="field-hint">Se guardará como {weightPreview} kg (siempre redondea hacia arriba).</div>
                )}
              </div>
            </>
          ) : (
            <>
              {mode === 'edit' && (
                <>
                  <div>
                    <label className="field-label" htmlFor="t-warehouse">Almacén</label>
                    <input
                      id="t-warehouse" className="input" value={warehouse}
                      onChange={(e) => setWarehouse(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="t-dua">DUA</label>
                    <input
                      id="t-dua" className="input" value={dua} placeholder="###-####-######"
                      onChange={(e) => setDua(e.target.value)}
                    />
                  </div>
                </>
              )}
              <div className="col-full">
                <label className="field-label" htmlFor="t-notes">Notas para facturar</label>
                <textarea
                  id="t-notes" className="input" rows={3} value={billingNotes}
                  onChange={(e) => setBillingNotes(e.target.value)}
                />
              </div>
              {mode === 'create' && (
                <div className="banner ok col-full" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
                  El almacén y el DUA se completan al editar el trámite, una vez guardado.
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Crear trámite' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
