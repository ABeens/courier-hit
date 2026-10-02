/**
 * Modal de alta / edicion de tramites por el administrador
 * (docs/manuales/flujo.md L73-121).
 *
 * El TIPO de tramite manda sobre el formulario:
 *   - Paqueteria       -> tienda, transportista, HAWB (LES) y peso. El
 *                         contenido y las notas del proveedor solo se
 *                         muestran: los escribe la sincronizacion con el.
 *   - Transporte y Ag. -> notas para facturar; almacen y DUA solo al EDITAR,
 *                         porque el manual los pide despues de guardar (L80-83).
 *
 * Los tipos ofrecidos dependen del rol (quien solo tiene package.write ve
 * Paqueteria; quien tiene tramite.manage ve los manuales) Y del tablero desde
 * el que se abre el modal. La API revalida.
 */
import { useState } from 'react';
import { ClientPicker } from '../components/ClientPicker';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import {
  DOCUMENT_ATTACHMENT,
  MANUAL_SHIPMENT_TYPES,
  Permission,
  SHIPMENT_TYPE_LABELS,
  ShipmentField,
  ShipmentType,
  STATE_LABELS,
  STORES,
  CARRIERS,
  CLIENT_RATE_KIND_LABELS,
  attachmentRejection,
  can,
  clientFullLabel,
  createShipmentSchema,
  displayedWeightKg,
  editableFieldsAt,
  formatDua,
  updateShipmentSchema,
  usesPackageFields,
} from '@courier/shared';
import type { Role, ShipmentDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { useErrorToast } from '../lib/toast';

interface Props {
  mode: 'create' | 'edit';
  role: Role;
  /** Tipos del tablero desde el que se abre (vacio = tablero mixto, sin acotar). */
  boardTypes?: readonly ShipmentType[];
  row?: ShipmentDto;
  onClose: () => void;
  onSaved: (message?: string) => void;
}

/**
 * Tipos que se pueden dar de alta aqui, en el orden del manual: los que el rol
 * tiene permitidos, acotados a los del tablero de origen.
 *
 * El tablero manda porque un alta fuera de su filtro desaparece de la lista al
 * guardar (el listado pide `shipmentType`): crear un aereo desde Paqueteria
 * dejaba el trámite invisible en la pantalla donde se creo. Tablero mixto
 * ('todos') no acota nada. La API revalida el permiso por tipo.
 */
export function allowedTypesFor(role: Role, boardTypes: readonly ShipmentType[] = []): ShipmentType[] {
  const types: ShipmentType[] = [];
  if (can(role, Permission.PackageWrite)) types.push(ShipmentType.Paqueteria);
  if (can(role, Permission.TramiteManage)) types.push(...MANUAL_SHIPMENT_TYPES);
  return boardTypes.length > 0 ? types.filter((t) => boardTypes.includes(t)) : types;
}

const countDigits = (text: string) => text.replace(/\D/g, '').length;

/**
 * Posicion del cursor justo despues del digito n-esimo de un valor con mascara.
 * Es el ancla estable al reformatear: los guiones se mueven, los digitos no.
 */
function caretAfterDigits(value: string, digits: number): number {
  if (digits <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] >= '0' && value[i] <= '9' && ++seen === digits) return i + 1;
  }
  return value.length;
}

