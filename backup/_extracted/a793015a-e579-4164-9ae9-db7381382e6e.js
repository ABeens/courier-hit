/* ============================================================
   HS GLOBAL — Public marketing site
   ============================================================ */

function PublicNav({ go, page }) {
  const links = [
    ['home', 'Inicio'], ['about', 'Quiénes somos'], ['services', 'Servicios'], ['track', 'Rastrear'],
  ];
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'oklch(0.985 0.004 263 / .82)', backdropFilter: 'blur(12px)', borderBottom: '1px solid var(--line)' }}>
      <div style={{ maxWidth: 'var(--maxw)', margin: '0 auto', padding: '0 28px', height: 70, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => go('public', 'home')}><Logo size={21} /></button>
        <nav style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {links.map(([k, label]) => (
            <button key={k} onClick={() => go('public', k)} style={{
              padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              color: page === k ? 'var(--brand)' : 'var(--ink-2)', background: page === k ? 'var(--brand-soft)' : 'transparent',
            }}>{label}</button>
          ))}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => go('auth', 'login')}>Iniciar sesión</button>
          <button className="btn btn-primary btn-sm" onClick={() => go('auth', 'register')}>Crear casillero<Icon name="arrowR" size={15} /></button>
        </div>
      </div>
    </header>
  );
}

