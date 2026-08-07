/**
 * Alta de un tramite por el titular del casillero ("Requerimientos Parte 2 -
 * Portal Cliente", L45-71). Un unico formulario que se reduce a lo que pide el
 * tipo elegido:
 *   - Paqueteria                  -> tienda, transportista, tracking, descripcion.
 *   - Transporte / Agenciamiento  -> solo guia (AWB/BL) y descripcion (REF).
 *
 * Quien lo abre decide QUE tipos ofrece (`types`), y de ahi sale todo lo demas:
 *   - "Mis paquetes" pasa solo Paqueteria: ahi el alta es una PREALERTA (avisar
 *     de una compra que viene en camino) y no hay nada que elegir.
 *   - "Otros tramites" pasa los tipos manuales: eso no es una prealerta sino el
 *     registro de un tramite de transporte o agenciamiento, con su propio
 *     lenguaje. Por eso los textos siguen al tipo y no al componente.
 * Separarlos importa: mientras el selector ofrecia los cinco tipos desde "Mis
 * paquetes", un tramite aereo o maritimo se registraba y desaparecia, porque ese
 * listado solo trae Paqueteria.
 *
 * Vive DENTRO del listado que lo abre (no como pantalla propia del menu): dar de
 * alta es una accion sobre ese listado, y asi el cliente ve aparecer lo que
 * acaba de registrar sin cambiar de sitio.
 *
 * El dueño del tramite NO se elige: lo pone la API desde la sesion.
 *
 * El documento (la factura de la compra, tipicamente) es OPCIONAL y viaja en una
 * SEGUNDA peticion, porque un archivo obliga a multipart: mezclarlo con el JSON
 * haria que un adjunto rechazado tumbara tambien los datos ya validados.
 * Separadas, un fallo al subir deja el tramite registrado y solo hay que
 * reintentar el archivo, que es lo que ofrece el boton de reintento.
 */
import { useState } from 'react';
import {
  CARRIERS,
  DOCUMENT_ATTACHMENT,
  SHIPMENT_TYPE_LABELS,
  STORES,
  ShipmentType,
  attachmentRejection,
  prealertShipmentSchema,
  usesPackageFields,
} from '@courier/shared';
import type { ShipmentDto } from '@courier/shared';
import { FileField } from '../components/FileField';
import { ModalOverlay } from '../components/ModalOverlay';
import { ApiError, api } from '../lib/api';

interface Props {
  /**
   * Tipos que se pueden registrar desde el listado que abre el modal. Con uno
   * solo no se pinta el selector: no hay decision que tomar.
   */
  types: readonly ShipmentType[];
  onClose: () => void;
  /** El listado de fondo se recarga con cada tramite registrado. */
  onCreated: () => void;
}

