/**
 * Edición de un casillero por el administrador (permiso clients.write), Parte 3.
 *
 * Cubre la ficha entera: los datos del titular (nombre, cédula, correo,
 * teléfono, dirección de entrega) y las dos decisiones comerciales (tarifa y
 * límite de crédito). El cliente sigue editando lo suyo desde su perfil; aquí
 * está el camino para lo que él no puede tocar (el correo) y para corregir lo
 * que llegó mal en el alta o en la carga inicial.
 *
 * Correo y cédula no son un dato más: el correo es el usuario de login y la
 * cédula identifica al casillero ante el operador en Miami. Cambiar cualquiera
 * de los dos muestra un aviso con lo que arrastra y pide confirmarlo antes de
 * guardar.
 *
 * Guardar apaga el flag "Nuevo" del casillero. No es un checkbox: el manual lo
 * define como consecuencia de haber revisado, y un checkbox permitiría marcarlo
 * como revisado sin mirar nada.
 */
import { useEffect, useState } from 'react';
import { CURRENCY_LABELS, Currency, PROVINCES, getCantons, getDistricts } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import type { ClientRow } from './ClientsScreen';
import { useErrorToast } from '../lib/toast';

interface Rate {
  id: string;
  name: string;
  pricePerKg: number;
  currency: Currency;
  isDefault: boolean;
}

/** Respuesta del PATCH: lo que el cambio de correo le reenvió al titular. */
interface UpdateResult {
  accessEmail?: 'invitation' | 'verification';
  inviteLink?: string;
}

