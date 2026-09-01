/**
 * Alta del cliente consolidado de una cuenta exclusiva
 * (permiso provider_accounts.manage, solo Admin).
 *
 * Es el ÚNICO camino por el que nace un cliente de este tipo. Quien se registra
 * desde el sitio público queda siempre en la cuenta principal, y un cliente que
 * ya existe no se puede pasar aquí: su paquetería histórica entró por
 * sub-casilleros de la cuenta principal y reatribuirla mentiría sobre de dónde
 * vino cada paquete.
 *
 * Pide lo mismo que el registro público menos la contraseña: el administrador
 * nunca la fija. Al guardar se manda una invitación para que el titular la
 * defina, igual que con el personal interno.
 */
import { useState } from 'react';
import { PROVINCES, getCantons, getDistricts } from '@courier/shared';
import type { CreateConsolidatedClientResultDto, ProviderAccountDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';

interface Props {
  account: ProviderAccountDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ConsolidatedClientModal({ account, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [provinceCode, setProvinceCode] = useState('');
  const [cantonCode, setCantonCode] = useState('');
  const [districtCode, setDistrictCode] = useState('');
  const [addressLine, setAddressLine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Solo en desarrollo: en producción el enlace viaja únicamente por correo. */
  const [inviteLink, setInviteLink] = useState<string | null>(null);

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
      const result = await api.post<CreateConsolidatedClientResultDto>(
        `/provider-accounts/${account.id}/client`,
        {
          name: name.trim(),
          idNumber: idNumber.trim(),
          email: email.trim(),
          phone: phone.trim(),
          provinceCode,
          cantonCode,
          districtCode,
          addressLine: addressLine.trim(),
        },
      );

      // Con el enlace de invitación a la vista, el modal se queda abierto: es lo
      // único que hay que copiar antes de cerrarlo (solo pasa en desarrollo).
      if (result.inviteLink) {
        setInviteLink(result.inviteLink);
        setSaving(false);
        return;
      }
      onSaved(
        `${result.account.client?.name ?? name.trim()} quedó como cliente consolidado de ${account.code}. ` +
          'Le enviamos la invitación para definir su contraseña.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el cliente.');
      setSaving(false);
    }
  }

  if (inviteLink) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h3>Cliente consolidado creado</h3>
            <p>{account.code} · {account.name}</p>
          </div>
          <div className="modal-body">
            <div className="banner ok" style={{ marginBottom: 14 }}>
              Ya quedó ligado a la cuenta. Toda la paquetería de {account.code} se le atribuirá a
              este cliente.
            </div>
            <label className="field-label" htmlFor="cc-invite">Enlace de invitación</label>
            <input id="cc-invite" className="input mono" readOnly value={inviteLink} />
            <div className="field-hint">
              Este enlace solo aparece en desarrollo. En producción llega por correo y no se muestra
              en pantalla.
            </div>
          </div>
          <div className="modal-foot">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                onSaved(`${name.trim()} quedó como cliente consolidado de ${account.code}.`)
              }
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
          <h3>Cliente consolidado de {account.code}</h3>
          <p>{account.name}</p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="cc-name">Nombre o razón social</label>
              <input
                id="cc-name"
                className="input"
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="cc-id">Cédula</label>
              <input
                id="cc-id"
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
              <label className="field-label" htmlFor="cc-email">Correo</label>
              <input
                id="cc-email"
                className="input"
                type="email"
                autoComplete="off"
                value={email}
                required
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="cc-phone">Teléfono</label>
              <input
                id="cc-phone"
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
                <label className="field-label" htmlFor="cc-province">Provincia</label>
                <select
                  id="cc-province"
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
                <label className="field-label" htmlFor="cc-canton">Cantón</label>
                <select
                  id="cc-canton"
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
                <label className="field-label" htmlFor="cc-district">Distrito</label>
                <select
                  id="cc-district"
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
                <label className="field-label" htmlFor="cc-address">Otras señas</label>
                <textarea
                  id="cc-address"
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

          <div className="banner warn" style={{ marginTop: 4 }}>
            Este cliente recibirá en Miami bajo la cuenta <strong>{account.code}</strong>, no bajo un
            sub-casillero de HS Global. La relación es de uno a uno y no se puede cambiar después.
          </div>
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
