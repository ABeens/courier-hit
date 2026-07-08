/* ============================================================
   HS GLOBAL — Client portal
   ============================================================ */
function ClientPortal({ page, go, pkgs, onPay, onPrealert, toast }) {
  const [detail, setDetail] = useState(null);
  const [payTarget, setPayTarget] = useState(null);
  // Al navegar con el menú, el detalle/modal abierto debe cerrarse; de lo
  // contrario el panel de detalle (que tiene prioridad) tapa la nueva sección
  // y el menú "deja de funcionar".
  useEffect(() => { setDetail(null); setPayTarget(null); }, [page]);
  const mine = pkgs.filter(p => p.clientCode === 'HS-1042');
  const sel = detail ? mine.find(p => p.id === detail) : null;

  const titleMap = { dashboard: 'Inicio', prealerta: 'Prealertar paquete', rastreo: 'Rastrear', pagos: 'Pagos', casillero: 'Mi casillero', historial: 'Historial' };

  const doPay = (pkg) => { onPay(pkg); toast('Pago confirmado — el paquete entró en ruta', 'ok'); };

  let body;
  if (sel) {
    body = <PkgDetailPanel pkg={sel} onBack={() => setDetail(null)} footer={
      sel.status === 'pendiente_pago' ? <button className="btn btn-primary" style={{ height: 46 }} onClick={() => setPayTarget(sel)}><Icon name="card" size={17} />Pagar {DATA.money(sel.costs.total)}</button>
        : sel.status === 'entregado' ? <div className="card" style={{ padding: '14px 16px', background: 'var(--ok-soft)', border: 'none', display: 'flex', alignItems: 'center', gap: 10, color: 'oklch(0.40 0.12 160)', fontWeight: 600, fontSize: 14 }}><Icon name="checkCircle" size={18} />Entregado correctamente</div>
          : <button className="btn btn-ghost" style={{ height: 46 }} onClick={() => go('client', 'rastreo')}><Icon name="refresh" size={16} />Actualizar estado</button>
    } />;
  } else if (page === 'dashboard') body = <ClientDash mine={mine} go={go} onSelect={setDetail} onPay={setPayTarget} />;
  else if (page === 'prealerta') body = <Prealerta onPrealert={onPrealert} toast={toast} go={go} />;
  else if (page === 'rastreo') body = <ClientRastreo mine={mine} onSelect={setDetail} />;
  else if (page === 'pagos') body = <ClientPagos mine={mine} onPay={setPayTarget} onSelect={setDetail} />;
  else if (page === 'casillero') body = <Casillero />;
  else if (page === 'historial') body = <ClientHistorial mine={mine} onSelect={setDetail} />;
  else body = <ClientDash mine={mine} go={go} onSelect={setDetail} onPay={setPayTarget} />;

  const actions = page === 'dashboard' ? <button className="btn btn-primary btn-sm" onClick={() => go('client', 'prealerta')}><Icon name="plus" size={15} />Prealertar</button> : null;

  return (
    <PortalShell role="client" page={page} go={go} onLogout={() => go('public', 'home')} title={sel ? 'Detalle del paquete' : titleMap[page] || 'Inicio'} actions={actions} notifCount={2}>
      {body}
      <PayModal pkg={payTarget} open={!!payTarget} onClose={() => setPayTarget(null)} onPaid={doPay} />
    </PortalShell>
  );
}

