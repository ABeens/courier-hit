/**
 * Pantalla "Mi perfil" — Requerimientos Parte 2, "Editar Perfil".
 *
 * Se editan tres de los cuatro campos del manual: nombre, cédula y teléfono.
 *
 * El correo está TEMPORALMENTE bloqueado (se muestra, no se edita): cambiarlo
 * cambia el usuario de login y obliga a verificar la nueva dirección, y hoy no
 * existe pantalla para hacerlo fuera del registro. Todo lo que sostenía ese
 * cambio (aviso, envío del patch, cierre de sesión) queda comentado en su sitio
 * para reactivarlo junto con el paso de verificación. Ver `clients.service.ts`.
 *
 * La dirección se muestra pero no se edita: el distrito determina la ruta de
 * reparto, así que moverla es una gestión operativa que pasa por soporte.
 */
import { useEffect, useState } from 'react';
import { findCanton, findDistrict, findProvince } from '@courier/shared';
import { ApiError, api } from '../lib/api';

interface Profile {
  code: string;
  name: string;
  email: string;
  phone: string | null;
  idNumber: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
}

export function ProfileScreen({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<Profile>('/clients/me')
      .then((data) => {
        setProfile(data);
        setName(data.name);
        setIdNumber(data.idNumber);
        setPhone(data.phone ?? '');
        setEmail(data.email);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar tu perfil.'),
      );
  }, []);

  /* TODO(correo): vuelve cuando el cambio de correo se reactive (ver clients.service.ts).
  const emailChanged = profile != null && email.trim().toLowerCase() !== profile.email;
  */

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile) return;
    setError(null);
    setNotice(null);
    setSaving(true);

    // Solo se manda lo que cambió: un PATCH con todo obligaría al servidor a
    // revalidar la cédula y el correo en cada guardado, aunque no se tocaran.
    const patch: Record<string, string> = {};
    if (name !== profile.name) patch.name = name;
    if (idNumber !== profile.idNumber) patch.idNumber = idNumber;
    if (phone !== (profile.phone ?? '')) patch.phone = phone;
    // if (emailChanged) patch.email = email;

    if (Object.keys(patch).length === 0) {
      setNotice('No hay cambios que guardar.');
      setSaving(false);
      return;
    }

    try {
      await api.patch('/clients/me', patch);

      /* TODO(correo): parte del cambio de correo bloqueado. Hoy el servidor
         siempre responde emailChanged: false, así que no hay nada que ramificar
         (y por eso `onLoggedOut` queda sin uso mientras el bloqueo esté puesto).

      const result = await api.patch<{ emailChanged: boolean }>('/clients/me', patch);
      if (result.emailChanged) {
        // La sesión ya está invalidada del lado del servidor: se sale para no
        // dejar al usuario en una pantalla que va a fallar en la próxima acción.
        onLoggedOut();
        return;
      }
      */

      setNotice('Perfil actualizado.');
      setProfile({ ...profile, name, idNumber, phone });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el perfil.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Mi perfil</div>
          {profile && <div className="count">Casillero {profile.code}</div>}
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      {profile && (
        <form className="form-stack" onSubmit={submit} style={{ maxWidth: 620 }}>
          <div>
            <label className="field-label" htmlFor="p-name">Nombre completo</label>
            <input
              id="p-name" className="input" value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="p-id">Cédula</label>
              <input
                id="p-id" className="input mono" value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="p-phone">Teléfono</label>
              <input
                id="p-phone" className="input mono" value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="p-email">Correo electrónico</label>
            {/* Bloqueado temporalmente: falta el paso de verificación en el flujo. */}
            <input id="p-email" className="input" type="email" value={email} disabled />
            <div className="field-hint">
              Para cambiar tu correo, contáctanos: es el usuario con el que ingresas.
            </div>

            {/* TODO(correo): al reactivar, volver a poner onChange y esta advertencia.
            <input
              id="p-email" className="input" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailChanged && (
              <div className="banner warn" style={{ marginTop: 8 }}>
                Al cambiar tu correo cerraremos la sesión y te enviaremos un código para
                verificar la nueva dirección.
              </div>
            )}
            */}
          </div>

          <div className="card-sec">
            <div className="card-sec-title">Dirección de entrega</div>
            <dl className="card-sec-fields">
              <div className="card-item-field">
                <span className="field-label">Provincia</span>
                <span>{findProvince(profile.provinceCode)?.name}</span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Cantón</span>
                <span>{findCanton(profile.cantonCode)?.name}</span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Distrito</span>
                <span>{findDistrict(profile.districtCode)?.name}</span>
              </div>
              <div className="card-item-field">
                <span className="field-label">Otras señas</span>
                <span>{profile.addressLine}</span>
              </div>
            </dl>
            <div className="field-hint">
              Para cambiar tu dirección de entrega, contáctanos: afecta la ruta de reparto.
            </div>
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
