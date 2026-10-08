/**
 * Aceptar invitación (pagina publica /invitacion). Lee el token del
 * querystring, valida con el esquema compartido y fija la contrasena via
 * POST /api/auth/accept-invite. Al terminar, la cuenta queda lista para entrar.
 *
 * La usan el staff y los clientes a los que un administrador les abrio el
 * casillero. El enlace de estos ultimos trae `tipo=cliente`, que solo cambia el
 * texto: el token y el endpoint son los mismos.
 */
import { useState } from 'react';
import { acceptInviteSchema } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { PasswordField } from '../components/PasswordField';
import '../portal.css';

/** Ganchos del panel de marca: esta pantalla la ve el equipo interno. */
const POINTS = [
  { title: 'Acceso según tu rol', sub: 'Solo ves los módulos que te corresponden.' },
  { title: 'Operación en un solo lugar', sub: 'Paquetes, clientes y rutas desde el mismo portal.' },
  { title: 'Tu cuenta, tu contraseña', sub: 'La defines tú; nadie más la conoce.' },
];

/** Ganchos para el titular de un casillero que abrió un administrador. */
const CLIENT_POINTS = [
  { title: 'Tu casillero en Miami', sub: 'Compra en línea y envía a tu dirección de casillero.' },
  { title: 'Sigue tus paquetes', sub: 'Mira en qué estado va cada uno desde el portal.' },
  { title: 'Tu cuenta, tu contraseña', sub: 'La defines tú; nadie más la conoce.' },
];

/** Textos de la pantalla según quién recibe la invitación. */
const COPY = {
  staff: {
    points: POINTS,
    title: 'Bienvenido al equipo de HS Global',
    lead: 'Define tu contraseña y entra al portal para empezar a operar.',
    sub: 'Fue creada tu cuenta de staff. Define una contraseña para ingresar.',
    doneTitle: 'Bienvenido al equipo',
    doneLead: 'Tu cuenta de staff ya quedó activa.',
  },
  client: {
    points: CLIENT_POINTS,
    title: 'Bienvenido(a) a HS Global',
    lead: 'Define tu contraseña y entra al portal para ver tu casillero.',
    sub: 'Abrimos un casillero a tu nombre. Define una contraseña para ingresar.',
    doneTitle: 'Bienvenido(a) a HS Global',
    doneLead: 'Tu casillero ya quedó activo.',
  },
};

export default function AcceptInvite() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const token = params?.get('token') ?? '';
  const copy = params?.get('tipo') === 'cliente' ? COPY.client : COPY.staff;

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
      <AuthShell title={copy.doneTitle} lead={copy.doneLead} points={copy.points}>
        <div className="login-card fadeUp">
          <h1>¡Listo!</h1>
          <p className="sub">Tu contraseña quedó configurada. Ya puedes ingresar al portal.</p>
          <a className="btn btn-primary btn-lg" href="/app" style={{ width: '100%' }}>
            Ir a iniciar sesión
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={copy.title}
      lead={copy.lead}
      points={copy.points}
    >
      <form className="login-card fadeUp" onSubmit={submit}>
        <h1>Configura tu contraseña</h1>
        <p className="sub">{copy.sub}</p>

        {!token && <div className="banner err">El enlace no trae un token. Pídele al administrador uno nuevo.</div>}
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
          {busy ? 'Guardando…' : 'Activar mi cuenta'}
        </button>
      </form>
    </AuthShell>
  );
}
