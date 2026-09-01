/**
 * Alta y edición de una cuenta exclusiva del operador de Miami
 * (permiso provider_accounts.manage, solo Admin).
 *
 * Los datos que pide son EXACTAMENTE los que el operador entrega al crear una
 * cuenta dedicada: el código de casillero, a nombre de quién está, y el usuario y
 * la contraseña con los que se pide su token. El `client_id`, el `client_secret`
 * y el `app_id` van aparte y vacíos por defecto, porque lo normal es que la
 * cuenta use los de la aplicación de HS Global; solo se llenan si el operador le
 * dio credenciales propias a esa empresa.
 *
 * LOS SECRETOS NO SE MUESTRAN NUNCA. Al editar, los campos de contraseña y
 * secreto salen vacíos y "vacío" significa **dejarlo como está**, no borrarlo:
 * el portal no los recibe, así que no podría reenviarlos, y mandarlos vacíos
 * dejaría la cuenta sin poder autenticarse en la siguiente corrida del robot.
 */
import { useState } from 'react';
import type { ProviderAccountDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { ModalOverlay } from '../components/ModalOverlay';
import { PasswordField } from '../components/PasswordField';

interface Props {
  mode: 'create' | 'edit';
  row?: ProviderAccountDto;
  onClose: () => void;
  onSaved: (message: string) => void;
}

export function ProviderAccountFormModal({ mode, row, onClose, onSaved }: Props) {
  const isCreate = mode === 'create';
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [username, setUsername] = useState(row?.username ?? '');
  const [password, setPassword] = useState('');
  const [providerCustomerId, setProviderCustomerId] = useState(
    row?.providerCustomerId != null ? String(row.providerCustomerId) : '',
  );
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [appId, setAppId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // El campo de contrasena no es un <input required>, asi que el alta lo
    // comprueba aqui en vez de dejar que el servidor devuelva un 400.
    if (isCreate && !password) {
      setError('La contraseña de la cuenta es obligatoria.');
      return;
    }

    const customerId = providerCustomerId.trim();
    if (customerId && !/^\d+$/.test(customerId)) {
      setError('El id de cliente en el operador son solo dígitos.');
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      username: username.trim(),
      // `undefined` = no viaja = no se toca. Solo el alta lo exige.
      ...(password ? { password } : {}),
      ...(oauthClientId.trim() ? { oauthClientId: oauthClientId.trim() } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      ...(appId.trim() ? { appId: appId.trim() } : {}),
      providerCustomerId: customerId ? Number(customerId) : null,
      ...(isCreate ? { code: code.trim(), password } : {}),
    };

    setSaving(true);
    try {
      if (isCreate) {
        await api.post('/provider-accounts', body);
        onSaved(`Cuenta ${code.trim().toUpperCase()} registrada. Ahora crea su cliente consolidado.`);
      } else {
        await api.patch(`/provider-accounts/${row?.id}`, body);
        onSaved(`Cuenta ${row?.code} actualizada.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la cuenta.');
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>{isCreate ? 'Nueva cuenta del operador' : 'Editar cuenta'}</h3>
          <p>
            {isCreate
              ? 'Los datos de conexión los entrega el operador de Miami al crear la cuenta dedicada.'
              : `${row?.code} · ${row?.name}`}
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="pa-code">Código de casillero</label>
              <input
                id="pa-code"
                className="input mono"
                placeholder="p. ej. SJO009623"
                value={code}
                required
                /* El código identifica la cuenta y queda sellado en cada paquete
                   que importa: cambiarlo después convertiría en huérfano todo lo
                   que ya entró por ella. */
                disabled={!isCreate}
                onChange={(e) => setCode(e.target.value)}
              />
              {!isCreate && (
                <div className="field-hint">
                  El código no se cambia: es el origen sellado en los paquetes ya importados.
                </div>
              )}
            </div>
            <div>
              <label className="field-label" htmlFor="pa-name">A nombre de</label>
              <input
                id="pa-name"
                className="input"
                placeholder="p. ej. ZUCA"
                value={name}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="field-pair">
            <div>
              <label className="field-label" htmlFor="pa-username">Usuario o correo</label>
              <input
                id="pa-username"
                className="input"
                autoComplete="off"
                placeholder="usuario@empresa.com"
                value={username}
                required
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label" htmlFor="pa-password">Contraseña</label>
              <PasswordField
                id="pa-password"
                value={password}
                ariaRequired={isCreate}
                autoComplete="new-password"
                placeholder={isCreate ? '' : 'Déjala vacía para no cambiarla'}
                onChange={setPassword}
              />
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="pa-customer">
              Id de cliente en el operador (opcional)
            </label>
            <input
              id="pa-customer"
              className="input"
              inputMode="numeric"
              placeholder="p. ej. 7536"
              value={providerCustomerId}
              onChange={(e) => setProviderCustomerId(e.target.value)}
            />
            <div className="field-hint">
              Solo hace falta para dar de alta destinatarios en esa cuenta, que aquí no se hace: sus
              sub-casilleros los crea el operador. Se guarda por si se necesita más adelante.
            </div>
          </div>

          <fieldset className="form-section">
            <legend>Credenciales de aplicación propias (opcional)</legend>
            <div className="field-hint" style={{ marginBottom: 10 }}>
              Déjalas vacías si el operador no le dio unas propias a esta empresa: la cuenta usará
              las de la aplicación de HS Global, que es lo normal.
              {!isCreate && row?.hasOwnAppCredentials && (
                <> Esta cuenta <strong>ya tiene</strong> credenciales propias guardadas.</>
              )}
            </div>
            <div className="field-pair">
              <div>
                <label className="field-label" htmlFor="pa-client-id">client_id</label>
                <input
                  id="pa-client-id"
                  className="input mono"
                  autoComplete="off"
                  value={oauthClientId}
                  onChange={(e) => setOauthClientId(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="pa-client-secret">client_secret</label>
                <PasswordField
                  id="pa-client-secret"
                  value={oauthClientSecret}
                  autoComplete="new-password"
                  placeholder={isCreate ? '' : 'Vacío = no se cambia'}
                  onChange={setOauthClientSecret}
                />
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <label className="field-label" htmlFor="pa-app-id">app_id</label>
              <input
                id="pa-app-id"
                className="input mono"
                autoComplete="off"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              />
            </div>
          </fieldset>

          <div className="banner" style={{ marginTop: 4 }}>
            La contraseña y el secreto se guardan cifrados y no vuelven a mostrarse. Si los pierdes,
            hay que pedírselos otra vez al operador.
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Guardando…' : isCreate ? 'Registrar cuenta' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
