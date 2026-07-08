/* ============================================================
   HS GLOBAL — Auth: login, register, email validation
   ============================================================ */

function AuthShell({ children, go }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
      {/* Brand side */}
      <div style={{ background: 'var(--dark)', position: 'relative', overflow: 'hidden', padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ position: 'absolute', right: -100, top: -80, width: 380, height: 380, borderRadius: '50%', background: 'radial-gradient(circle, oklch(0.55 0.20 263 / .4), transparent 70%)' }} />
        <div style={{ position: 'absolute', left: -120, bottom: -100, width: 340, height: 340, borderRadius: '50%', background: 'radial-gradient(circle, oklch(0.55 0.17 300 / .22), transparent 70%)' }} />
        <button onClick={() => go('public', 'home')} style={{ position: 'relative', zIndex: 1 }}><Logo size={24} dark /></button>
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 420 }}>
          <h2 style={{ fontSize: 38, color: '#fff', letterSpacing: '-.03em', lineHeight: 1.12 }}>Compra sin fronteras, rastrea sin límites.</h2>
          <p style={{ color: 'var(--on-dark-muted)', fontSize: 16, marginTop: 18, lineHeight: 1.6 }}>Gestiona tus prealertas, sigue cada paquete en tiempo real y paga en un solo lugar.</p>
          <div className="card" style={{ background: 'var(--dark-2)', border: '1px solid var(--dark-line)', padding: 18, marginTop: 32, display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--brand)', display: 'grid', placeItems: 'center' }}><Icon name="truck" size={21} color="#fff" /></span>
            <div><div style={{ color: '#fff', fontWeight: 700, fontSize: 14.5 }}>2 paquetes en camino</div><div style={{ color: 'var(--on-dark-muted)', fontSize: 13 }}>Tu próxima entrega: jueves</div></div>
            <div style={{ marginLeft: 'auto' }}><StatusPill statusKey="transito" /></div>
          </div>
        </div>
        <div style={{ position: 'relative', zIndex: 1, display: 'flex', gap: 18, color: 'var(--on-dark-muted)', fontSize: 13 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="shield" size={15} />Datos protegidos</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="lock" size={15} />Conexión segura</span>
        </div>
      </div>
      {/* Form side */}
      <div style={{ display: 'grid', placeItems: 'center', padding: 40, background: 'var(--paper)' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>{children}</div>
      </div>
    </div>
  );
}

/* ---------------- LOGIN ---------------- */
function Login({ go, onAuth }) {
  const [email, setEmail] = useState('ana.restrepo@gmail.com');
  const [pass, setPass] = useState('demo1234');
  const [show, setShow] = useState(false);
  const demos = [
    ['Cliente', 'client', 'user', 'Ana María — portal del cliente'],
    ['Bodega', 'bodega', 'box', 'Registro y costos de paquetes'],
    ['Entrega', 'entrega', 'truck', 'Confirmación de entregas'],
    ['Finanzas', 'finanzas', 'receipt', 'Reportes y facturación'],
    ['Administrador', 'admin', 'shield', 'Acceso total + usuarios'],
  ];
  return (
    <AuthShell go={go}>
      <div className="fadeUp">
        <h1 style={{ fontSize: 30, letterSpacing: '-.03em' }}>Bienvenid@ de vuelta</h1>
        <p className="muted" style={{ fontSize: 15, marginTop: 8 }}>Ingresa a tu portal HS Global.</p>
        <div style={{ marginTop: 28 }}>
          <label className="field-label">Correo electrónico</label>
          <input className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="tu@correo.com" />
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="between"><label className="field-label">Contraseña</label><button style={{ fontSize: 12.5, color: 'var(--brand)', fontWeight: 600 }}>¿Olvidaste tu contraseña?</button></div>
          <div style={{ position: 'relative' }}>
            <input className="input" type={show ? 'text' : 'password'} value={pass} onChange={e => setPass(e.target.value)} style={{ paddingRight: 44 }} />
            <button onClick={() => setShow(s => !s)} style={{ position: 'absolute', right: 12, top: 12, color: 'var(--faint)' }}><Icon name="eye" size={18} /></button>
          </div>
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 22, height: 48 }} onClick={() => onAuth('client')}>Iniciar sesión<Icon name="arrowR" size={17} /></button>
        <div style={{ textAlign: 'center', marginTop: 18, fontSize: 14, color: 'var(--muted)' }}>¿No tienes cuenta? <button onClick={() => go('auth', 'register')} style={{ color: 'var(--brand)', fontWeight: 700 }}>Crea tu casillero gratis</button></div>

        {/* demo roles */}
        <div style={{ marginTop: 30, borderTop: '1px solid var(--line)', paddingTop: 22 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 12 }}>Acceso de demostración por rol</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {demos.map(([label, role, ic, desc]) => (
              <button key={role} onClick={() => onAuth(role)} className="card" style={{ padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', transition: 'all .15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand)'; e.currentTarget.style.background = 'var(--brand-softer)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = 'var(--surface)'; }}>
                <span style={{ width: 36, height: 36, borderRadius: 10, background: role === 'client' ? 'var(--brand-soft)' : 'var(--paper-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={ic} size={18} color={role === 'client' ? 'var(--brand)' : 'var(--ink-2)'} /></span>
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div><div className="muted" style={{ fontSize: 12.5 }}>{desc}</div></div>
                <Icon name="chevR" size={16} color="var(--faint)" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </AuthShell>
  );
}

/* ---------------- REGISTER (multi-step + email validation) ---------------- */
function Register({ go, onAuth }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name: '', email: '', pass: '', city: 'Bogotá' });
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [resent, setResent] = useState(false);
  const refs = useRef([]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const realCode = '4827';

  const steps = ['Tus datos', 'Verifica tu correo', 'Listo'];
  const valid0 = form.name.trim() && /\S+@\S+\.\S+/.test(form.email) && form.pass.length >= 6;
  const codeStr = code.join('');

  const onCode = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const nc = [...code]; nc[i] = v; setCode(nc);
    if (v && i < 5) refs.current[i + 1]?.focus();
  };

  return (
    <AuthShell go={go}>
      <div className="fadeUp">
        {/* progress */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
          {steps.map((s, i) => (
            <div key={s} style={{ flex: 1 }}>
              <div style={{ height: 5, borderRadius: 99, background: i <= step ? 'var(--brand)' : 'var(--line)', transition: 'background .3s' }} />
              <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 7, color: i <= step ? 'var(--ink-2)' : 'var(--faint)' }}>{s}</div>
            </div>
          ))}
        </div>

        {step === 0 && (
          <div className="fadeIn">
            <h1 style={{ fontSize: 28, letterSpacing: '-.03em' }}>Crea tu casillero gratis</h1>
            <p className="muted" style={{ fontSize: 14.5, marginTop: 8 }}>Tu dirección de Miami estará lista en segundos.</p>
            <div style={{ marginTop: 24, display: 'grid', gap: 14 }}>
              <div><label className="field-label">Nombre completo</label><input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ej. Ana María Restrepo" /></div>
              <div><label className="field-label">Correo electrónico</label><input className="input" value={form.email} onChange={e => set('email', e.target.value)} placeholder="tu@correo.com" /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 12 }}>
                <div><label className="field-label">Contraseña</label><input className="input" type="password" value={form.pass} onChange={e => set('pass', e.target.value)} placeholder="Mínimo 6 caracteres" /></div>
                <div><label className="field-label">Ciudad</label>
                  <select className="input" value={form.city} onChange={e => set('city', e.target.value)} style={{ paddingRight: 8 }}>
                    {['Bogotá', 'Medellín', 'Cali', 'Barranquilla'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <label style={{ display: 'flex', gap: 10, marginTop: 18, fontSize: 13, color: 'var(--muted)', alignItems: 'flex-start' }}>
              <input type="checkbox" defaultChecked style={{ marginTop: 2, accentColor: 'var(--brand)' }} />
              <span>Acepto los <button onClick={() => go('public', 'legal', { doc: 'terminos' })} style={{ color: 'var(--brand)', fontWeight: 600 }}>Términos de uso</button> y la <button onClick={() => go('public', 'legal', { doc: 'privacidad' })} style={{ color: 'var(--brand)', fontWeight: 600 }}>Política de privacidad</button>.</span>
            </label>
            <button className="btn btn-primary" disabled={!valid0} style={{ width: '100%', marginTop: 22, height: 48 }} onClick={() => setStep(1)}>Continuar<Icon name="arrowR" size={17} /></button>
            <div style={{ textAlign: 'center', marginTop: 16, fontSize: 14, color: 'var(--muted)' }}>¿Ya tienes cuenta? <button onClick={() => go('auth', 'login')} style={{ color: 'var(--brand)', fontWeight: 700 }}>Inicia sesión</button></div>
          </div>
        )}

        {step === 1 && (
          <div className="fadeIn">
            <span style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center', marginBottom: 20 }}><Icon name="mail" size={27} color="var(--brand)" /></span>
            <h1 style={{ fontSize: 28, letterSpacing: '-.03em' }}>Verifica tu correo</h1>
            <p className="muted" style={{ fontSize: 14.5, marginTop: 8, lineHeight: 1.55 }}>Enviamos un código de 4 dígitos a <strong style={{ color: 'var(--ink-2)' }}>{form.email || 'tu correo'}</strong>. Ingrésalo para activar tu cuenta.</p>
            <div className="card" style={{ background: 'var(--info-soft)', border: 'none', padding: '10px 14px', marginTop: 16, fontSize: 13, color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="zap" size={15} />Demo: tu código es <strong className="mono">{realCode}</strong></div>
            <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'center' }}>
              {[0, 1, 2, 3].map(i => (
                <input key={i} ref={el => refs.current[i] = el} value={code[i]} onChange={e => onCode(i, e.target.value)}
                  onKeyDown={e => e.key === 'Backspace' && !code[i] && i > 0 && refs.current[i - 1]?.focus()}
                  maxLength={1} inputMode="numeric" className="mono" style={{ width: 58, height: 66, textAlign: 'center', fontSize: 28, fontWeight: 700, borderRadius: 12, border: '1.5px solid var(--line)', background: 'var(--surface)', outline: 'none', color: 'var(--ink)' }}
                  onFocus={e => e.target.style.borderColor = 'var(--brand)'} onBlur={e => e.target.style.borderColor = 'var(--line)'} />
              ))}
            </div>
            <button className="btn btn-primary" disabled={code.slice(0, 4).join('').length < 4} style={{ width: '100%', marginTop: 26, height: 48 }}
              onClick={() => { if (code.slice(0, 4).join('') === realCode) setStep(2); else { setResent('err'); } }}>Verificar y activar cuenta</button>
            {resent === 'err' && <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10, textAlign: 'center' }}>Código incorrecto. Intenta de nuevo (es {realCode}).</div>}
            <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13.5, color: 'var(--muted)' }}>¿No te llegó? <button onClick={() => setResent('ok')} style={{ color: 'var(--brand)', fontWeight: 700 }}>{resent === 'ok' ? 'Reenviado ✓' : 'Reenviar código'}</button></div>
          </div>
        )}

        {step === 2 && (
          <div className="fadeIn" style={{ textAlign: 'center' }}>
            <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--ok-soft)', display: 'grid', placeItems: 'center', margin: '0 auto 22px', animation: 'fadeUp .5s' }}><Icon name="checkCircle" size={40} color="oklch(0.45 0.12 160)" /></span>
            <h1 style={{ fontSize: 28, letterSpacing: '-.03em' }}>¡Cuenta activada!</h1>
            <p className="muted" style={{ fontSize: 15, marginTop: 10, lineHeight: 1.6 }}>Tu casillero en Miami ya está listo. Esta es tu dirección de envío:</p>
            <div className="card" style={{ padding: 20, marginTop: 20, textAlign: 'left', background: 'var(--paper-2)' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>Tu casillero · HS-1042</div>
              <div className="mono" style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink)' }}>
                {form.name || 'Ana María Restrepo'} · HS-1042<br />
                8200 NW 27th St, Suite 140<br />
                Doral, Miami, FL 33122<br />
                United States · +1 (555) 010-0000
              </div>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 22, height: 48 }} onClick={() => onAuth('client')}>Ir a mi portal<Icon name="arrowR" size={17} /></button>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

Object.assign(window, { Login, Register, AuthShell });