/* ---- Dashboard ---- */
function ClientDash({ mine, go, onSelect, onPay }) {
  const active = mine.filter(p => !['entregado'].includes(p.status));
  const pendPay = mine.filter(p => p.status === 'pendiente_pago');
  const delivered = mine.filter(p => p.status === 'entregado');
  const spent = mine.filter(p => p.paid).reduce((s, p) => s + (p.costs?.total || 0), 0);
  return (
    <div className="fadeIn">
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 26, letterSpacing: '-.03em' }}>Hola, Ana María 👋</h1>
        <p className="muted" style={{ fontSize: 15, marginTop: 4 }}>Tienes {active.length} paquetes en movimiento y {pendPay.length} esperando pago.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <Stat icon="truck" label="En camino" value={active.length} tone="brand" sub="Hacia Colombia" />
        <Stat icon="card" label="Por pagar" value={pendPay.length} tone="warn" sub={pendPay.length ? DATA.money(pendPay.reduce((s, p) => s + p.costs.total, 0)) + ' total' : 'Todo al día'} />
        <Stat icon="checkCircle" label="Entregados" value={delivered.length} tone="ok" sub="Este año" />
        <Stat icon="dollar" label="Total invertido" value={DATA.money(spent)} tone="info" sub="En envíos pagados" />
      </div>

      {pendPay.length > 0 && (
        <div className="card" style={{ padding: '18px 22px', marginBottom: 20, background: 'var(--warn-soft)', border: '1px solid oklch(0.86 0.07 75)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ width: 46, height: 46, borderRadius: 12, background: 'var(--surface)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={22} color="oklch(0.52 0.13 60)" /></span>
            <div><div style={{ fontWeight: 700, fontSize: 15.5 }}>{pendPay.length} paquete(s) listos, esperando tu pago</div><div className="muted" style={{ fontSize: 13.5 }}>No salen a entrega hasta que completes el pago.</div></div>
          </div>
          <button className="btn btn-primary" onClick={() => onPay(pendPay[0])}>Pagar ahora · {DATA.money(pendPay[0].costs.total)}</button>
        </div>
      )}

      <div className="between" style={{ marginBottom: 14 }}>
        <h3 style={{ fontSize: 17 }}>Paquetes activos</h3>
        <button onClick={() => go('client', 'historial')} style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--brand)', display: 'flex', alignItems: 'center', gap: 4 }}>Ver todos<Icon name="chevR" size={14} /></button>
      </div>
      {active.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {active.map(p => <PkgCard key={p.id} pkg={p} onClick={() => onSelect(p.id)} />)}
        </div>
      ) : <EmptyState icon="box" title="Sin paquetes activos" sub="Cuando prealertes o recibamos algo aparecerá aquí." cta="Prealertar paquete" onCta={() => go('client', 'prealerta')} />}
    </div>
  );
}

