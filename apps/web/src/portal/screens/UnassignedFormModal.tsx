/**
 * Alta y corrección de un paquete SIN DUEÑO — permiso control_room.manage.
 *
 * Es el formulario de la sala de control, y va aparte de `ShipmentFormModal` por
 * dos motivos de fondo, no de estilo:
 *
 *   - NO PIDE CLIENTE. El alta normal empieza eligiendo casillero; aquí el
 *     casillero es justo lo que no se sabe, y ponerlo como campo obligatorio
 *     empujaría al operador a asignárselo a cualquiera para poder guardar.
 *   - NO CONGELA CAMPOS POR ESTADO. El paquete nace en «Facturación en proceso»,
 *     donde la máquina ya bloquea tracking, HAWB, tienda y transportista: justo
 *     los que hay que poder corregir mientras se averigua de quién es la caja.
 *     La API abre esa ventana solo mientras el paquete no tiene dueño.
 *
 * Todo es opcional menos la descripción, que es lo único con lo que un humano va
 * a reconocer el bulto en la estantería cuando aparezca su dueño.
 */
import { useState } from 'react';
import {
  CARRIERS,
  STORES,
  correctUnassignedShipmentSchema,
  knownTracking,
  registerUnassignedShipmentSchema,
} from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  mode: 'create' | 'edit';
  /** En 'create', LES ya escaneado en recepción del que venimos (si lo hay). */
  initialHawb?: string;
  row?: ShipmentDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/** Texto vacío -> `undefined` (no mandar) en el alta. */
const orUndefined = (value: string) => (value.trim() ? value.trim() : undefined);

/**
 * Texto vacío -> `null` (limpiar el campo) en la corrección. La diferencia con el
 * alta importa: en un PATCH, `undefined` significa "no lo toques" y `null`
 * significa "bórralo", y borrar una tienda mal anotada tiene que ser posible.
 */
const orNull = (value: string) => (value.trim() ? value.trim() : null);

