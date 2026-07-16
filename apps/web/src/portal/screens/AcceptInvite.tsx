/**
 * Aceptar invitación de staff (pagina publica /invitacion). Lee el token del
 * querystring, valida con el esquema compartido y fija la contrasena via
 * POST /api/auth/accept-invite. Al terminar, la cuenta queda lista para entrar.
 */
import { useState } from 'react';
import { acceptInviteSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import '../portal.css';

export default function AcceptInvite() {
  const token =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('token') ?? ''
      : '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('El enlace no trae un token de invitación válido.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    const parsed = acceptInviteSchema.safeParse({ token, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/accept-invite', parsed.data);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo fijar la contraseña.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="login-wrap">
        <div className="login-card fadeUp">
          <h1>¡Listo!</h1>
          <p className="sub">Tu contraseña quedó configurada. Ya puedes ingresar al portal.</p>
          <a className="btn btn-primary btn-lg" href="/app" style={{ width: '100%' }}>
            Ir a iniciar sesión
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card fadeUp" onSubmit={submit}>
        <h1>Configura tu contraseña</h1>
        <p className="sub">Fue creada tu cuenta de staff. Define una contraseña para ingresar.</p>

        {!token && <div className="banner err">El enlace no trae un token. Pídele al administrador uno nuevo.</div>}
        {error && <div className="banner err">{error}</div>}

        <label className="field-label" htmlFor="pw">Nueva contraseña</label>
        <input
          id="pw" className="input" type="password" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 6 caracteres"
        />

        <label className="field-label" htmlFor="pw2">Repite la contraseña</label>
        <input
          id="pw2" className="input" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••"
        />

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !token}>
          {busy ? 'Guardando…' : 'Activar mi cuenta'}
        </button>
      </form>
    </div>
  );
}
