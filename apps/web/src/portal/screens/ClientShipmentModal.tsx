/**
 * PREALERTA de un paquete por el titular del casillero ("Requerimientos Parte 2 -
 * Portal Cliente", L45-71): tienda, transportista, tracking, descripcion, valor
 * declarado y la ORDEN DE COMPRA de lo que viene en camino a Miami.
 *
 * SOLO PAQUETERIA, y por eso no hay selector de tipo. Los tramites de Transporte
 * (aereo, maritimo FCL/LCL) y de Agenciamiento no los prealerta el cliente: nacen
 * de una gestion que negocia el staff (guia aerea/BL, almacen, DUA) y los
 * registra quien tiene `tramite.manage` desde el panel administrativo. El titular
 * los ve en "Otros tramites", que es solo consulta. La misma regla la aplican
 * `prealertShipmentSchema` (el tipo es un literal) y el endpoint de la API.
 *
 * Vive DENTRO del listado que lo abre (no como pantalla propia del menu): dar de
 * alta es una accion sobre ese listado, y asi el cliente ve aparecer lo que
 * acaba de prealertar sin cambiar de sitio.
 *
 * El dueño del tramite NO se elige: lo pone la API desde la sesion.
 *
 * La orden de compra es OBLIGATORIA y viaja en la MISMA peticion que los datos,
 * en multipart. Antes eran dos peticiones y el documento era opcional, que es lo
 * unico que podia ser: el alta se resolvia primero, asi que un fallo al subir el
 * archivo dejaba igualmente el tramite registrado y solo cabia ofrecer un
 * reintento. Juntas, o entra todo o no entra nada, y no hay prealerta sin
 * documento que despues haya que perseguir.
 */
import { useState } from 'react';
import {
  CARRIERS,
  DOCUMENT_ATTACHMENT,
  STORES,
  ShipmentType,
  attachmentRejection,
  prealertShipmentSchema,
} from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import { ApiError, api } from '../lib/api';

interface Props {
  onClose: () => void;
  /** El listado de fondo se recarga con cada paquete prealertado. */
  onCreated: () => void;
}

export function ClientShipmentModal({ onClose, onCreated }: Props) {
  const [tracking, setTracking] = useState('');
  const [description, setDescription] = useState('');
  const [store, setStore] = useState('');
  const [carrier, setCarrier] = useState('');
  const [declaredValue, setDeclaredValue] = useState('');
  // `documentFile` y no `document`: ese nombre ya es el del DOM y esconderlo
  // dentro del componente se paga caro el dia que alguien lo necesite.
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ShipmentDto | null>(null);
  const [busy, setBusy] = useState(false);

  /** Campos del formulario, con el tramite ya creado. */
  function resetFields() {
    setTracking('');
    setDescription('');
    setStore('');
    setCarrier('');
    setDeclaredValue('');
    setDocumentFile(null);
  }

  /**
   * Filtra el archivo elegido con el MISMO catalogo que aplica la API, para que
   * el rechazo llegue al elegirlo y no despues de mandar el tramite. El
   * `accept` del input ya orienta el selector, pero no obliga: se puede soltar
   * ahi cualquier cosa.
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const parsed = prealertShipmentSchema.safeParse({
        shipmentType: ShipmentType.Paqueteria,
        tracking,
        description,
        store: store || undefined,
        carrier: carrier || undefined,
        declaredValueUsd: declaredValue ? Number(declaredValue) : undefined,
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
        setBusy(false);
        return;
      }
      /**
       * El documento se exige DESPUES de los datos para que los avisos bajen en
       * el mismo orden en que estan los campos: el archivo es el ultimo. La API
       * repite la exigencia; esto solo evita el viaje.
       */
      if (!documentFile) {
        setError('Adjunta la orden de compra: sin ella no podemos registrar la prealerta.');
        setBusy(false);
        return;
      }

      /**
       * Multipart: los campos van como texto (es lo unico que hay en un
       * formulario) y la API los valida con este mismo esquema del lado de alla.
       * El valor declarado se manda tal cual lo escribio el cliente; el numero
       * lo arma el servidor.
       */
      const form = new FormData();
      form.set('shipmentType', parsed.data.shipmentType);
      form.set('tracking', parsed.data.tracking);
      form.set('description', parsed.data.description);
      if (parsed.data.store) form.set('store', parsed.data.store);
      if (parsed.data.carrier) form.set('carrier', parsed.data.carrier);
      if (parsed.data.declaredValueUsd !== undefined) {
        form.set('declaredValueUsd', String(parsed.data.declaredValueUsd));
      }
      form.set('document', documentFile);

      const result = await api.postForm<ShipmentDto>('/shipments/prealert', form);
      setCreated(result);
      // Los datos se limpian con el tramite ya creado: repetirlos solo chocaria
      // contra su propio tracking, que a partir de aqui esta tomado.
      resetFields();
      /**
       * El modal NO se cierra solo: encadenar varias prealertas (llega mas de un
       * paquete el mismo dia) es lo normal. Lo que si se refresca es el listado
       * de detras.
       */
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo registrar la prealerta.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Prealertar</h3>
          <p>Avísanos qué viene en camino para darle seguimiento.</p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {created && (
            <div className="banner ok">
              Prealerta registrada con el consecutivo <strong>{created.code}</strong> ({created.tracking}).
              Ya aparece en tu listado.
            </div>
          )}

          <div>
            <label className="field-label" htmlFor="p-tracking">Tracking</label>
            <input
              id="p-tracking" className="input" value={tracking}
              placeholder="1Z999AA10123456784"
              onChange={(e) => setTracking(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="p-desc">Descripción (REF)</label>
            <input
              id="p-desc" className="input" value={description}
              placeholder="Audífonos bluetooth"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field-pair">
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

          <div>
            <label className="field-label" htmlFor="p-value">Valor declarado (USD)</label>
            <input
              id="p-value" className="input" type="number" min="0" step="0.01" value={declaredValue}
              placeholder="Ej: 45.00"
              onChange={(e) => setDeclaredValue(e.target.value)}
            />
            <div className="field-hint">Lo que pagaste por la compra, en dólares. Es obligatorio para la aduana.</div>
          </div>

          <FileField
            id="p-document"
            label="Orden de compra"
            accept={DOCUMENT_ATTACHMENT.accept}
            file={documentFile}
            onPick={pickDocument}
            disabled={busy}
            hint={`Obligatoria: adjunta la orden de compra o la factura de la tienda. Se aceptan ${DOCUMENT_ATTACHMENT.label}; las fotos y capturas de pantalla no sirven, tiene que ser el documento.`}
          />
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {created ? 'Cerrar' : 'Cancelar'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Registrando…' : 'Prealertar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
