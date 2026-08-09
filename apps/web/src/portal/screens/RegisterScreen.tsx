/**
 * Creación de casillero (página pública /registro). Asistente de 3 pasos,
 * portado del prototipo: datos → verificación del correo → casillero listo.
 *
 * La validación es la MISMA que aplica la API: `registerSchema` de
 * @courier/shared. Aquí solo adelanta el error al usuario; la frontera real
 * sigue siendo el servidor.
 *
 * Los selects de provincia/cantón/distrito están encadenados y salen del
 * catálogo territorial compartido: todos los usuarios son de Costa Rica.
 */
import { useRef, useState } from 'react';
import {
  PROVINCES,
  getCantons,
  getDistricts,
  formatLockerCode,
  registerSchema,
  verifySchema,
  warehouseAddressLines,
} from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { AuthShell } from '../components/AuthShell';
import { PasswordField } from '../components/PasswordField';
import '../portal.css';

const STEPS = ['Tus datos', 'Verifica tu correo', 'Listo'] as const;

/** Ganchos del panel de marca: la promesa del casillero, como en la landing. */
const POINTS = [
  { title: 'Dirección de Miami tax free', sub: 'Compra en cualquier tienda de EE. UU. sin impuestos de estado.' },
  { title: 'Vuelos todos los días', sub: 'Salidas diarias desde Miami hacia Costa Rica.' },
  { title: 'Tarifa por peso real', sub: 'Pagas solo lo que pesa tu paquete, sin sorpresas.' },
];

/**
 * Dirección del casillero en Miami: es fija de HS Global y sale de
 * @courier/shared. No se copia aquí: una segunda copia es una segunda verdad, y
 * durante un tiempo esta pantalla mostró una dirección distinta a la de "Mi
 * casillero".
 */
const MIAMI_ADDRESS = warehouseAddressLines();

const CODE_LENGTH = 6;

/**
 * Marca de campo obligatorio. Es puramente visual (`aria-hidden`): a la
 * tecnología asistiva el dato se lo da el `aria-required` del propio control.
 */
const Req = (): React.ReactElement => (
  <span className="req" aria-hidden="true">*</span>
);

interface FormState {
  name: string;
  idNumber: string;
  email: string;
  phone: string;
  provinceCode: string;
  cantonCode: string;
  districtCode: string;
  addressLine: string;
  password: string;
  acceptsTerms: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  idNumber: '',
  email: '',
  phone: '',
  provinceCode: '',
  cantonCode: '',
  districtCode: '',
  addressLine: '',
  password: '',
  acceptsTerms: false,
};