interface Props {
  row: ClientRow;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/* Misma normalización que la API (emailSchema / idNumberSchema): sin ella, un
   espacio o un guion de más se leería como "cambió la cédula" y dispararía el
   aviso sin motivo. */
const normEmail = (v: string) => v.trim().toLowerCase();
const normIdNumber = (v: string) => v.replace(/\D/g, '');

export function ClientEditModal({ row, onClose, onSaved }: Props) {
  const [name, setName] = useState(row.name);
  const [idNumber, setIdNumber] = useState(row.idNumber);
  const [email, setEmail] = useState(row.email);
  const [phone, setPhone] = useState(row.phone ?? '');
  const [provinceCode, setProvinceCode] = useState(row.provinceCode);
  const [cantonCode, setCantonCode] = useState(row.cantonCode);
  const [districtCode, setDistrictCode] = useState(row.districtCode);
  const [addressLine, setAddressLine] = useState(row.addressLine);

  const [rates, setRates] = useState<Rate[] | null>(null);
  const [clientRateId, setClientRateId] = useState(row.clientRateId ?? '');
  const [creditLimit, setCreditLimit] = useState(
    row.creditLimit != null ? String(row.creditLimit) : '',
  );
  const [currency, setCurrency] = useState<Currency>(row.creditLimitCurrency ?? Currency.USD);

  /** Trámites en curso: con alguno, mover la dirección cambia a dónde va un paquete en camino. */
  const [activeShipments, setActiveShipments] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /** Solo en desarrollo: en producción la invitación reenviada viaja únicamente por correo. */
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const setError = useErrorToast();
  const [saving, setSaving] = useState(false);

  const cantons = provinceCode ? getCantons(provinceCode) : [];
  const districts = cantonCode ? getDistricts(cantonCode) : [];

  const emailChanged = normEmail(email) !== normEmail(row.email);
  const idNumberChanged = normIdNumber(idNumber) !== normIdNumber(row.idNumber);
  const sensitiveChanged = emailChanged || idNumberChanged;
  const addressChanged =
    provinceCode !== row.provinceCode ||
    cantonCode !== row.cantonCode ||
    districtCode !== row.districtCode ||
    addressLine.trim() !== row.addressLine.trim();

  // Una confirmación vale para los cambios que se vieron al darla: si después se
  // toca otra vez el correo o la cédula, se vuelve a pedir.
  useEffect(() => setConfirmed(false), [email, idNumber]);

  // El selector de tarifas se carga al abrir: son pocas y cambian poco, pero
  // tienen que ser las vigentes, no una copia que traiga la fila del listado.
  // Si la carga falla se dice: un combo vacio en silencio se lee como "no hay
  // tarifas" y lleva a guardar el cliente sin tocar la que tenia.
  useEffect(() => {
    void api
      .get<{ items: Rate[] }>('/tariffs/client-rates')
      .then((data) => setRates(data.items))
      .catch((err) => {
        setRates([]);
        setError(
          err instanceof ApiError ? err.message : 'No se pudieron cargar las tarifas disponibles.',
        );
      });
    // Si falla no se bloquea nada: el aviso de la dirección es una ayuda, no la regla.
    void api
      .get<{ activeShipmentCount: number }>(`/clients/${row.id}`)
      .then((data) => setActiveShipments(data.activeShipmentCount))
      .catch(() => setActiveShipments(null));
  }, []);

  /* Cambiar de provincia invalida el cantón y el distrito: la terna solo vale
     completa, y dejar los de la provincia anterior manda a otro lado. */
  function selectProvince(code: string) {
    setProvinceCode(code);
    setCantonCode('');
    setDistrictCode('');
  }

  function selectCanton(code: string) {
    setCantonCode(code);
    setDistrictCode('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = creditLimit.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError('El límite de crédito debe ser un número mayor o igual a cero.');
      return;
    }
    if (sensitiveChanged && !confirmed) {
      setError('Confirma el cambio de correo o cédula antes de guardar.');
      return;
    }

    setSaving(true);
    try {
      // Solo viaja lo que cambió del titular: reenviar un dato igual no aporta y
      // obligaría a la API a revalidar unicidades que nadie tocó.
      const result = await api.patch<UpdateResult>(`/clients/${row.id}`, {
        ...(name.trim() !== row.name ? { name: name.trim() } : {}),
        ...(idNumberChanged ? { idNumber: idNumber.trim() } : {}),
        ...(emailChanged ? { email: email.trim() } : {}),
        ...(phone.trim() !== '' && phone.trim() !== (row.phone ?? '') ? { phone: phone.trim() } : {}),
        // La dirección va completa o no va: la terna se valida entera.
        ...(addressChanged
          ? { provinceCode, cantonCode, districtCode, addressLine: addressLine.trim() }
          : {}),
        ...(clientRateId ? { clientRateId } : {}),
        creditLimit: parsed,
        // La moneda viaja SIEMPRE junto al límite (regla M2). Si se borra el
        // límite se limpia también: una moneda suelta no describe nada.
        creditLimitCurrency: parsed === null ? null : currency,
      });

      const displayName = name.trim() || row.name;
      let message = `${displayName}: datos actualizados y casillero marcado como revisado.`;
      if (result.accessEmail === 'invitation') {
        message += ' Le reenviamos la invitación al correo nuevo.';
      } else if (result.accessEmail === 'verification') {
        message += ' Le enviamos un código de verificación al correo nuevo.';
      }

      // Con el enlace a la vista el modal se queda abierto: es lo único que hay
      // que copiar antes de cerrarlo (solo pasa en desarrollo).
      if (result.inviteLink) {
        setInviteLink(result.inviteLink);
        setSaving(false);
        return;
      }
      onSaved(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el cliente.');
      setSaving(false);
    }
  }

  if (inviteLink) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h3>Cliente actualizado</h3>
            <p>
              {row.code} · {name.trim() || row.name}
            </p>
          </div>
          <div className="modal-body">
            <div className="banner ok" style={{ marginBottom: 14 }}>
              La invitación pendiente se anuló y se emitió una nueva para el correo nuevo.
            </div>
            <label className="field-label" htmlFor="c-invite">Enlace de invitación</label>
            <input id="c-invite" className="input mono" readOnly value={inviteLink} />
            <div className="field-hint">
              Este enlace solo aparece en desarrollo. En producción llega por correo y no se muestra
              en pantalla.
            </div>
          </div>
          <div className="modal-foot">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSaved(`${name.trim() || row.name}: datos actualizados.`)}
            >
              Listo
            </button>
          </div>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Editar cliente</h3>
          <p>
            {row.code} · {row.name}
          </p>
        </div>

        <div className="modal-body">

          <fieldset className="form-section">
            <legend>Datos del titular</legend>

            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="c-name">Nombre o razón social</label>
                <input
                  id="c-name"
                  className="input"
                  value={name}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="c-id">Cédula</label>
                <input
                  id="c-id"
                  className="input"
                  inputMode="numeric"
                  value={idNumber}
                  required
                  onChange={(e) => setIdNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="c-email">Correo</label>
                <input
                  id="c-email"
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={email}
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="c-phone">Teléfono</label>
                <input
                  id="c-phone"
                  className="input"
                  value={phone}
                  required={row.phone != null}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            {sensitiveChanged && (
              <div className="banner err" role="alert" style={{ marginTop: 4 }}>
                <div style={{ marginBottom: 6 }}>Atención: vas a cambiar un dato de identidad.</div>
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontWeight: 500 }}>
                  {emailChanged && (
                    <li>
                      El correo es el <strong>usuario de acceso</strong>. Desde que guardes, el
                      cliente entra con <strong>{normEmail(email)}</strong> (su contraseña no
                      cambia) y todos los avisos salen a esa dirección. Los enlaces de invitación o
                      de restablecimiento enviados al correo anterior dejan de funcionar. Verifica
                      que el correo nuevo esté bien escrito: si no, el cliente se queda sin acceso.
                    </li>
                  )}
                  {idNumberChanged && (
                    <li>
                      La cédula identifica el casillero ante el operador en Miami y aparece en las
                      proformas, incluidas las ya emitidas. Si el casillero ya está enlazado, el
                      operador <strong>conserva la cédula anterior</strong>: el cambio no se le
                      envía y queda registrado en la bitácora del enlace.
                    </li>
                  )}
                </ul>
                <label className="check-row" style={{ fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Entiendo las consecuencias y confirmo el cambio.
                </label>
              </div>
            )}
          </fieldset>

          <fieldset className="form-section">
            <legend>Dirección de entrega en Costa Rica</legend>
            <div className="form-grid cols-3">
              <div>
                <label className="field-label" htmlFor="c-province">Provincia</label>
                <select
                  id="c-province"
                  className="input"
                  value={provinceCode}
                  required
                  onChange={(e) => selectProvince(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {PROVINCES.map((p) => (
                    <option key={p.code} value={p.code}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="c-canton">Cantón</label>
                <select
                  id="c-canton"
                  className="input"
                  value={cantonCode}
                  disabled={!provinceCode}
                  required
                  onChange={(e) => selectCanton(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {cantons.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="c-district">Distrito</label>
                <select
                  id="c-district"
                  className="input"
                  value={districtCode}
                  disabled={!cantonCode}
                  required
                  onChange={(e) => setDistrictCode(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {districts.map((d) => (
                    <option key={d.code} value={d.code}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-full">
                <label className="field-label" htmlFor="c-address">Otras señas</label>
                <textarea
                  id="c-address"
                  className="input"
                  rows={3}
                  value={addressLine}
                  required
                  onChange={(e) => setAddressLine(e.target.value)}
                />
              </div>
            </div>
            {addressChanged && activeShipments != null && activeShipments > 0 && (
              <div className="banner warn" style={{ marginTop: 8 }}>
                El cliente tiene {activeShipments}{' '}
                {activeShipments === 1 ? 'trámite en curso' : 'trámites en curso'}. La ruta de
                reparto y la hoja del mensajero leen la dirección en vivo: lo que aún no se entregó
                irá a la dirección nueva.
              </div>
            )}
          </fieldset>

          <fieldset className="form-section">
            <legend>Condiciones comerciales</legend>

            <div>
              <label className="field-label" htmlFor="c-rate">Tarifa asignada</label>
              <select
                id="c-rate"
                className="input"
                value={clientRateId}
                disabled={rates === null}
                onChange={(e) => setClientRateId(e.target.value)}
              >
                {/*
                  La opcion vacia solo aparece si el casillero llego sin tarifa: en
                  ese caso hay algo que decir (con cual se le factura mientras
                  tanto). Si ya tiene una, ofrecer "sin cambiar" solo duplicaria la
                  opcion que ya viene seleccionada.
                */}
                {!row.clientRateId && <option value="">Sin tarifa (se factura con la por defecto)</option>}
                {rates?.map((rate) => (
                  <option key={rate.id} value={rate.id}>
                    {rate.name} · {rate.pricePerKg} {rate.currency}/kg
                    {rate.isDefault ? ' (por defecto)' : ''}
                  </option>
                ))}
              </select>
              <div className="field-hint">
                {rates === null
                  ? 'Cargando tarifas…'
                  : rates.length === 0
                    ? 'No hay tarifas configuradas. Créalas en el módulo de Tarifas.'
                    : 'Define el precio por kg del flete que se le cobra al casillero.'}
              </div>
            </div>

            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="c-credit">Límite de crédito</label>
                <input
                  id="c-credit"
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={creditLimit}
                  placeholder="Sin límite"
                  onChange={(e) => setCreditLimit(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="c-currency">Moneda del límite</label>
                <select
                  id="c-currency"
                  className="input"
                  value={currency}
                  disabled={creditLimit.trim() === ''}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                >
                  {Object.values(Currency).map((c) => (
                    <option key={c} value={c}>
                      {CURRENCY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>

          <div className="banner" style={{ marginTop: 4 }}>
            Al guardar, el casillero deja de figurar como <strong>Nuevo</strong>.
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || (sensitiveChanged && !confirmed)}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
