/**
 * Restablecer contraseña (pagina publica /restablecer). Lee el token del
 * querystring, valida con el esquema compartido y fija la contrasena via
 * POST /api/auth/reset-password.
 *
 * Es la gemela de `AcceptInvite`: el mismo formulario sobre la misma tabla de
 * tokens, con otro copy. Se mantienen separadas porque una le habla a un
 * empleado que estrena cuenta y la otra a un cliente que perdio la suya.
 */
import { useState } from 'react';
import { resetPasswordSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { PasswordField } from '../components/PasswordField';
import '../portal.css';

/** Ganchos del panel de marca: tranquilizar, no vender. */
const POINTS = [
  { title: 'Nada se perdió', sub: 'Tus paquetes y tu historial siguen donde estaban.' },
  { title: 'Solo tú la conoces', sub: 'Nadie del equipo ve ni digita tu contraseña.' },
  { title: 'Sesiones cerradas', sub: 'Al guardarla, cualquier sesión abierta queda revocada.' },
];

export default function ResetPasswordScreen() {
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
      setError('El enlace no trae un token válido.');
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    const parsed = resetPasswordSchema.safeParse({ token, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/reset-password', parsed.data);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar la contraseña.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell
        title="Listo, vuelve a entrar"
        lead="Tu contraseña quedó actualizada."
        points={POINTS}
      >
        <div className="login-card fadeUp">
          <h1>¡Contraseña actualizada!</h1>
          <p className="sub">
            Ya puedes ingresar con tu contraseña nueva. Si tenías sesiones abiertas en otros
            dispositivos, se cerraron.
          </p>
          <a className="btn btn-primary btn-lg" href="/app" style={{ width: '100%' }}>
            Ir a iniciar sesión
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Define tu contraseña nueva"
      lead="Elige una contraseña y vuelve a entrar al portal para seguir tus paquetes."
      points={POINTS}
    >
      <form className="login-card fadeUp" onSubmit={submit}>
        <h1>Nueva contraseña</h1>
        <p className="sub">Escríbela dos veces para confirmar que quedó como quieres.</p>

        {!token && (
          <div className="banner err">
            El enlace no trae un token. Pide uno nuevo desde <a href="/recuperar">¿Olvidaste tu contraseña?</a>
          </div>
        )}
        {error && <div className="banner err">{error}</div>}

        <label className="field-label" htmlFor="pw">Nueva contraseña</label>
        <PasswordField
          id="pw" autoComplete="new-password"
          value={password} onChange={setPassword} placeholder="Mínimo 6 caracteres"
        />

        <label className="field-label" htmlFor="pw2">Repite la contraseña</label>
        <PasswordField
          id="pw2" autoComplete="new-password"
          value={confirm} onChange={setConfirm} placeholder="••••••••"
        />

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !token}>
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>

        <p className="auth-alt">
          ¿El enlace ya venció? <a href="/recuperar">Pide uno nuevo</a>
        </p>
      </form>
    </AuthShell>
  );
}
