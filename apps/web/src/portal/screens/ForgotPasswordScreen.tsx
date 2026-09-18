/**
 * "Olvidé mi contraseña" (pagina publica /recuperar). Pide el correo y dispara
 * el envio del enlace de restablecimiento.
 *
 * La pantalla de confirmacion se muestra SIEMPRE que la API responde bien, sin
 * decir si el correo estaba registrado: la API tampoco lo dice (ver
 * `auth.routes`, POST /auth/forgot-password) y contradecirla aqui anularia el
 * motivo de que calle.
 */
import { useState } from 'react';
import { forgotPasswordSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import '../portal.css';

/** Ganchos del panel de marca: aqui el mensaje es "no pierdes el casillero". */
const POINTS = [
  { title: 'Tu casillero te espera', sub: 'Recuperar el acceso no cambia nada de lo que ya tienes.' },
  { title: 'Enlace de un solo uso', sub: 'Vence pronto y solo sirve una vez.' },
  { title: 'Cierra lo que estuviera abierto', sub: 'Al cambiar la contraseña se cierran todas las sesiones.' },
];

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/forgot-password', parsed.data);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar el correo.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Revisa tu correo"
        lead="Te enviamos las instrucciones para volver a entrar a tu casillero."
        points={POINTS}
      >
        <div className="login-card fadeUp">
          <h1>Correo enviado</h1>
          <p className="sub">
            Si <strong>{email}</strong> tiene una cuenta en HS Global, te llegó un enlace para definir
            una contraseña nueva. Revisa también la carpeta de spam.
          </p>
          <a className="btn btn-primary btn-lg" href="/app" style={{ width: '100%' }}>
            Volver a iniciar sesión
          </a>
          <p className="auth-alt">
            ¿No llegó nada?{' '}
            <a
              href="/recuperar"
              onClick={(e) => {
                e.preventDefault();
                setSent(false);
              }}
            >
              Intenta de nuevo
            </a>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Recupera el acceso a tu casillero"
      lead="Escribe el correo con el que te registraste y te enviamos un enlace para definir una contraseña nueva."
      points={POINTS}
    >
      <form className="login-card fadeUp" onSubmit={submit}>
        <h1>¿Olvidaste tu contraseña?</h1>
        <p className="sub">Te enviaremos un enlace para restablecerla.</p>

        {error && <div className="banner err">{error}</div>}

        <label className="field-label" htmlFor="email">Correo electrónico</label>
        <input
          id="email" className="input" type="email" autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com"
        />

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Enviando…' : 'Enviarme el enlace'}
        </button>

        <p className="auth-alt">
          ¿Ya la recordaste? <a href="/app">Inicia sesión</a>
        </p>
      </form>
    </AuthShell>
  );
}
