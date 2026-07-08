/* ============================================================
   HS GLOBAL — Portal shell (sidebar + topbar)
   ============================================================ */
const NAVS = {
  client: {
    label: 'Portal del cliente', roleLabel: 'Cliente',
    user: { name: 'Ana María Restrepo', sub: 'Casillero HS-1042' },
    groups: [
      ['', [['dashboard', 'home', 'Inicio'], ['prealerta', 'plus', 'Prealertar paquete'], ['rastreo', 'search', 'Rastrear'], ['pagos', 'card', 'Pagos']]],
      ['Cuenta', [['casillero', 'pin', 'Mi casillero'], ['historial', 'clock', 'Historial']]],
    ],
  },
  bodega: {
    label: 'Portal de bodega', roleLabel: 'Bodega',
    user: { name: 'Marta Quintero', sub: 'Operaria de bodega' },
    groups: [
      ['', [['recepcion', 'barcode', 'Recepción'], ['cola', 'box', 'Paquetes en bodega'], ['costos', 'dollar', 'Costos por aprobar']]],
    ],
  },
  entrega: {
    label: 'Portal de entrega', roleLabel: 'Entrega',
    user: { name: 'Paola Ríos', sub: 'Mensajera' },
    groups: [
      ['', [['ruta', 'truck', 'Ruta de hoy'], ['entregados', 'checkCircle', 'Entregados']]],
    ],
  },
  finanzas: {
    label: 'Portal de finanzas', roleLabel: 'Finanzas',
    user: { name: 'Andrés Lozano', sub: 'Analista financiero' },
    groups: [
      ['', [['reportes', 'receipt', 'Reportes'], ['facturacion', 'trending', 'Facturación Hacienda']]],
    ],
  },
  admin: {
    label: 'Panel administrador', roleLabel: 'Administrador',
    user: { name: 'Roberto Salas', sub: 'Administrador' },
    groups: [
      ['Operación', [['admin-overview', 'home', 'Resumen'], ['recepcion', 'barcode', 'Recepción'], ['cola', 'box', 'Paquetes'], ['costos', 'dollar', 'Costos'], ['ruta', 'truck', 'Entregas']]],
      ['Gestión', [['reportes', 'receipt', 'Reportes'], ['usuarios', 'users', 'Usuarios'], ['estados-api', 'globe', 'Módulo de estados']]],
    ],
  },
};

function PortalShell({ role, page, go, onLogout, children, title, actions, notifCount = 2 }) {
  const cfg = NAVS[role] || NAVS.client;
  const isAdmin = role === 'admin';
  const area = role === 'client' ? 'client' : 'admin';
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--paper)' }}>
      {/* Sidebar */}
      <aside style={{ width: 248, background: 'var(--dark)', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, height: '100vh', flexShrink: 0 }}>
        <div style={{ padding: '20px 20px 18px' }}>
          <button onClick={() => go('public', 'home')}><Logo size={20} dark /></button>
        </div>
        <div style={{ padding: '0 14px 8px' }}>
          <div style={{ background: 'var(--dark-2)', border: '1px solid var(--dark-line)', borderRadius: 10, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--ok)' }} />
            <span style={{ color: 'var(--on-dark)', fontSize: 12.5, fontWeight: 600 }}>{cfg.label}</span>
          </div>
        </div>
        <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 14px' }}>
          {cfg.groups.map(([gl, items], gi) => (
            <div key={gi} style={{ marginBottom: 14 }}>
              {gl && <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--on-dark-muted)', padding: '8px 10px 6px', opacity: .7 }}>{gl}</div>}
              {items.map(([k, ic, label]) => {
                const active = page === k;
                return (
                  <button key={k} onClick={() => go(area, k)} style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: '10px 11px', borderRadius: 9, marginBottom: 2,
                    background: active ? 'var(--brand)' : 'transparent', color: active ? '#fff' : 'var(--on-dark)',
                    fontSize: 13.5, fontWeight: active ? 700 : 500, transition: 'all .14s', textAlign: 'left',
                    boxShadow: active ? 'var(--sh-brand)' : 'none',
                  }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--dark-2)'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name={ic} size={17} color={active ? '#fff' : 'var(--on-dark-muted)'} />{label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        {/* user */}
        <div style={{ padding: 14, borderTop: '1px solid var(--dark-line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <Avatar name={cfg.user.name} size={38} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fff', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cfg.user.name}</div>
              <div style={{ color: 'var(--on-dark-muted)', fontSize: 11.5 }}>{cfg.user.sub}</div>
            </div>
            <button onClick={onLogout} title="Cerrar sesión" style={{ color: 'var(--on-dark-muted)', padding: 6, borderRadius: 8 }}
              onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'var(--dark-2)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--on-dark-muted)'; e.currentTarget.style.background = 'transparent'; }}><Icon name="logout" size={17} /></button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ height: 66, borderBottom: '1px solid var(--line)', background: 'oklch(0.985 0.004 263 / .85)', backdropFilter: 'blur(10px)', position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px' }}>
          <div>
            <h2 style={{ fontSize: 19, letterSpacing: '-.02em' }}>{title}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {actions}
            <button style={{ position: 'relative', width: 40, height: 40, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', color: 'var(--ink-2)' }}>
              <Icon name="bell" size={18} />
              {notifCount > 0 && <span style={{ position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 99, background: 'var(--danger)', border: '2px solid var(--surface)' }} />}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px 5px 6px', borderRadius: 99, background: 'var(--surface)', border: '1px solid var(--line)' }}>
              <Avatar name={cfg.user.name} size={28} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{cfg.roleLabel}</span>
            </div>
          </div>
        </header>
        <main style={{ flex: 1, padding: '28px 28px 48px', maxWidth: 1280, width: '100%', margin: '0 auto' }}>{children}</main>
      </div>
    </div>
  );
}

/* Reusable section card with header */
function Panel({ title, sub, action, children, pad = 24, style }) {
  return (
    <div className="card" style={{ ...style }}>
      {(title || action) && (
        <div className="between" style={{ padding: '18px 22px', borderBottom: '1px solid var(--line-2)' }}>
          <div>{title && <h3 style={{ fontSize: 16 }}>{title}</h3>}{sub && <p className="muted" style={{ fontSize: 13, marginTop: 3 }}>{sub}</p>}</div>
          {action}
        </div>
      )}
      <div style={{ padding: pad }}>{children}</div>
    </div>
  );
}

/* Stat tile */
function Stat({ icon, label, value, delta, tone = 'brand', sub }) {
  const [fg, bg] = TONE[tone] || TONE.brand;
  return (
    <div className="card" style={{ padding: 20 }}>
      <div className="between" style={{ marginBottom: 16 }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, background: bg, display: 'grid', placeItems: 'center' }}><Icon name={icon} size={20} color={fg} /></span>
        {delta && <span style={{ fontSize: 12, fontWeight: 700, color: delta[0] === '+' ? 'var(--ok)' : 'var(--muted)' }}>{delta}</span>}
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 28, letterSpacing: '-.02em' }}>{value}</div>
      <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{label}</div>
      {sub && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

Object.assign(window, { PortalShell, Panel, Stat, NAVS });
