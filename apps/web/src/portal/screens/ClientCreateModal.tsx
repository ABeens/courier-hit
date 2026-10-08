/**
 * Alta de un casillero por el staff (permiso clients.create: Admin y Operativo).
 *
 * Es para el cliente que no se registra solo desde el sitio (llama, escribe o
 * viene a la oficina). Nace igual que uno del autoregistro: cuenta principal,
 * tarifa por defecto y flag "Nuevo".
 *
 * Pide lo mismo que el registro público menos la contraseña: el administrador
 * nunca la fija. Al guardar se manda una invitación para que el titular la
 * defina, igual que con el personal interno y el cliente consolidado.
 */
import { useState } from 'react';
import { PROVINCES, getCantons, getDistricts } from '@courier/shared';
import type { CreateClientResultDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import { useErrorToast } from '../lib/toast';

interface Props {
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ClientCreateModal({ onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [provinceCode, setProvinceCode] = useState('');
  const [cantonCode, setCantonCode] = useState('');
  const [districtCode, setDistrictCode] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const setError = useErrorToast();
  const [saving, setSaving] = useState(false);
  /** Solo en desarrollo: en producción el enlace viaja únicamente por correo. */
  const [created, setCreated] = useState<CreateClientResultDto | null>(null);

  const cantons = provinceCode ? getCantons(provinceCode) : [];
  const districts = cantonCode ? getDistricts(cantonCode) : [];

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
    setSaving(true);
    try {
      const result = await api.post<CreateClientResultDto>('/clients', {
        name: name.trim(),
        idNumber: idNumber.trim(),
        email: email.trim(),
        phone: phone.trim(),
        provinceCode,
        cantonCode,
        districtCode,
        addressLine: addressLine.trim(),
      });

      // Con el enlace de invitación a la vista, el modal se queda abierto: es lo
      // único que hay que copiar antes de cerrarlo (solo pasa en desarrollo).
      if (result.inviteLink) {
        setCreated(result);
        setSaving(false);
        return;
      }
      onSaved(
        `${result.name} quedó con el casillero ${result.code}. ` +
          'Le enviamos la invitación para definir su contraseña.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el cliente.');
      setSaving(false);
    }
  }

  if (created?.inviteLink) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h3>Cliente creado</h3>
            <p>{created.code} · {created.name}</p>
          </div>
          <div className="modal-body">
            <div className="banner ok" style={{ marginBottom: 14 }}>
              El casillero ya existe. El titular entra al portal cuando defina su contraseña.
            </div>
            <label className="field-label" htmlFor="nc-invite">Enlace de invitación</label>
            <input id="nc-invite" className="input mono" readOnly value={created.inviteLink} />
            <div className="field-hint">
              Este enlace solo aparece en desarrollo. En producción llega por correo y no se muestra
              en pantalla.
            </div>
          </div>
          <div className="modal-foot">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSaved(`${created.name} quedó con el casillero ${created.code}.`)}
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
          <h3>Nuevo cliente</h3>
          <p>Se le abre un casillero y recibe por correo la invitación para definir su contraseña.</p>
        </div>

        <div className="modal-body">

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="nc-name">Nombre o razón social</label>
              <input
                id="nc-name"
                className="input"
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="nc-id">Cédula</label>
              <input
                id="nc-id"
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
              <label className="field-label" htmlFor="nc-email">Correo</label>
              <input
                id="nc-email"
                className="input"
                type="email"
                autoComplete="off"
                value={email}
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="nc-phone">Teléfono</label>
              <input
                id="nc-phone"
                className="input"
                value={phone}
                required
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          <fieldset className="form-section">
            <legend>Dirección de entrega en Costa Rica</legend>
            <div className="form-grid cols-3">
              <div>
                <label className="field-label" htmlFor="nc-province">Provincia</label>
                <select
                  id="nc-province"
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
                <label className="field-label" htmlFor="nc-canton">Cantón</label>
                <select
                  id="nc-canton"
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
                <label className="field-label" htmlFor="nc-district">Distrito</label>
                <select
                  id="nc-district"
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
                <label className="field-label" htmlFor="nc-address">Otras señas</label>
                <textarea
                  id="nc-address"
                  className="input"
                  rows={3}
                  value={addressLine}
                  required
                  onChange={(e) => setAddressLine(e.target.value)}
                  placeholder="Del super La Central 200 m norte, bodega azul a mano derecha."
                />
              </div>
            </div>
          </fieldset>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Creando…' : 'Crear cliente'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
