/**
 * Login unico (customer + staff comparten mecanismo, docs/04 §2). El servidor
 * decide principal y rol; aqui solo enviamos email + contrasena.
 */
import { useState } from 'react';
import { loginSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { PasswordField } from '../components/PasswordField';

/** Ganchos del panel de marca: lo que da el portal una vez dentro. */
const POINTS = [
  { title: 'Tus paquetes en tiempo real', sub: 'Del prealerta a la entrega, con cada estado a la vista.' },
  { title: 'Facturas y tarifas claras', sub: 'Consulta lo que pagas por peso real, sin sorpresas.' },
  { title: 'Un solo acceso', sub: 'Clientes y equipo interno entran por la misma puerta.' },
];

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
    <AuthShell
      title="Tu casillero en Miami, siempre a la mano"
      lead="Entra al portal para seguir tus paquetes, revisar tus facturas y gestionar tus envíos de Miami a Costa Rica."
      points={POINTS}
    >
      <form className="login-card fadeUp" onSubmit={submit}>
        <h1>Bienvenido de vuelta</h1>
        <p className="sub">Ingresa con tu correo y contraseña.</p>

        {error && <div className="banner err">{error}</div>}

        <label className="field-label" htmlFor="email">Correo electrónico</label>
        <input
          id="email" className="input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@hsglobal.ltd"
        />

        <label className="field-label" htmlFor="password">Contraseña</label>
        <PasswordField id="password" value={password} onChange={setPassword} placeholder="••••••••" />

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>

        <p className="auth-alt">
          ¿Aún no tienes casillero? <a href="/registro">Créalo gratis</a>
        </p>
      </form>
    </AuthShell>
  );
}
