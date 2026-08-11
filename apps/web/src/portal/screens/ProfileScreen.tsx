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
 * La dirección de entrega tiene su propio formulario y su propio endpoint
 * (`PATCH /clients/me/address`) porque no es un dato de contacto más: se guarda
 * completa (la terna provincia/cantón/distrito solo se valida junta) y solo se
 * puede mover con el casillero en calma, sin trámites en curso. El servidor es
 * quien manda; `canEditAddress` llega en el perfil para poder explicar el
 * candado ANTES de que el cliente llene el formulario, no al fallar el guardado.
 */
import { useEffect, useState } from 'react';
import {
  PROVINCES,
  deliveryAddressSchema,
  formatLockerCode,
  getCantons,
  getDistricts,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';

interface Address {
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
}

interface Profile extends Address {
  code: string;
  name: string;
  email: string;
  phone: string | null;
  idNumber: string;
  /** Trámites en curso; mientras haya alguno la dirección no se puede mover. */
  activeShipmentCount: number;
  canEditAddress: boolean;
}

const addressOf = (p: Profile): Address => ({
  provinceCode: p.provinceCode,
  cantonCode: p.cantonCode,
  districtCode: p.districtCode,
  addressLine: p.addressLine,
});

export function ProfileScreen({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // La dirección lleva su propio estado de formulario y sus propios mensajes: se
  // guarda por separado, así que un error suyo no debe aparecer sobre el bloque
  // de contacto (ni al revés).
  const [address, setAddress] = useState<Address | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressNotice, setAddressNotice] = useState<string | null>(null);
  const [savingAddress, setSavingAddress] = useState(false);

  function hydrate(data: Profile) {
    setProfile(data);
    setName(data.name);
    setIdNumber(data.idNumber);
    setPhone(data.phone ?? '');
    setEmail(data.email);
    setAddress(addressOf(data));
  }

  useEffect(() => {
    api
      .get<Profile>('/clients/me')
      .then(hydrate)
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

  /** Al cambiar provincia o cantón hay que soltar lo que colgaba debajo. */
  function setProvince(provinceCode: string) {
    setAddress((a) => a && { ...a, provinceCode, cantonCode: '', districtCode: '' });
  }
  function setCanton(cantonCode: string) {
    setAddress((a) => a && { ...a, cantonCode, districtCode: '' });
  }

  async function submitAddress(e: React.FormEvent) {
    e.preventDefault();
    if (!profile || !address) return;
    setAddressError(null);
    setAddressNotice(null);

    const unchanged =
      address.provinceCode === profile.provinceCode &&
      address.cantonCode === profile.cantonCode &&
      address.districtCode === profile.districtCode &&
      address.addressLine === profile.addressLine;
    if (unchanged) {
      setAddressNotice('No hay cambios que guardar.');
      return;
    }

    // Mismo esquema que usa la API: los mensajes de la terna incompleta o mal
    // combinada salen sin ir al servidor.
    const parsed = deliveryAddressSchema.safeParse(address);
    if (!parsed.success) {
      setAddressError(parsed.error.issues[0]?.message ?? 'Revisa los datos de la dirección.');
      return;
    }

    setSavingAddress(true);
    try {
      const updated = await api.patch<Profile>('/clients/me/address', parsed.data);
      hydrate(updated);
      setAddressNotice('Dirección de entrega actualizada.');
    } catch (err) {
      setAddressError(
        err instanceof ApiError ? err.message : 'No se pudo guardar la dirección.',
      );
      // Si el candado se cerró mientras el formulario estaba abierto (le entró un
      // trámite), se recarga el perfil para que la pantalla lo refleje en vez de
      // seguir ofreciendo un guardado que ya no procede.
      if (err instanceof ApiError && err.code === 'CLIENT_ADDRESS_LOCKED') {
        api.get<Profile>('/clients/me').then(hydrate).catch(() => {});
      }
    } finally {
      setSavingAddress(false);
    }
  }

  const canEditAddress = profile?.canEditAddress ?? false;
  const cantons = address?.provinceCode ? getCantons(address.provinceCode) : [];
  const districts = address?.cantonCode ? getDistricts(address.cantonCode) : [];

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Mi perfil</div>
          {/* Formato de etiqueta de envío: el mismo número que en "Mi casillero". */}
          {profile && <div className="count">Casillero {formatLockerCode(profile.code)}</div>}
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

          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      )}

      {/* Formulario aparte, no anidado: es otro endpoint y otra regla de guardado. */}
      {profile && address && (
        <form
          className="form-stack" onSubmit={submitAddress}
          style={{ maxWidth: 620, marginTop: 24 }}
        >
          <fieldset className="form-section" disabled={!canEditAddress}>
            <legend>Dirección de entrega</legend>

            {!canEditAddress && (
              <div className="banner info" style={{ marginBottom: 12 }}>
                {profile.activeShipmentCount === 1
                  ? 'No puedes cambiar tu dirección mientras tengas un trámite en curso: es a donde va el reparto. Podrás editarla cuando se entregue.'
                  : `No puedes cambiar tu dirección mientras tengas trámites en curso (${profile.activeShipmentCount}): es a donde va el reparto. Podrás editarla cuando se entreguen.`}
              </div>
            )}
            {addressError && (
              <div className="banner err" style={{ marginBottom: 12 }}>{addressError}</div>
            )}
            {addressNotice && (
              <div className="banner ok" style={{ marginBottom: 12 }}>{addressNotice}</div>
            )}

            <div className="form-grid cols-3">
              <div>
                <label className="field-label" htmlFor="p-province">Provincia</label>
                <select
                  id="p-province" className="input"
                  value={address.provinceCode} onChange={(e) => setProvince(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {PROVINCES.map((p) => (
                    <option key={p.code} value={p.code}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="p-canton">Cantón</label>
                <select
                  id="p-canton" className="input" disabled={!address.provinceCode}
                  value={address.cantonCode} onChange={(e) => setCanton(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {cantons.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="p-district">Distrito</label>
                <select
                  id="p-district" className="input" disabled={!address.cantonCode}
                  value={address.districtCode}
                  onChange={(e) => setAddress({ ...address, districtCode: e.target.value })}
                >
                  <option value="">Elige…</option>
                  {districts.map((d) => (
                    <option key={d.code} value={d.code}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-full">
                <label className="field-label" htmlFor="p-address-line">Otras señas</label>
                <textarea
                  id="p-address-line" className="input" rows={3} autoComplete="street-address"
                  value={address.addressLine}
                  onChange={(e) => setAddress({ ...address, addressLine: e.target.value })}
                  placeholder="Del super La Central 200 m norte, casa color celeste a mano derecha."
                />
              </div>
            </div>

            <div className="field-hint">
              El distrito define la ruta de reparto, por eso solo se puede cambiar cuando
              no tienes nada en camino.
            </div>

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={savingAddress}>
                {savingAddress ? 'Guardando…' : 'Guardar dirección'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}