export function ClientShipmentModal({ types, onClose, onCreated }: Props) {
  const [shipmentType, setShipmentType] = useState<ShipmentType>(types[0]!);
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
  /**
   * Tramite que quedo registrado pero SIN su documento. Mientras exista, se
   * ofrece reintentar solo la subida: repetir el formulario entero chocaria
   * contra el tracking, que ya esta tomado por este mismo tramite.
   */
  const [pendingDocument, setPendingDocument] = useState<{ id: string; file: File } | null>(null);

  /**
   * Interruptor unico del formulario Y de los textos: en Paqueteria el cliente
   * PREALERTA una compra; en transporte y agenciamiento REGISTRA un tramite.
   */
  const isPackage = usesPackageFields(shipmentType);

  /** Campos de texto del formulario. El documento se limpia aparte: su suerte
   *  no va atada a la del formulario (puede quedar pendiente de reintento). */
  function resetFields() {
    setTracking('');
    setDescription('');
    setStore('');
    setCarrier('');
    setDeclaredValue('');
  }

  /** El selector se vacía solo al quedarse sin archivo (ver `FileField`). */
  function clearDocument() {
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
      clearDocument();
      return;
    }
    const rejection = attachmentRejection(DOCUMENT_ATTACHMENT, file.type, file.name);
    if (rejection) {
      setError(rejection);
      clearDocument();
      return;
    }
    setError(null);
    setDocumentFile(file);
  }

  /** Sube el documento de un tramite ya creado. Devuelve si lo consiguio. */
  async function uploadDocument(shipmentId: string, file: File): Promise<boolean> {
    try {
      await api.upload<ShipmentDto>(`/shipments/${shipmentId}/document`, file);
      setPendingDocument(null);
      return true;
    } catch (err) {
      setPendingDocument({ id: shipmentId, file });
      setError(
        err instanceof ApiError
          ? `El trámite quedó registrado, pero el documento no se adjuntó: ${err.message}`
          : 'El trámite quedó registrado, pero no se pudo adjuntar el documento.',
      );
      return false;
    }
  }

  async function retryDocument() {
    if (!pendingDocument) return;
    setBusy(true);
    setError(null);
    if (await uploadDocument(pendingDocument.id, pendingDocument.file)) clearDocument();
    setBusy(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreated(null);
    setPendingDocument(null);
    setBusy(true);
    try {
      const parsed = prealertShipmentSchema.safeParse({
        shipmentType,
        tracking,
        description,
        ...(isPackage
          ? {
              store: store || undefined,
              carrier: carrier || undefined,
              declaredValueUsd: declaredValue ? Number(declaredValue) : undefined,
            }
          : {}),
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
        setBusy(false);
        return;
      }
      const result = await api.post<ShipmentDto>('/shipments/prealert', parsed.data);
      setCreated(result);
      // Los datos se limpian con el tramite ya creado: repetirlos solo chocaria
      // contra su propio tracking, que a partir de aqui esta tomado.
      resetFields();

      /**
       * El documento va aparte y NO puede deshacer el alta: si falla, el tramite
       * ya existe y lo unico pendiente es el archivo, que se conserva en el
       * estado para reintentar solo esa subida.
       */
      if (documentFile && (await uploadDocument(result.id, documentFile))) clearDocument();
      /**
       * El modal NO se cierra solo: el alta puede haber dejado el documento
       * pendiente de reintento, y encadenar varias (llega mas de un paquete el
       * mismo dia) es lo normal. Lo que si se refresca es el listado de detras.
       */
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : isPackage
            ? 'No se pudo registrar la prealerta.'
            : 'No se pudo registrar el trámite.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{isPackage ? 'Prealertar' : 'Nuevo trámite'}</h3>
          <p>
            {isPackage
              ? 'Avísanos qué viene en camino para darle seguimiento.'
              : 'Registra tu carga aérea, marítima o de agenciamiento para darle seguimiento.'}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          {created && (
            <div className="banner ok">
              {isPackage ? 'Prealerta registrada' : 'Trámite registrado'} con el consecutivo{' '}
              <strong>{created.code}</strong> ({created.tracking}). Ya aparece en tu listado.
            </div>
          )}

          {/* Con un solo tipo no hay nada que elegir: el listado que abrio el
              modal ya dijo de que se trata. */}
          {types.length > 1 && (
            <div>
              <label className="field-label" htmlFor="p-type">Trámite</label>
              <select
                id="p-type" className="input" value={shipmentType}
                onChange={(e) => setShipmentType(e.target.value as ShipmentType)}
              >
                {types.map((t) => (
                  <option key={t} value={t}>{SHIPMENT_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          )}

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
          )}

          {isPackage && (
            <div>
              <label className="field-label" htmlFor="p-value">Valor declarado (USD)</label>
              <input
                id="p-value" className="input" type="number" min="0" step="0.01" value={declaredValue}
                placeholder="Ej: 45.00"
                onChange={(e) => setDeclaredValue(e.target.value)}
              />
              <div className="field-hint">Lo que pagaste por la compra, en dólares. Es obligatorio para la aduana.</div>
            </div>
          )}

          <FileField
            id="p-document"
            label="Documento (opcional)"
            accept={DOCUMENT_ATTACHMENT.accept}
            file={documentFile}
            onPick={pickDocument}
            disabled={busy}
            hint={`Adjunta ${
              isPackage ? 'la factura de la compra' : 'la factura o el documento de embarque'
            }. Se aceptan ${DOCUMENT_ATTACHMENT.label}; las fotos y capturas de pantalla no sirven, tiene que ser el documento.`}
          />
        </div>

        <div className="modal-foot">
          {/* Solo cuando el tramite ya paso y lo unico que falto fue el archivo. */}
          {pendingDocument && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={retryDocument}>
              {busy ? 'Adjuntando…' : 'Reintentar adjuntar'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {created ? 'Cerrar' : 'Cancelar'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Registrando…' : isPackage ? 'Prealertar' : 'Registrar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