function EmptyState({ icon, title, sub, cta, onCta }) {
  return (
    <div className="card" style={{ padding: 48, textAlign: 'center' }}>
      <span style={{ width: 60, height: 60, borderRadius: 17, background: 'var(--paper-2)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}><Icon name={icon} size={26} color="var(--faint)" /></span>
      <h3 style={{ fontSize: 18 }}>{title}</h3>
      <p className="muted" style={{ fontSize: 14, marginTop: 7, maxWidth: 360, margin: '7px auto 0', lineHeight: 1.55 }}>{sub}</p>
      {cta && <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={onCta}>{cta}</button>}
    </div>
  );
}

/* ---- Prealerta ---- */
function Prealerta({ onPrealert, toast, go }) {
  const [f, setF] = useState({ carrier: 'Amazon', tracking: '', desc: '', declared: '', pieces: 1, observations: '' });
  const [file, setFile] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const valid = f.tracking.trim().length > 4 && f.desc.trim() && f.declared;

  const submit = () => {
    const np = onPrealert({ ...f, declared: +f.declared, weight: +(Math.random() * 4 + 0.5).toFixed(1), invoice: file });
    setDone(np);
    toast('Prealerta registrada correctamente', 'ok');
  };

  if (done) {
    return (
      <div className="fadeIn" style={{ maxWidth: 560, margin: '20px auto' }}>
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--ok-soft)', display: 'grid', placeItems: 'center', margin: '0 auto 20px' }}><Icon name="checkCircle" size={40} color="oklch(0.45 0.12 160)" /></span>
          <h2 style={{ fontSize: 24 }}>¡Paquete prealertado!</h2>
          <p className="muted" style={{ fontSize: 15, marginTop: 10, lineHeight: 1.55 }}>Lo vincularemos automáticamente cuando llegue a nuestra bodega de Miami.</p>
          <div className="card" style={{ padding: 18, background: 'var(--paper-2)', marginTop: 22, textAlign: 'left' }}>
            <div className="between" style={{ marginBottom: 10 }}><CarrierBadge carrier={done.carrier} /><StatusPill statusKey="prealertado" size="sm" /></div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{done.desc}</div>
            <div className="mono muted" style={{ fontSize: 12.5, marginTop: 3 }}>{done.tracking}</div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setF({ carrier: 'Amazon', tracking: '', desc: '', declared: '', pieces: 1, observations: '' }); setFile(null); setDone(null); }}>Prealertar otro</button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => go('client', 'dashboard')}>Ir al inicio</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fadeIn" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="card" style={{ padding: '16px 20px', marginBottom: 18, display: 'flex', gap: 12, alignItems: 'center', background: 'var(--info-soft)', border: 'none' }}>
        <Icon name="zap" size={20} color="var(--info)" />
        <div style={{ fontSize: 13.5, color: 'var(--info)' }}><strong>Prealertar</strong> es avisarnos qué viene en camino. Así lo identificamos al instante cuando llegue a Miami.</div>
      </div>
      <Panel title="Datos del paquete" sub="Completa la información de tu compra">
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 14 }}>
            <div><label className="field-label">Transportista</label>
              <select className="input" value={f.carrier} onChange={e => set('carrier', e.target.value)}>{DATA.CARRIERS.map(c => <option key={c}>{c}</option>)}</select>
            </div>
            <div><label className="field-label"># de tracking *</label><input className="input mono" value={f.tracking} onChange={e => set('tracking', e.target.value)} placeholder="Ej. 1Z999AA10123456784" /></div>
          </div>
          <div><label className="field-label">Descripción del contenido *</label><input className="input" value={f.desc} onChange={e => set('desc', e.target.value)} placeholder="Ej. Audífonos Sony WH-1000XM5" /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div><label className="field-label">Valor declarado (USD) *</label><input className="input mono" type="number" value={f.declared} onChange={e => set('declared', e.target.value)} placeholder="0.00" /></div>
            <div><label className="field-label">Número de piezas</label><input className="input mono" type="number" min="1" value={f.pieces} onChange={e => set('pieces', e.target.value)} /></div>
          </div>
          {/* invoice upload */}
          <div>
            <label className="field-label">Factura (archivo adjunto)</label>
            {file ? (
              <div className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--paper-2)' }}>
                <span style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name="file" size={18} color="var(--brand)" /></span>
                <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{file}</div><div className="muted" style={{ fontSize: 12 }}>248 KB · PDF</div></div>
                <button onClick={() => setFile(null)} style={{ color: 'var(--faint)', padding: 6 }}><Icon name="x" size={17} /></button>
              </div>
            ) : (
              <button onClick={() => setFile('factura-' + (f.carrier || 'compra').toLowerCase() + '.pdf')} style={{ width: '100%', border: '1.5px dashed var(--line)', borderRadius: 'var(--r-sm)', padding: '22px', background: 'var(--paper-2)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, transition: 'all .15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand)'; e.currentTarget.style.background = 'var(--brand-softer)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = 'var(--paper-2)'; }}>
                <Icon name="download" size={22} color="var(--brand)" style={{ transform: 'rotate(180deg)' }} />
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)' }}>Arrastra o haz clic para adjuntar tu factura</span>
                <span className="faint" style={{ fontSize: 12 }}>PDF, JPG o PNG · máx. 10 MB</span>
              </button>
            )}
          </div>
          <div><label className="field-label">Observaciones</label><textarea className="input" rows={2} value={f.observations} onChange={e => set('observations', e.target.value)} placeholder="Ej. Producto frágil, requiere cuidado especial…" /></div>
        </div>
      </Panel>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={() => go('client', 'dashboard')}>Cancelar</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}><Icon name="check" size={16} />Registrar prealerta</button>
      </div>
    </div>
  );
}

/* ---- Rastreo (in-portal) ---- */
function ClientRastreo({ mine, onSelect }) {
  const [q, setQ] = useState('');
  const filtered = q ? mine.filter(p => (p.tracking + p.desc).toLowerCase().includes(q.toLowerCase())) : mine;
  return (
    <div className="fadeIn">
      <div className="card" style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, maxWidth: 560 }}>
        <div style={{ paddingLeft: 10, color: 'var(--faint)' }}><Icon name="search" size={19} /></div>
        <input className="input mono" value={q} onChange={e => setQ(e.target.value)} placeholder="Busca por tracking o descripción…" style={{ border: 'none', boxShadow: 'none', flex: 1 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
        {filtered.map(p => <PkgCard key={p.id} pkg={p} onClick={() => onSelect(p.id)} />)}
      </div>
      {!filtered.length && <EmptyState icon="search" title="Sin resultados" sub="No encontramos paquetes con ese criterio." />}
    </div>
  );
}