export function UnassignedFormModal({ mode, initialHawb, row, onClose, onSaved }: Props) {
  const [description, setDescription] = useState(row?.description ?? '');
  // En la ficha el tracking sembrado se muestra vacío: no es una guía real.
  const [tracking, setTracking] = useState(row ? (knownTracking(row) ?? '') : '');
  const [hawb, setHawb] = useState(row?.hawb ?? initialHawb ?? '');
  const [store, setStore] = useState(row?.store ?? '');
  const [carrier, setCarrier] = useState(row?.carrier ?? '');
  const [weight, setWeight] = useState(row?.weightKg != null ? String(row.weightKg) : '');
  const [declaredValue, setDeclaredValue] = useState(
    row?.declaredValueUsd != null ? String(row.declaredValueUsd) : '',
  );
  const [notes, setNotes] = useState(row?.billingNotes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * El peso se guarda tal cual; el redondeo hacia arriba es una regla de cobro de
   * las tarifas estandar. Se avisa del kilaje que se cobraria con una de ellas.
   */
  const weightPreview =
    weight && Number(weight) > 0 && !Number.isInteger(Number(weight))
      ? Math.ceil(Number(weight))
      : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (mode === 'create') {
        const parsed = registerUnassignedShipmentSchema.safeParse({
          description,
          tracking: orUndefined(tracking),
          hawb: orUndefined(hawb),
          store: orUndefined(store),
          carrier: orUndefined(carrier),
          weightKg: weight ? Number(weight) : undefined,
          declaredValueUsd: declaredValue ? Number(declaredValue) : undefined,
          billingNotes: orUndefined(notes),
        });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Datos inválidos.');

        const saved = await api.post<ShipmentDto>('/shipments/unassigned', parsed.data);
        onSaved(`${saved.code} registrado sin dueño. Asígnalo cuando sepas de quién es.`);
        return;
      }

      if (!row) throw new Error('No hay paquete que corregir.');
      const parsed = correctUnassignedShipmentSchema.safeParse({
        description,
        // El tracking no admite `null`: la columna es obligatoria. Vaciarlo aquí
        // significa "sigo sin conocerlo", así que no se manda.
        ...(tracking.trim() ? { tracking: tracking.trim() } : {}),
        hawb: orNull(hawb),
        store: orNull(store),
        carrier: orNull(carrier),
        weightKg: weight ? Number(weight) : null,
        declaredValueUsd: declaredValue ? Number(declaredValue) : null,
        billingNotes: orNull(notes),
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Datos inválidos.');

      await api.patch<ShipmentDto>(`/shipments/unassigned/${row.id}`, parsed.data);
      onSaved(`${row.code} actualizado.`);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'No se pudo guardar el paquete.',
      );
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Registrar paquete sin dueño' : `Corregir ${row?.code}`}</h3>
          <p>
            {mode === 'create'
              ? 'Un bulto que apareció en bodega y que nadie anunció. Anota lo que se pueda leer de la caja.'
              : 'Mientras no tenga dueño, todos los datos siguen abiertos.'}
          </p>
        </div>

        <div className="modal-body modal-form">
          {error && <div className="banner err col-full">{error}</div>}

          <div className="col-full">
            <label className="field-label" htmlFor="u-description">Descripción del bulto</label>
            <input
              id="u-description"
              className="input"
              maxLength={200}
              value={description}
              placeholder="Caja mediana Amazon, cinta azul, sin factura visible…"
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="field-hint">
              Obligatorio: es con lo que se va a reconocer la caja en la estantería.
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="u-hawb">HAWB (LES)</label>
            <input
              id="u-hawb"
              className="input mono"
              maxLength={30}
              value={hawb}
              placeholder="LES48450141"
              onChange={(e) => setHawb(e.target.value.toUpperCase())}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="u-tracking">Tracking</label>
            <input
              id="u-tracking"
              className="input mono"
              maxLength={40}
              value={tracking}
              placeholder="Si la etiqueta lo trae"
              onChange={(e) => setTracking(e.target.value.toUpperCase())}
            />
            <div className="field-hint">
              Opcional. Sin guía legible el paquete se identifica por su consecutivo.
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="u-store">Tienda</label>
            <select id="u-store" className="input" value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">Sin identificar</option>
              {STORES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="u-carrier">Transportista</label>
            <select id="u-carrier" className="input" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
              <option value="">Sin identificar</option>
              {CARRIERS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="u-weight">Peso (kg)</label>
            <input
              id="u-weight"
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
            {weightPreview !== null && (
              <div className="field-hint">
                Se guarda el peso real. Las tarifas estándar cobran {weightPreview} kg;
                las consolidadas, el peso tal cual.
              </div>
            )}
          </div>

          <div>
            <label className="field-label" htmlFor="u-declared">Valor declarado (USD)</label>
            <input
              id="u-declared"
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={declaredValue}
              onChange={(e) => setDeclaredValue(e.target.value)}
            />
            <div className="field-hint">Si la caja trae factura por fuera.</div>
          </div>

          <div className="col-full">
            <label className="field-label" htmlFor="u-notes">Notas de bodega</label>
            <textarea
              id="u-notes"
              className="input"
              rows={3}
              maxLength={500}
              value={notes}
              placeholder="Estante B3. Etiqueta rota, solo se lee «…MARTÍNEZ». Llegó con el consolidado del 3 de agosto."
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="field-hint">
              Lo que ayude a dar con el dueño: dónde está guardado, qué se alcanza a leer, con qué
              carga llegó.
            </div>
          </div>

          {mode === 'create' && (
            <div className="banner col-full" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
              El paquete entra en «Facturación en proceso» —ya está en la bodega— pero no avanza,
              no se cotiza y no se cobra hasta que tenga dueño. No se le avisa nada al operador de
              Miami: este bulto ya cruzó.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Guardando…' : mode === 'create' ? 'Registrar paquete' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