export default function RegisterScreen() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [code, setCode] = useState<string[]>(Array<string>(CODE_LENGTH).fill(''));
  const [lockerCode, setLockerCode] = useState('');
  // Solo llega fuera de produccion: la API no lo expone con NODE_ENV=production.
  const [devCode, setDevCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }));

  // Al cambiar de provincia o cantón, lo que colgaba debajo deja de ser válido.
  const setProvince = (provinceCode: string): void =>
    setForm((f) => ({ ...f, provinceCode, cantonCode: '', districtCode: '' }));
  const setCanton = (cantonCode: string): void => setForm((f) => ({ ...f, cantonCode, districtCode: '' }));

  const cantons = form.provinceCode ? getCantons(form.provinceCode) : [];
  const districts = form.cantonCode ? getDistricts(form.cantonCode) : [];

  /** Paso 1: crea el casillero. La API responde con el código HS-####. */
  async function submitData(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    const parsed = registerSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos del formulario.');
      return;
    }

    setBusy(true);
    try {
      const created = await api.post<{ userId: string; code: string; verificationCode?: string }>(
        '/auth/register',
        parsed.data,
      );
      setLockerCode(created.code);
      setDevCode(created.verificationCode ?? '');
      setStep(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el casillero.');
    } finally {
      setBusy(false);
    }
  }

  /** Paso 2: confirma el código de 6 dígitos y activa la cuenta. */
  async function submitCode(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    // El email ya pasó por el esquema en el paso 1: se normaliza igual aquí.
    const parsed = verifySchema.safeParse({ email: form.email, code: code.join('') });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'El código no es válido.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/verify', parsed.data);
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo verificar el código.');
    } finally {
      setBusy(false);
    }
  }

  function onCodeChange(index: number, value: string): void {
    if (!/^\d?$/.test(value)) return;
    setCode((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    if (value && index < CODE_LENGTH - 1) codeRefs.current[index + 1]?.focus();
  }

  function onCodeKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Backspace' && !code[index] && index > 0) codeRefs.current[index - 1]?.focus();
  }

  /** Reparte un código completo entre las casillas y deja el foco al final. */
  function fillCode(digits: string): void {
    const next = Array<string>(CODE_LENGTH).fill('');
    for (let i = 0; i < digits.length; i += 1) next[i] = digits[i] ?? '';
    setCode(next);
    codeRefs.current[Math.min(digits.length, CODE_LENGTH - 1)]?.focus();
  }

  /** Pegar el código completo desde el correo llena las 6 casillas de una vez. */
  function onCodePaste(e: React.ClipboardEvent<HTMLInputElement>): void {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!digits) return;
    e.preventDefault();
    fillCode(digits);
  }

  return (
    <AuthShell
      title="Crea tu casillero gratis en menos de un minuto"
      lead="Te damos una dirección en Miami para comprar en cualquier tienda de EE. UU. y recibirla en la puerta de tu casa en Costa Rica."
      points={POINTS}
      wide={step === 0}
    >
      {/* Solo el paso de datos usa la tarjeta ancha; verificacion y cierre siguen angostos. */}
      <div className={`login-card register-card fadeUp${step === 0 ? ' is-wide' : ''}`}>
        <ol className="steps">
          {STEPS.map((label, i) => (
            <li key={label} className={i <= step ? 'done' : undefined}>
              <div className="step-bar" />
              <div className="step-label">{label}</div>
            </li>
          ))}
        </ol>

        {error && <div className="banner err">{error}</div>}

        {step === 0 && (
          <form className="fadeIn" onSubmit={submitData}>
            <h1>Crea tu casillero gratis</h1>
            <p className="sub">
              Tu dirección de Miami estará lista en segundos. Los campos con{' '}
              <span className="req">*</span> son obligatorios.
            </p>

            <fieldset className="form-section">
              <legend>Tus datos</legend>
              <div className="form-grid">
                <div className="col-full">
                  <label className="field-label" htmlFor="name">Nombre completo <Req /></label>
                  <input
                    id="name" className="input" autoComplete="name" aria-required
                    value={form.name} onChange={(e) => set('name', e.target.value)}
                    placeholder="Ej. Ana María Rodríguez"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="idNumber">Cédula <Req /></label>
                  <input
                    id="idNumber" className="input" inputMode="numeric" aria-required
                    value={form.idNumber} onChange={(e) => set('idNumber', e.target.value)} placeholder="1-2345-6789"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="phone">Teléfono <Req /></label>
                  <input
                    id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" aria-required
                    value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="8888 8888"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="email">Correo electrónico <Req /></label>
                  <input
                    id="email" className="input" type="email" autoComplete="email" aria-required
                    value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="tu@correo.com"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="password">Contraseña <Req /></label>
                  <PasswordField
                    id="password" autoComplete="new-password" ariaRequired
                    value={form.password} onChange={(v) => set('password', v)}
                    placeholder="Mínimo 6 caracteres"
                  />
                </div>
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>Dirección de entrega</legend>
              <div className="form-grid cols-3">
                <div>
                  <label className="field-label" htmlFor="provinceCode">Provincia <Req /></label>
                  <select
                    id="provinceCode" className="input" aria-required
                    value={form.provinceCode} onChange={(e) => setProvince(e.target.value)}
                  >
                    <option value="">Elige…</option>
                    {PROVINCES.map((p) => (
                      <option key={p.code} value={p.code}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="cantonCode">Cantón <Req /></label>
                  <select
                    id="cantonCode" className="input" disabled={!form.provinceCode} aria-required
                    value={form.cantonCode} onChange={(e) => setCanton(e.target.value)}
                  >
                    <option value="">Elige…</option>
                    {cantons.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor="districtCode">Distrito <Req /></label>
                  <select
                    id="districtCode" className="input" disabled={!form.cantonCode} aria-required
                    value={form.districtCode} onChange={(e) => set('districtCode', e.target.value)}
                  >
                    <option value="">Elige…</option>
                    {districts.map((d) => (
                      <option key={d.code} value={d.code}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="col-full">
                  <label className="field-label" htmlFor="addressLine">Otras señas <Req /></label>
                  <textarea
                    id="addressLine" className="input" rows={3} autoComplete="street-address" aria-required
                    value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)}
                    placeholder="Del super La Central 200 m norte, casa color celeste a mano derecha."
                  />
                </div>
              </div>
            </fieldset>

            <div className="form-actions">
              <label className="check-row">
                <input
                  type="checkbox" checked={form.acceptsTerms}
                  onChange={(e) => set('acceptsTerms', e.target.checked)}
                />
                <span>
                  Acepto los <a href="/legal/terminos">Términos de uso</a> y la{' '}
                  <a href="/legal/privacidad">Política de privacidad</a>.
                </span>
              </label>

              <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
                {busy ? 'Creando tu casillero…' : 'Crear mi casillero'}
              </button>
            </div>

            <p className="auth-alt">
              ¿Ya tienes cuenta? <a href="/app">Inicia sesión</a>
            </p>
          </form>
        )}

        {step === 1 && (
          <form className="fadeIn" onSubmit={submitCode}>
            <h1>Verifica tu correo</h1>
            <p className="sub">
              Enviamos un código de {CODE_LENGTH} dígitos a <strong>{form.email}</strong>. Ingrésalo para activar tu
              cuenta.
            </p>

            {/* Muleta de desarrollo: mientras no hay SMTP, el código no llega a
                ningún lado salvo el log. La API solo lo manda fuera de producción. */}
            {devCode && (
              <div className="banner warn" style={{ marginTop: 16 }}>
                Código de verificación (dev):{' '}
                <strong style={{ fontFamily: 'var(--font-mono)', letterSpacing: '.08em' }}>{devCode}</strong>{' '}
                <button
                  type="button"
                  onClick={() => fillCode(devCode)}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'inherit', font: 'inherit', textDecoration: 'underline', fontWeight: 700,
                  }}
                >
                  Usarlo
                </button>
              </div>
            )}

            <div className="code-inputs">
              {code.map((digit, i) => (
                <input
                  // Las casillas son posicionales y no se reordenan: el índice es su identidad.
                  key={i}
                  ref={(el) => { codeRefs.current[i] = el; }}
                  value={digit}
                  onChange={(e) => onCodeChange(i, e.target.value)}
                  onKeyDown={(e) => onCodeKeyDown(i, e)}
                  onPaste={onCodePaste}
                  maxLength={1}
                  inputMode="numeric"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Dígito ${i + 1} del código`}
                />
              ))}
            </div>

            <button className="btn btn-primary btn-lg" type="submit" disabled={busy || code.join('').length < CODE_LENGTH}>
              {busy ? 'Verificando…' : 'Verificar y activar cuenta'}
            </button>
          </form>
        )}

        {step === 2 && (
          <div className="fadeIn" style={{ textAlign: 'center' }}>
            <h1>¡Cuenta activada!</h1>
            <p className="sub">Tu casillero en Miami ya está listo. Esta es tu dirección de envío:</p>

            <div className="locker-card">
              <div className="locker-title">Tu casillero · {formatLockerCode(lockerCode)}</div>
              <div className="locker-address">
                {/* Mismo formato que la línea "Nombre" de "Mi casillero". */}
                {form.name} {formatLockerCode(lockerCode)}
                {MIAMI_ADDRESS.map((line) => (
                  <span key={line}>
                    <br />
                    {line}
                  </span>
                ))}
              </div>
            </div>

            <a className="btn btn-primary btn-lg" href="/app" style={{ width: '100%' }}>
              Ir a mi portal
            </a>
          </div>
        )}
      </div>
    </AuthShell>
  );
}