function PublicFooter({ go }) {
  const col = (title, items) => (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--on-dark-muted)', marginBottom: 16 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {items.map(([label, fn]) => <button key={label} onClick={fn} style={{ textAlign: 'left', fontSize: 14, color: 'var(--on-dark)', opacity: .85 }}>{label}</button>)}
      </div>
    </div>
  );
  return (
    <footer style={{ background: 'var(--dark)', color: 'var(--on-dark)', marginTop: 0 }}>
      <div style={{ maxWidth: 'var(--maxw)', margin: '0 auto', padding: '64px 28px 36px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 40 }}>
          <div>
            <Logo size={22} dark />
            <p style={{ color: 'var(--on-dark-muted)', fontSize: 14, marginTop: 18, maxWidth: 280, lineHeight: 1.6 }}>Tu casillero en Miami para comprar en cualquier tienda de EE. UU. y recibir en la puerta de tu casa, con rastreo en tiempo real.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <span className="chip" style={{ background: 'var(--dark-2)', border: '1px solid var(--dark-line)', color: 'var(--on-dark)' }}><Icon name="shield" size={13} />Pagos seguros</span>
              <span className="chip" style={{ background: 'var(--dark-2)', border: '1px solid var(--dark-line)', color: 'var(--on-dark)' }}><Icon name="globe" size={13} />Cobertura global</span>
            </div>
          </div>
          {col('Servicios', DATA.SERVICES.slice(0, 4).map(s => [s.name, () => go('public', 'service', { id: s.id })]))}
          {col('Empresa', [['Quiénes somos', () => go('public', 'about')], ['Servicios', () => go('public', 'services')], ['Rastrear paquete', () => go('public', 'track')], ['Contacto', () => go('public', 'about')]])}
          {col('Legal', [['Términos de uso', () => go('public', 'legal', { doc: 'terminos' })], ['Política de privacidad', () => go('public', 'legal', { doc: 'privacidad' })], ['Iniciar sesión', () => go('auth', 'login')]])}
        </div>
        <div style={{ borderTop: '1px solid var(--dark-line)', marginTop: 48, paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--on-dark-muted)' }}>© 2026 HS Global Ltd · Miami · Bogotá</span>
          <span style={{ fontSize: 13, color: 'var(--on-dark-muted)' }}>info@hsgloballtd.com · +1 (555) 010-0000</span>
        </div>
      </div>
    </footer>
  );
}

/* ---------------- HOME ---------------- */
function PubHome({ go }) {
  const [tn, setTn] = useState('');
  const wrap = { maxWidth: 'var(--maxw)', margin: '0 auto', padding: '0 28px' };
  return (
    <div className="fadeIn">
      {/* Hero */}
      <section style={{ position: 'relative', overflow: 'hidden', background: 'linear-gradient(180deg, var(--brand-softer), var(--paper) 70%)' }}>
        <div style={{ ...wrap, paddingTop: 76, paddingBottom: 64, display: 'grid', gridTemplateColumns: '1.05fr .95fr', gap: 56, alignItems: 'center' }}>
          <div className="fadeUp">
            <span className="chip" style={{ background: 'var(--surface)', borderColor: 'var(--brand-soft)', color: 'var(--brand-600)' }}><span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--ok)' }} />+12.000 paquetes entregados este año</span>
            <h1 style={{ fontSize: 56, lineHeight: 1.04, marginTop: 22, letterSpacing: '-0.035em' }}>Compra en EE.&nbsp;UU.<br /><span style={{ color: 'var(--brand)' }}>Recíbelo</span> en casa.</h1>
            <p style={{ fontSize: 18, color: 'var(--muted)', marginTop: 20, maxWidth: 460, lineHeight: 1.55 }}>Tu casillero en Miami para comprar donde quieras. Te lo consolidamos, despachamos y rastreas cada paso en tiempo real.</p>
            <div style={{ display: 'flex', gap: 12, marginTop: 30 }}>
              <button className="btn btn-primary btn-lg" onClick={() => go('auth', 'register')}>Crear mi casillero gratis<Icon name="arrowR" size={17} /></button>
              <button className="btn btn-ghost btn-lg" onClick={() => go('public', 'services')}>Ver servicios</button>
            </div>
            {/* public tracking bar */}
            <div className="card" style={{ marginTop: 36, padding: 8, display: 'flex', gap: 8, alignItems: 'center', boxShadow: 'var(--sh-2)' }}>
              <div style={{ paddingLeft: 10, color: 'var(--faint)' }}><Icon name="search" size={19} /></div>
              <input className="input" value={tn} onChange={e => setTn(e.target.value)} placeholder="Rastrea con tu número de tracking…" style={{ border: 'none', boxShadow: 'none', flex: 1 }}
                onKeyDown={e => e.key === 'Enter' && go('public', 'track', { tn: tn || '1Z999AA10123456784' })} />
              <button className="btn btn-dark" onClick={() => go('public', 'track', { tn: tn || '1Z999AA10123456784' })}>Rastrear</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--faint)', marginTop: 10, paddingLeft: 4 }}>Prueba con <button className="mono" onClick={() => setTn('1Z999AA10123456784')} style={{ color: 'var(--brand)', fontWeight: 600 }}>1Z999AA10123456784</button></div>
          </div>
          {/* hero visual: live tracking card mock */}
          <div className="fadeUp" style={{ animationDelay: '.08s' }}>
            <div className="card" style={{ padding: 22, boxShadow: 'var(--sh-3)', transform: 'rotate(1.2deg)' }}>
              <div className="between" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><CarrierBadge carrier="UPS" /><span className="mono" style={{ fontSize: 12.5, color: 'var(--muted)' }}>1Z999AA101…6784</span></div>
                <StatusPill statusKey="transito" />
              </div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Audífonos Sony WH-1000XM5</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 18 }}>1.2 kg · Bodega Miami → Bogotá</div>
              <StepStrip statusKey="transito" />
            </div>
            <div className="card" style={{ padding: 16, marginTop: 16, marginLeft: 40, transform: 'rotate(-1.5deg)', boxShadow: 'var(--sh-2)', display: 'flex', alignItems: 'center', gap: 13 }}>
              <span style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--ok-soft)', display: 'grid', placeItems: 'center' }}><Icon name="checkCircle" size={20} color="oklch(0.45 0.12 160)" /></span>
              <div><div style={{ fontWeight: 700, fontSize: 14 }}>¡Paquete entregado!</div><div className="muted" style={{ fontSize: 12.5 }}>Lote SHEIN · Hace 2 días</div></div>
            </div>
          </div>
        </div>
      </section>

      {/* trust bar */}
      <section style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', background: 'var(--surface)' }}>
        <div style={{ ...wrap, display: 'flex', justifyContent: 'space-between', gap: 24, padding: '26px 28px', flexWrap: 'wrap' }}>
          {[['box', '+12k', 'paquetes/año'], ['globe', '8', 'transportistas'], ['zap', '3–6', 'días aéreo'], ['shield', '100%', 'pago seguro'], ['star', '4.9', 'satisfacción']].map(([ic, big, small]) => (
            <div key={small} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name={ic} size={20} color="var(--brand)" /></span>
              <div><div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22, letterSpacing: '-.02em' }}>{big}</div><div className="muted" style={{ fontSize: 12.5 }}>{small}</div></div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={{ ...wrap, padding: '80px 28px' }}>
        <div style={{ textAlign: 'center', maxWidth: 620, margin: '0 auto 52px' }}>
          <span className="chip"><Icon name="zap" size={13} color="var(--brand)" />Cómo funciona</span>
          <h2 style={{ fontSize: 38, marginTop: 16, letterSpacing: '-.03em' }}>Tu compra, en cuatro pasos</h2>
          <p className="muted" style={{ fontSize: 16, marginTop: 12 }}>Sin complicaciones, sin sorpresas. Tú compras, nosotros nos encargamos del resto.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 20 }}>
          {[
            ['user', 'Crea tu casillero', 'Regístrate y recibe tu dirección de Miami al instante, sin costo.'],
            ['cart', 'Compra y prealerta', 'Compra en cualquier tienda y avísanos qué viene en camino.'],
            ['truck', 'Procesamos y enviamos', 'Recibimos, consolidamos y despachamos hacia tu país.'],
            ['home', 'Recibe en casa', 'Paga en línea y te lo entregamos en la puerta de tu hogar.'],
          ].map(([ic, t, d], i) => (
            <div key={t} className="card" style={{ padding: 24, position: 'relative' }}>
              <span className="mono" style={{ position: 'absolute', top: 18, right: 20, fontSize: 13, fontWeight: 700, color: 'var(--brand-soft)', WebkitTextStroke: '1px var(--brand)' }}>0{i + 1}</span>
              <span style={{ width: 46, height: 46, borderRadius: 13, background: 'var(--brand)', display: 'grid', placeItems: 'center', marginBottom: 18, boxShadow: 'var(--sh-brand)' }}><Icon name={ic} size={22} color="#fff" /></span>
              <div style={{ fontWeight: 700, fontSize: 16.5, marginBottom: 7, fontFamily: 'var(--font-display)' }}>{t}</div>
              <p className="muted" style={{ fontSize: 14, lineHeight: 1.55 }}>{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Services preview */}
      <section style={{ background: 'var(--paper-2)', borderTop: '1px solid var(--line)' }}>
        <div style={{ ...wrap, padding: '80px 28px' }}>
          <div className="between" style={{ marginBottom: 36, alignItems: 'flex-end' }}>
            <div>
              <span className="chip"><Icon name="layers" size={13} color="var(--brand)" />Servicios</span>
              <h2 style={{ fontSize: 38, marginTop: 16, letterSpacing: '-.03em' }}>Todo lo que necesitas para importar</h2>
            </div>
            <button className="btn btn-ghost" onClick={() => go('public', 'services')}>Ver los 5 servicios<Icon name="arrowR" size={16} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
            {DATA.SERVICES.map(s => (
              <button key={s.id} onClick={() => go('public', 'service', { id: s.id })} className="card" style={{ padding: 24, textAlign: 'left', transition: 'all .18s', cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--sh-3)'; e.currentTarget.style.transform = 'translateY(-3px)'; }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--sh-1)'; e.currentTarget.style.transform = 'none'; }}>
                <div className="between">
                  <span style={{ width: 48, height: 48, borderRadius: 13, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name={s.icon} size={23} color="var(--brand)" /></span>
                  {s.tag && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--brand-soft)', padding: '4px 10px', borderRadius: 99 }}>{s.tag}</span>}
                </div>
                <div style={{ fontWeight: 700, fontSize: 17, marginTop: 18, fontFamily: 'var(--font-display)' }}>{s.name}</div>
                <p className="muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 1.55 }}>{s.short}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 16, color: 'var(--brand)', fontWeight: 600, fontSize: 13.5 }}>Conocer más<Icon name="chevR" size={15} /></div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ ...wrap, padding: '80px 28px' }}>
        <div style={{ background: 'var(--dark)', borderRadius: 'var(--r-xl)', padding: '56px 56px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', right: -60, top: -60, width: 280, height: 280, borderRadius: '50%', background: 'radial-gradient(circle, oklch(0.55 0.20 263 / .35), transparent 70%)' }} />
          <div style={{ position: 'relative', maxWidth: 560 }}>
            <h2 style={{ fontSize: 40, color: '#fff', letterSpacing: '-.03em', lineHeight: 1.1 }}>Tu próxima compra te está esperando en Miami.</h2>
            <p style={{ color: 'var(--on-dark-muted)', fontSize: 17, marginTop: 16, lineHeight: 1.55 }}>Crea tu casillero gratis en menos de dos minutos y empieza a comprar sin fronteras.</p>
            <div style={{ display: 'flex', gap: 12, marginTop: 30 }}>
              <button className="btn btn-primary btn-lg" onClick={() => go('auth', 'register')}>Crear casillero gratis<Icon name="arrowR" size={17} /></button>
              <button className="btn btn-lg" onClick={() => go('public', 'track')} style={{ background: 'var(--dark-2)', color: '#fff', border: '1px solid var(--dark-line)' }}>Rastrear un paquete</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { PublicNav, PublicFooter, PubHome });