/* ---- Pagos ---- */
function ClientPagos({ mine, onPay, onSelect }) {
  const pend = mine.filter(p => p.status === 'pendiente_pago');
  const paid = mine.filter(p => p.paid);
  return (
    <div className="fadeIn">
      <Panel title="Pendientes de pago" sub="Estos paquetes están listos y solo esperan tu pago" style={{ marginBottom: 18 }} pad={pend.length ? 0 : 24}>
        {pend.length ? (
          <Table head={['Paquete', 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Total', align: 'right' }, '']}>
            {pend.map(p => <PkgRow key={p.id} pkg={p} onClick={() => onSelect(p.id)} right={<button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); onPay(p); }}>Pagar {DATA.money(p.costs.total)}</button>} />)}
          </Table>
        ) : <div style={{ textAlign: 'center', padding: 20 }}><Icon name="checkCircle" size={32} color="var(--ok)" /><div style={{ fontWeight: 600, marginTop: 10 }}>¡Estás al día!</div><div className="muted" style={{ fontSize: 13.5 }}>No tienes pagos pendientes.</div></div>}
      </Panel>
      <Panel title="Historial de pagos" pad={paid.length ? 0 : 24}>
        {paid.length ? (
          <Table head={['Paquete', 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Pagado', align: 'right' }, '']}>
            {paid.map(p => <PkgRow key={p.id} pkg={p} onClick={() => onSelect(p.id)} />)}
          </Table>
        ) : <div className="muted" style={{ textAlign: 'center', fontSize: 14 }}>Aún no tienes pagos registrados.</div>}
      </Panel>
    </div>
  );
}

/* ---- Casillero ---- */
function Casillero() {
  const lines = [['Nombre', 'Ana María Restrepo · HS-1042'], ['Dirección', '8200 NW 27th St, Suite 140'], ['Ciudad', 'Doral, Miami, FL 33122'], ['País', 'United States'], ['Teléfono', '+1 (555) 010-0000']];
  return (
    <div className="fadeIn" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
      <Panel title="Tu casillero en Miami" sub="Usa esta dirección al comprar en cualquier tienda de EE. UU.">
        <div className="card" style={{ padding: 20, background: 'var(--dark)', border: 'none' }}>
          {lines.map(([l, v]) => (
            <div key={l} style={{ display: 'flex', gap: 14, padding: '9px 0', borderBottom: '1px solid var(--dark-line)' }}>
              <span style={{ width: 90, color: 'var(--on-dark-muted)', fontSize: 12.5, flexShrink: 0 }}>{l}</span>
              <span className="mono" style={{ color: '#fff', fontSize: 13.5, fontWeight: 500 }}>{v}</span>
            </div>
          ))}
          <button className="btn" style={{ width: '100%', marginTop: 16, background: 'var(--brand)', color: '#fff' }}><Icon name="file" size={16} />Copiar dirección completa</button>
        </div>
      </Panel>
      <Panel title="Cómo usar tu casillero">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {[['Compra en cualquier tienda', 'Amazon, eBay, SHEIN, Walmart… usa tu dirección de Miami como destino.'], ['Pon tu código HS-1042', 'Incluye siempre tu código en la línea 2 de la dirección para identificar tu paquete.'], ['Prealértalo aquí', 'Registra el tracking para que lo vinculemos al instante cuando llegue.'], ['Recibe en casa', 'Te avisamos, pagas el envío y lo entregamos en tu puerta.']].map(([t, d], i) => (
            <div key={t} style={{ display: 'flex', gap: 13 }}>
              <span className="mono" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{i + 1}</span>
              <div><div style={{ fontWeight: 700, fontSize: 14.5 }}>{t}</div><div className="muted" style={{ fontSize: 13.5, marginTop: 2, lineHeight: 1.5 }}>{d}</div></div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ---- Historial ---- */
function ClientHistorial({ mine, onSelect }) {
  const [filter, setFilter] = useState('todos');
  const tabs = [['todos', 'Todos'], ['activo', 'Activos'], ['pendiente_pago', 'Por pagar'], ['entregado', 'Entregados']];
  const filtered = mine.filter(p => filter === 'todos' ? true : filter === 'activo' ? !['entregado', 'pendiente_pago'].includes(p.status) : p.status === filter);
  return (
    <div className="fadeIn">
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={{ padding: '8px 15px', borderRadius: 99, fontSize: 13.5, fontWeight: 600, background: filter === k ? 'var(--ink)' : 'var(--surface)', color: filter === k ? '#fff' : 'var(--ink-2)', border: '1px solid', borderColor: filter === k ? 'var(--ink)' : 'var(--line)' }}>{l}</button>
        ))}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <Table head={['Paquete', 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Costo', align: 'right' }, '']}>
          {filtered.map(p => <PkgRow key={p.id} pkg={p} onClick={() => onSelect(p.id)} />)}
        </Table>
        {!filtered.length && <div className="muted" style={{ textAlign: 'center', padding: 32, fontSize: 14 }}>Sin paquetes en esta categoría.</div>}
      </div>
    </div>
  );
}

Object.assign(window, { ClientPortal, EmptyState });