export function ShipmentFormModal({ mode, role, boardTypes, row, onClose, onSaved }: Props) {
  const typeOptions = allowedTypesFor(role, boardTypes);

  const [shipmentType, setShipmentType] = useState<ShipmentType>(
    row?.shipmentType ?? typeOptions[0] ?? ShipmentType.Paqueteria,
  );
  // `row.client` puede venir vacío (paquete sin dueño), aunque esos no se editan
  // desde aquí sino desde la sala de control.
  const [clientId, setClientId] = useState(row?.client?.id ?? '');
  const [tracking, setTracking] = useState(row?.tracking ?? '');
  const [description, setDescription] = useState(row?.description ?? '');
  const [store, setStore] = useState(row?.store ?? '');
  const [carrier, setCarrier] = useState(row?.carrier ?? '');
  const [hawb, setHawb] = useState(row?.hawb ?? '');
  const [weight, setWeight] = useState(row?.weightKg != null ? String(row.weightKg) : '');
  const [declaredValue, setDeclaredValue] = useState(row?.declaredValueUsd != null ? String(row.declaredValueUsd) : '');
  const [insuredValue, setInsuredValue] = useState(row?.insuredValueUsd != null ? String(row.insuredValueUsd) : '');
  const [tariffPosition, setTariffPosition] = useState(row?.tariffPosition ?? '');
  const [retain, setRetain] = useState(row?.retain ?? false);
  const [billingNotes, setBillingNotes] = useState(row?.billingNotes ?? '');
  const [warehouse, setWarehouse] = useState(row?.warehouse ?? '');
  const [dua, setDua] = useState(row?.dua ?? '');
  const [feNumber, setFeNumber] = useState(row?.electronicInvoiceNumber ?? '');
  // Solo en alta y OPCIONAL (a diferencia de la prealerta del cliente). Mismo
  // nombre que en `ClientShipmentModal`: `document` ya es el del DOM.
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const setError = useErrorToast();
  const [busy, setBusy] = useState(false);

  /**
   * Filtra el archivo con el MISMO catalogo que aplica la API, para que el
   * rechazo llegue al elegirlo y no despues de mandar el tramite.
   */
  function pickDocument(file: File | null) {
    if (!file) {
      setDocumentFile(null);
      return;
    }
    const rejection = attachmentRejection(DOCUMENT_ATTACHMENT, file.type, file.name);
    if (rejection) {
      setError(rejection);
      setDocumentFile(null);
      return;
    }
    setError(null);
    setDocumentFile(file);
  }

  const isPackage = usesPackageFields(shipmentType);

  /**
   * Reja de edicion por estado (misma fuente que la API: `editableFieldsAt`). En
   * alta todo esta abierto; al editar, el estado del tramite decide que campos
   * admiten cambios. `can` evita duplicar aqui la regla de la maquina de estados:
   * si el estado congelo un campo, la API lo rechazaria igual, pero deshabilitarlo
   * ahorra el viaje y el error.
   */
  const editable = mode === 'edit' && row ? editableFieldsAt(row.flow, row.state) : null;
  const canEdit = (field: ShipmentField) => editable === null || editable.includes(field);
  /**
   * "Congelado" = ya no se puede tocar ningun DATO del tramite. Se mide contra la
   * ventana sin el consecutivo de FE: ese campo sigue abierto justamente en los
   * estados congelados (llega despues de emitir la factura), asi que contarlo
   * dejaria el aviso sin salir nunca a partir de "En bodega preparando".
   */
  const allFrozen =
    editable !== null &&
    editable.filter((f) => f !== ShipmentField.ElectronicInvoiceNumber).length === 0;
  /**
   * El peso alimenta la factura: aunque la maquina lo deje editable en
   * "Facturación en proceso", si la factura ya se congelo (hay monto aprobado) la
   * API lo rechaza. Se refleja aqui para no ofrecer un campo que no se puede guardar.
   */
  const weightLocked = mode === 'edit' && row != null && row.invoiceTotalUsd != null;
  // Campos visibles del formulario para este tipo; sirve para avisar si alguno quedo bloqueado.
  const relevantFields = isPackage
    ? [ShipmentField.Tracking, ShipmentField.Description, ShipmentField.Store, ShipmentField.Carrier, ShipmentField.Hawb, ShipmentField.WeightKg, ShipmentField.DeclaredValue, ShipmentField.InsuredValue, ShipmentField.TariffPosition, ShipmentField.Retain, ShipmentField.BillingNotes]
    : [ShipmentField.Tracking, ShipmentField.Description, ShipmentField.Warehouse, ShipmentField.Dua, ShipmentField.BillingNotes];
  const someFrozen = editable !== null && (weightLocked || relevantFields.some((f) => !editable.includes(f)));

  /**
   * DUA con mascara: el usuario digita solo numeros y `formatDua` intercala los
   * guiones (###-####-######).
   *
   * Al insertar un guion la posicion del cursor se corre, asi que se recoloca a
   * mano contando digitos: sin esto, corregir un numero en medio del campo
   * mandaria el cursor al final en cada tecla. Se escribe el valor en el DOM
   * antes del `setDua` para que el cursor quede fijo aunque React no re-renderice
   * (teclas ignoradas, p. ej. una letra: el valor formateado no cambia).
   */
  function onDuaChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.currentTarget;
    const caret = el.selectionStart ?? el.value.length;
    const digitsBefore = countDigits(el.value.slice(0, caret));
    const next = formatDua(el.value);
    el.value = next;
    const at = caretAfterDigits(next, digitsBefore);
    el.setSelectionRange(at, at);
    setDua(next);
  }

  /**
   * El peso se guarda tal cual (con decimales) y el redondeo hacia arriba es una
   * regla de COBRO de las tarifas estandar. Se avisa del kilaje que se cobraria
   * para que quien pesa no crea que el decimal se pierde ni que se ignora.
   */
  const weightPreview =
    isPackage && weight && Number(weight) > 0 && !Number.isInteger(Number(weight))
      ? Math.ceil(Number(weight))
      : null;
  /**
   * Con el casillero ya conocido (edicion, sin cambiarle el dueño) se sabe su
   * tarifa, asi que se dice el kilaje EXACTO que se facturara en vez de la regla
   * general de las dos modalidades.
   */
  const knownRateKind = row?.rateKind != null && row.client?.id === clientId ? row.rateKind : null;
  const billedPreview =
    weightPreview !== null && knownRateKind !== null ? displayedWeightKg(Number(weight), knownRateKind) : null;

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
                declaredValueUsd: declaredValue ? Number(declaredValue) : undefined,
                insuredValueUsd: insuredValue ? Number(insuredValue) : undefined,
                tariffPosition: tariffPosition.trim() || undefined,
                retain,
              }
            : {}),
          // Comun a los dos flujos desde que el reporte las pide en ambos.
          billingNotes: billingNotes.trim() || undefined,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
          setBusy(false);
          return;
        }
        // Multipart: los datos van en `payload` (JSON) y el documento, si lo hay,
        // en la misma peticion; asi un archivo rechazado no deja el tramite creado.
        const form = new FormData();
        form.set('payload', JSON.stringify(parsed.data));
        if (documentFile) form.set('document', documentFile);
        const created = await api.postForm<ShipmentDto>('/shipments', form);
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
        const nextDeclared = declaredValue ? Number(declaredValue) : null;
        if (nextDeclared !== row.declaredValueUsd) patch.declaredValueUsd = nextDeclared;
        const nextInsured = insuredValue ? Number(insuredValue) : null;
        if (nextInsured !== row.insuredValueUsd) patch.insuredValueUsd = nextInsured;
        put('tariffPosition', tariffPosition, row.tariffPosition);
        if (retain !== (row.retain ?? false)) patch.retain = retain;
      } else {
        put('warehouse', warehouse, row.warehouse);
        put('dua', dua, row.dua);
      }
      // Fuera del if: los dos flujos los llevan.
      put('billingNotes', billingNotes, row.billingNotes);
      put('electronicInvoiceNumber', feNumber.trim().toUpperCase(), row.electronicInvoiceNumber);

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
      <form className="modal modal-lg fadeUp" autoComplete="off" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{mode === 'create' ? 'Nuevo trámite' : `Editar trámite ${row?.code}`}</h3>
          <p>
            {isPackage
              ? 'Paquete comprado en USA que llega por la bodega de Miami.'
              : 'Trámite de transporte o agenciamiento, gestionado manualmente.'}
          </p>
        </div>

        <div className="modal-body modal-form">
          {mode === 'edit' && someFrozen && row && (
            <div className="banner col-full" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
              {allFrozen
                ? `Con el trámite en «${STATE_LABELS[row.state]}» los datos ya no se pueden modificar: solo queda anotar la factura electrónica y avanzar de estado.`
                : `Algunos campos están bloqueados: el trámite en «${STATE_LABELS[row.state]}» solo admite cambios en los datos aún abiertos.`}
            </div>
          )}

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
              {/* Un solo campo: busca y elige. El cliente de un tramite no se
                  reasigna aqui (eso es de la sala de control). */}
              <ClientPicker id="t-client" value={clientId} onChange={setClientId} />
            </div>
          ) : (
            <div className="col-full">
              <label className="field-label">Cliente</label>
              <div className="input" style={{ background: 'var(--paper-2)' }}>
                {clientFullLabel(row?.client ?? null)}
              </div>
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="t-tracking">
              {isPackage ? 'Tracking' : 'Tracking (AWB / BL)'}
            </label>
            <input
              id="t-tracking" className="input" autoComplete="off" value={tracking}
              placeholder={isPackage ? '1Z999AA10123456784' : 'FLO-26-0755'}
              disabled={!canEdit(ShipmentField.Tracking)}
              onChange={(e) => setTracking(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="t-desc">Descripción (REF)</label>
            <input
              id="t-desc" className="input" autoComplete="off" value={description}
              placeholder={isPackage ? 'Audífonos bluetooth' : 'CHEVROLET SPARK VIN583378'}
              disabled={!canEdit(ShipmentField.Description)}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {isPackage ? (
            <>
              {mode === 'edit' && (
                <>
                  <div className="col-full">
                    <label className="field-label">Contenido</label>
                    <div className="input" style={{ background: 'var(--paper-2)' }}>
                      {row?.content ?? 'Sin reportar'}
                    </div>
                  </div>
                  <div className="col-full">
                    <label className="field-label">Notas del proveedor</label>
                    <div className="input" style={{ background: 'var(--paper-2)', whiteSpace: 'pre-wrap' }}>
                      {row?.notes ?? 'Sin reportar'}
                    </div>
                    <div className="field-hint">
                      Contenido y notas los reporta el proveedor y se actualizan con la
                      sincronización; no se editan aquí.
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="field-label" htmlFor="t-store">Tienda</label>
                <select id="t-store" className="input" value={store} disabled={!canEdit(ShipmentField.Store)} onChange={(e) => setStore(e.target.value)}>
                  <option value="">Elige…</option>
                  {STORES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="t-carrier">Transportista</label>
                <select id="t-carrier" className="input" value={carrier} disabled={!canEdit(ShipmentField.Carrier)} onChange={(e) => setCarrier(e.target.value)}>
                  <option value="">Elige…</option>
                  {CARRIERS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div>
                {/* Mismo nombre que en la ficha del trámite: es el mismo dato, y
                    quien lo digita aquí es quien después lo lee ahí. */}
                <label className="field-label" htmlFor="t-hawb">HAWB (LES)</label>
                <input
                  id="t-hawb" className="input" autoComplete="off" value={hawb}
                  placeholder="p. ej. LES48450141" disabled={!canEdit(ShipmentField.Hawb)}
                  onChange={(e) => setHawb(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="t-weight">Peso (kg)</label>
                <input
                  id="t-weight" className="input" autoComplete="off" type="number" min="0" step="0.01" value={weight}
                  disabled={!canEdit(ShipmentField.WeightKg) || weightLocked}
                  onChange={(e) => setWeight(e.target.value)}
                />
                {weightLocked ? (
                  <div className="field-hint">La factura ya fue aprobada: el peso no se puede cambiar sin reversar los costos.</div>
                ) : billedPreview !== null && knownRateKind !== null ? (
                  <div className="field-hint">
                    Se guarda el peso real. Con su tarifa ({CLIENT_RATE_KIND_LABELS[knownRateKind]}) se
                    facturan {billedPreview} kg.
                  </div>
                ) : weightPreview !== null && (
                  <div className="field-hint">
                    Se guarda el peso real. Las tarifas estándar cobran {weightPreview} kg
                    (redondean hacia arriba); las consolidadas cobran el peso tal cual.
                  </div>
                )}
              </div>

              <div>
                <label className="field-label" htmlFor="t-value">Valor declarado (USD)</label>
                <input
                  id="t-value" className="input" autoComplete="off" type="number" min="0" step="0.01" value={declaredValue}
                  placeholder="Ej: 45.00" disabled={!canEdit(ShipmentField.DeclaredValue)}
                  onChange={(e) => setDeclaredValue(e.target.value)}
                />
                <div className="field-hint">Valor comercial de la compra; va en la prealerta del proveedor.</div>
              </div>
              <div>
                <label className="field-label" htmlFor="t-insured">Valor asegurado (USD)</label>
                <input
                  id="t-insured" className="input" autoComplete="off" type="number" min="0" step="0.01" value={insuredValue}
                  placeholder="0.00" disabled={!canEdit(ShipmentField.InsuredValue)}
                  onChange={(e) => setInsuredValue(e.target.value)}
                />
                <div className="field-hint">Opcional. Vacío = sin seguro (0).</div>
              </div>
              <div>
                <label className="field-label" htmlFor="t-tariff">Posición arancelaria</label>
                <input
                  id="t-tariff" className="input" autoComplete="off" value={tariffPosition}
                  placeholder="Opcional" disabled={!canEdit(ShipmentField.TariffPosition)}
                  onChange={(e) => setTariffPosition(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, alignSelf: 'end', paddingBottom: 8 }}>
                <input
                  id="t-retain" type="checkbox" checked={retain}
                  disabled={!canEdit(ShipmentField.Retain)}
                  onChange={(e) => setRetain(e.target.checked)}
                />
                <label htmlFor="t-retain" className="field-label" style={{ margin: 0 }}>
                  Retener en bodega del proveedor
                </label>
              </div>
            </>
          ) : (
            <>
              {mode === 'edit' && (
                <>
                  <div>
                    <label className="field-label" htmlFor="t-warehouse">Almacén</label>
                    <input
                      id="t-warehouse" className="input" autoComplete="off" value={warehouse}
                      disabled={!canEdit(ShipmentField.Warehouse)}
                      onChange={(e) => setWarehouse(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="t-dua">DUA</label>
                    <input
                      id="t-dua" className="input" value={dua} placeholder="###-####-######"
                      inputMode="numeric" autoComplete="off"
                      disabled={!canEdit(ShipmentField.Dua)}
                      onChange={onDuaChange}
                    />
                    <div className="field-hint">Escribe solo los números: los guiones se ponen solos.</div>
                  </div>
                </>
              )}
              {mode === 'create' && (
                <div className="banner ok col-full" style={{ background: 'var(--paper-2)', color: 'var(--muted)' }}>
                  El almacén y el DUA se completan al editar el trámite, una vez guardado.
                </div>
              )}
            </>
          )}

          {/* Facturación: comun a los dos flujos. Las notas las pide el reporte en
              ambos, y el consecutivo de FE es lo unico que sigue escribiendose
              cuando el resto del tramite ya esta congelado. */}
          <div className="col-full">
            <label className="field-label" htmlFor="t-notes">Notas para facturar</label>
            <textarea
              id="t-notes" className="input" autoComplete="off" rows={3} value={billingNotes}
              disabled={!canEdit(ShipmentField.BillingNotes)}
              onChange={(e) => setBillingNotes(e.target.value)}
            />
          </div>

          {mode === 'create' && (
            <div className="col-full">
              <FileField
                id="t-document"
                label="Documento (opcional)"
                accept={DOCUMENT_ATTACHMENT.accept}
                file={documentFile}
                onPick={pickDocument}
                disabled={busy}
                hint={`Factura, orden de compra u otro soporte del trámite. Se aceptan ${DOCUMENT_ATTACHMENT.label}.`}
              />
            </div>
          )}

          {mode === 'edit' && (
            <div>
              <label className="field-label" htmlFor="t-fe">Factura electrónica (FE)</label>
              <input
                id="t-fe" className="input" value={feNumber} placeholder="Consecutivo"
                autoComplete="off"
                disabled={!canEdit(ShipmentField.ElectronicInvoiceNumber)}
                onChange={(e) => setFeNumber(e.target.value)}
              />
              <div className="field-hint">
                Consecutivo que emitió el sistema de factura electrónica. Se anota al facturar.
              </div>
            </div>
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
