/**
 * Login unico (customer + staff comparten mecanismo, docs/04 §2). El servidor
 * decide principal y rol; aqui solo enviamos email + contrasena.
 */
import { useState } from 'react';
import { loginSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/login', parsed.data);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card fadeUp" onSubmit={submit}>
        <img className="login-logo" src="/logo.png" alt="HS Global Courier" />
        <p className="sub">Portal interno. Ingresa con tu cuenta.</p>

        {error && <div className="banner err">{error}</div>}

        <label className="field-label" htmlFor="email">Correo electrónico</label>
        <input
          id="email" className="input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@hsglobal.ltd"
        />

        <label className="field-label" htmlFor="password">Contraseña</label>
        <input
          id="password" className="input" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
        />

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
