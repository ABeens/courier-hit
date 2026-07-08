/* ============================================================
   HS GLOBAL — Admin portal: shell, overview, recepción, cola, costos
   ============================================================ */
function AdminPortal({ role, page, go, pkgs, actions, toast }) {
  const [detail, setDetail] = useState(null);
  // Al navegar con el menú, cerrar el detalle abierto: el panel de detalle
  // tiene prioridad sobre la página y, si no se limpia, tapa la sección nueva
  // y el menú parece no responder.
  useEffect(() => { setDetail(null); }, [page]);
  const sel = detail ? pkgs.find(p => p.id === detail) : null;
  const isAdmin = role === 'admin';

  const titleMap = {
    'admin-overview': 'Resumen operativo', recepcion: 'Recepción de paquetes', cola: 'Paquetes en bodega',
    costos: 'Flujo de costos', ruta: 'Ruta de entrega', entregados: 'Paquetes entregados',
    reportes: 'Reportes', facturacion: 'Facturación Hacienda', usuarios: 'Usuarios del sistema', 'estados-api': 'Módulo de estados',
  };

  let body;
  if (sel) {
    body = <AdminPkgDetail pkg={sel} role={role} actions={actions} toast={toast} onBack={() => setDetail(null)} />;
  } else {
    switch (page) {
      case 'admin-overview': body = <AdminOverview pkgs={pkgs} go={go} onSelect={setDetail} />; break;
      case 'recepcion': body = <Recepcion pkgs={pkgs} actions={actions} toast={toast} onSelect={setDetail} />; break;
      case 'cola': body = <Cola pkgs={pkgs} onSelect={setDetail} />; break;
      case 'costos': body = <Costos pkgs={pkgs} actions={actions} toast={toast} onSelect={setDetail} />; break;
      case 'ruta': body = <Ruta pkgs={pkgs} actions={actions} toast={toast} onSelect={setDetail} />; break;
      case 'entregados': body = <Entregados pkgs={pkgs} onSelect={setDetail} />; break;
      case 'reportes': body = <Reportes pkgs={pkgs} />; break;
      case 'facturacion': body = <Facturacion pkgs={pkgs} toast={toast} />; break;
      case 'usuarios': body = <Usuarios toast={toast} />; break;
      case 'estados-api': body = <EstadosAPI toast={toast} />; break;
      default: body = <AdminOverview pkgs={pkgs} go={go} onSelect={setDetail} />;
    }
  }

  const headAction = page === 'recepcion' ? null : (role === 'bodega' || isAdmin) && ['cola', 'admin-overview'].includes(page)
    ? <button className="btn btn-primary btn-sm" onClick={() => go('admin', 'recepcion')}><Icon name="barcode" size={15} />Registrar paquete</button> : null;

  return (
    <PortalShell role={role} page={page} go={go} onLogout={() => go('public', 'home')} title={sel ? 'Detalle del paquete' : titleMap[page] || 'Panel'} actions={headAction} notifCount={role === 'bodega' ? 3 : 1}>
      {body}
    </PortalShell>
  );
}

/* ---- Admin detail with status + cost controls ---- */
function AdminPkgDetail({ pkg, role, actions, toast, onBack }) {
  const canStatus = role === 'bodega' || role === 'entrega' || role === 'admin';
  const canCost = role === 'bodega' || role === 'admin';
  const idx = DATA.statusIndex(pkg.status);
  const next = DATA.STATUSES[idx + 1];

  const extra = (
    <>
      {canCost && !pkg.costs && <CostEditor pkg={pkg} actions={actions} toast={toast} />}
      {canStatus && (
        <Panel title="Actualizar estado" sub="El cambio se refleja al cliente al instante">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="between" style={{ fontSize: 13.5 }}><span className="muted">Estado actual</span><StatusPill statusKey={pkg.status} size="sm" /></div>
            {next && pkg.status !== 'pendiente_pago' ? (
              <button className="btn btn-primary" onClick={() => { actions.advance(pkg); toast(`Estado actualizado: ${next.label}`, 'ok'); onBack(); }}>
                <Icon name="arrowR" size={16} />Avanzar a “{next.label}”
              </button>
            ) : !next ? <div className="card" style={{ padding: '12px 14px', background: 'var(--ok-soft)', border: 'none', textAlign: 'center', color: 'oklch(0.40 0.12 160)', fontWeight: 600, fontSize: 13.5 }}>Flujo completado · Entregado</div> : null}
            {pkg.status === 'pendiente_pago' && <div className="card" style={{ padding: '10px 12px', background: 'var(--warn-soft)', border: 'none', fontSize: 12.5, color: 'oklch(0.45 0.13 60)', display: 'flex', gap: 8, alignItems: 'center' }}><Icon name="lock" size={14} />Retenido: requiere pago del cliente para salir a ruta.</div>}
          </div>
        </Panel>
      )}
    </>
  );
  return <PkgDetailPanel pkg={pkg} onBack={onBack} extra={extra} />;
}

function CostEditor({ pkg, actions, toast }) {
  const auto = DATA.makeCosts(pkg.weight, true);
  const [c, setC] = useState({ flete: auto.flete, manejo: auto.manejo, seguro: auto.seguro });
  const set = (k, v) => setC(s => ({ ...s, [k]: +v }));
  const imp = +((c.flete + c.manejo + c.seguro) * 0.07).toFixed(2);
  const total = +(c.flete + c.manejo + c.seguro + imp).toFixed(2);
  return (
    <Panel title="Ingresar costos" sub="Registra y aprueba para pasar a pendiente de pago">
      <div style={{ display: 'grid', gap: 12 }}>
        {[['flete', 'Flete internacional'], ['manejo', 'Manejo'], ['seguro', 'Seguro']].map(([k, l]) => (
          <div key={k} className="between"><label className="muted" style={{ fontSize: 13.5 }}>{l}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="faint mono" style={{ fontSize: 13 }}>$</span><input className="input mono" type="number" value={c[k]} onChange={e => set(k, e.target.value)} style={{ width: 110, height: 38, textAlign: 'right' }} /></div>
          </div>
        ))}
        <div className="between" style={{ fontSize: 13.5 }}><span className="muted">Impuestos (7%)</span><span className="mono">{DATA.money(imp)}</span></div>
        <div className="between" style={{ paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 16 }}><span style={{ fontWeight: 700 }}>Total</span><span className="mono" style={{ fontWeight: 700, color: 'var(--brand)' }}>{DATA.money(total)}</span></div>
        <button className="btn btn-primary" style={{ marginTop: 4 }} onClick={() => { actions.setCosts(pkg, { ...c, impuesto: imp, total, approved: true }); toast('Costos aprobados · paquete pendiente de pago', 'ok'); }}>
          <Icon name="check" size={16} />Aprobar costos
        </button>
      </div>
    </Panel>
  );
}

/* ---- Overview ---- */
function AdminOverview({ pkgs, go, onSelect }) {
  const inWh = pkgs.filter(p => ['recibido_miami', 'transito', 'aduana', 'bodega_local'].includes(p.status));
  const pendCost = pkgs.filter(p => p.status === 'bodega_local' && !p.costs);
  const pendPay = pkgs.filter(p => p.status === 'pendiente_pago');
  const route = pkgs.filter(p => p.status === 'en_ruta');
  const revenue = pkgs.filter(p => p.paid).reduce((s, p) => s + (p.costs?.total || 0), 0);
  return (
    <div className="fadeIn">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <Stat icon="box" label="En bodega / tránsito" value={inWh.length} tone="brand" delta="+3 hoy" />
        <Stat icon="dollar" label="Costos por aprobar" value={pendCost.length} tone="warn" sub="Acción de bodega" />
        <Stat icon="card" label="Pendientes de pago" value={pendPay.length} tone="purple" sub={DATA.money(pendPay.reduce((s, p) => s + (p.costs?.total || 0), 0))} />
        <Stat icon="trending" label="Ingresos cobrados" value={DATA.money(revenue)} tone="ok" delta="+12%" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18 }}>
        <Panel title="Necesita tu atención" sub="Paquetes que requieren una acción ahora" pad={0}>
          <Table head={['Paquete', { label: 'Cliente' }, 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Total', align: 'right' }, '']}>
            {[...pendCost, ...pendPay].slice(0, 6).map(p => <PkgRow key={p.id} pkg={p} showClient onClick={() => onSelect(p.id)} />)}
          </Table>
          {![...pendCost, ...pendPay].length && <div className="muted" style={{ padding: 24, textAlign: 'center' }}>Todo al día ✓</div>}
        </Panel>
        <Panel title="Flujo operativo">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[['barcode', 'Recepción', inWh.length, 'brand', 'recepcion'], ['dollar', 'Costos por aprobar', pendCost.length, 'warn', 'costos'], ['card', 'Esperando pago', pendPay.length, 'purple', 'cola'], ['truck', 'En ruta de entrega', route.length, 'info', 'ruta']].map(([ic, l, n, tone, pg]) => {
              const [fg, bg] = TONE[tone];
              return (
                <button key={l} onClick={() => go('admin', pg)} className="card" style={{ padding: '13px 15px', display: 'flex', alignItems: 'center', gap: 13, textAlign: 'left' }}>
                  <span style={{ width: 38, height: 38, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center' }}><Icon name={ic} size={18} color={fg} /></span>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{l}</span>
                  <span className="mono" style={{ fontWeight: 700, fontSize: 16 }}>{n}</span>
                  <Icon name="chevR" size={15} color="var(--faint)" />
                </button>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ---- Recepción (scan / manual intake) ---- */
function Recepcion({ pkgs, actions, toast, onSelect }) {
  const [tn, setTn] = useState('');
  const [matched, setMatched] = useState(null);
  const prealerted = pkgs.filter(p => p.status === 'prealertado');

  const scan = (val) => {
    const v = (val ?? tn).trim();
    if (!v) return;
    const found = pkgs.find(p => p.tracking.toLowerCase() === v.toLowerCase() || p.tracking.toLowerCase().includes(v.toLowerCase()));
    setMatched(found || { unknown: true, tracking: v });
  };
  const confirm = () => {
    if (matched.unknown) { toast('Paquete registrado manualmente (sin cliente vinculado)', 'warn'); }
    else { actions.receive(matched); toast(`Recibido y vinculado a ${matched.client}`, 'ok'); }
    setMatched(null); setTn('');
  };

  return (
    <div className="fadeIn">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <Panel title="Escanear o ingresar paquete" sub="Escanea el código de barras o digita el tracking">
          <div style={{ border: '2px dashed var(--brand-soft)', borderRadius: 'var(--r-md)', padding: '28px 20px', textAlign: 'center', background: 'var(--brand-softer)', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 3, marginBottom: 14, height: 44, alignItems: 'center' }}>
              {[3, 1, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 3, 1, 2, 1, 1, 3, 1].map((w, i) => <span key={i} style={{ width: w * 2, height: 44, background: i % 2 ? 'transparent' : 'var(--ink)' }} />)}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>Pistola de escaneo lista · o ingresa manualmente abajo</div>
          </div>
          <label className="field-label"># de tracking</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input mono" value={tn} onChange={e => setTn(e.target.value)} placeholder="Escanea o digita…" onKeyDown={e => e.key === 'Enter' && scan()} autoFocus />
            <button className="btn btn-primary" onClick={() => scan()}><Icon name="search" size={16} />Buscar</button>
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>Prealertados:</span>
            {prealerted.slice(0, 3).map(p => <button key={p.id} className="mono" onClick={() => { setTn(p.tracking); scan(p.tracking); }} style={{ fontSize: 11, color: 'var(--brand)', fontWeight: 600, background: 'var(--brand-soft)', padding: '3px 8px', borderRadius: 6 }}>{p.tracking.slice(0, 12)}…</button>)}
          </div>

          {matched && (
            <div className="card fadeUp" style={{ padding: 18, marginTop: 18, borderColor: matched.unknown ? 'oklch(0.85 0.07 75)' : 'var(--brand)' }}>
              {matched.unknown ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}><Icon name="alert" size={20} color="oklch(0.52 0.13 60)" /><span style={{ fontWeight: 700, fontSize: 15 }}>Tracking no prealertado</span></div>
                  <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>No hay prealerta para <span className="mono">{matched.tracking}</span>. Puedes registrarlo manualmente y vincularlo a un cliente luego.</p>
                </div>
              ) : (
                <div>
                  <div className="between" style={{ marginBottom: 10 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ok)', fontWeight: 700, fontSize: 13.5 }}><Icon name="checkCircle" size={17} />Coincide con prealerta</span>
                    <StatusPill statusKey={matched.status} size="sm" />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{matched.desc}</div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Cliente: <strong>{matched.client}</strong> ({matched.clientCode}) · {matched.weight} kg</div>
                </div>
              )}
              <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} onClick={confirm}><Icon name="check" size={16} />{matched.unknown ? 'Registrar manualmente' : 'Confirmar recepción'}</button>
            </div>
          )}
        </Panel>

        <Panel title="Prealertas esperando llegada" sub={`${prealerted.length} paquete(s) anunciados por clientes`} pad={prealerted.length ? 0 : 24}>
          {prealerted.length ? (
            <Table head={['Paquete', 'Cliente', 'Transportista', '']}>
              {prealerted.map(p => (
                <tr key={p.id} onClick={() => onSelect(p.id)} style={{ cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '13px 16px' }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.desc}</div><div className="mono muted" style={{ fontSize: 11.5 }}>{p.tracking}</div></td>
                  <td style={{ padding: '13px 16px', fontSize: 13 }}>{p.clientCode}</td>
                  <td style={{ padding: '13px 16px' }}><CarrierBadge carrier={p.carrier} /></td>
                  <td style={{ padding: '13px 8px 13px 0', textAlign: 'right' }}><Icon name="chevR" size={15} color="var(--faint)" /></td>
                </tr>
              ))}
            </Table>
          ) : <div className="muted" style={{ textAlign: 'center', fontSize: 14 }}>Sin prealertas pendientes.</div>}
        </Panel>
      </div>
    </div>
  );
}

/* ---- Cola (warehouse list) ---- */
function Cola({ pkgs, onSelect }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('todos');
  const tabs = [['todos', 'Todos'], ['transito', 'En tránsito'], ['bodega_local', 'En bodega'], ['pendiente_pago', 'Por pagar'], ['en_ruta', 'En ruta'], ['entregado', 'Entregados']];
  let rows = pkgs.filter(p => p.status !== 'prealertado');
  if (filter !== 'todos') rows = rows.filter(p => p.status === filter);
  if (q) rows = rows.filter(p => (p.tracking + p.desc + p.client).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fadeIn">
      <div className="between" style={{ marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <button key={k} onClick={() => setFilter(k)} style={{ padding: '7px 13px', borderRadius: 99, fontSize: 13, fontWeight: 600, background: filter === k ? 'var(--ink)' : 'var(--surface)', color: filter === k ? '#fff' : 'var(--ink-2)', border: '1px solid', borderColor: filter === k ? 'var(--ink)' : 'var(--line)' }}>{l}</button>)}
        </div>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 40, width: 280 }}>
          <Icon name="search" size={17} color="var(--faint)" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar paquete o cliente…" style={{ border: 'none', outline: 'none', background: 'none', flex: 1, fontSize: 13.5 }} />
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <Table head={['Paquete', 'Cliente', 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Total', align: 'right' }, '']}>
          {rows.map(p => <PkgRow key={p.id} pkg={p} showClient onClick={() => onSelect(p.id)} />)}
        </Table>
        {!rows.length && <div className="muted" style={{ textAlign: 'center', padding: 32, fontSize: 14 }}>Sin paquetes en esta vista.</div>}
      </div>
    </div>
  );
}

/* ---- Costos ---- */
function Costos({ pkgs, actions, toast, onSelect }) {
  const needCost = pkgs.filter(p => ['bodega_local', 'aduana'].includes(p.status) && !p.costs);
  const approved = pkgs.filter(p => p.costs && ['pendiente_pago', 'en_ruta', 'entregado'].includes(p.status));
  return (
    <div className="fadeIn">
      <Panel title="Costos por ingresar y aprobar" sub="Al aprobar, el paquete pasa a “pendiente de pago”" style={{ marginBottom: 18 }} pad={needCost.length ? 0 : 24}>
        {needCost.length ? (
          <Table head={['Paquete', 'Cliente', { label: 'Peso', align: 'right' }, { label: 'Costo estimado', align: 'right' }, '']}>
            {needCost.map(p => {
              const est = DATA.makeCosts(p.weight, true);
              return (
                <tr key={p.id} onClick={() => onSelect(p.id)} style={{ cursor: 'pointer' }} onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '13px 16px' }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.desc}</div><div className="mono muted" style={{ fontSize: 11.5 }}>{p.tracking}</div></td>
                  <td style={{ padding: '13px 16px', fontSize: 13 }}>{p.client}</td>
                  <td style={{ padding: '13px 16px', textAlign: 'right' }} className="mono muted">{p.weight} kg</td>
                  <td style={{ padding: '13px 16px', textAlign: 'right' }} className="mono">{DATA.money(est.total)}</td>
                  <td style={{ padding: '13px 16px', textAlign: 'right' }}><button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); actions.setCosts(p, { ...est }); toast(`Costos aprobados para ${p.desc}`, 'ok'); }}>Aprobar</button></td>
                </tr>
              );
            })}
          </Table>
        ) : <div style={{ textAlign: 'center', padding: 16 }}><Icon name="checkCircle" size={30} color="var(--ok)" /><div style={{ fontWeight: 600, marginTop: 8 }}>Sin costos pendientes</div></div>}
      </Panel>
      <Panel title="Costos aprobados" pad={0}>
        <Table head={['Paquete', 'Cliente', 'Estado', { label: 'Total', align: 'right' }, '']}>
          {approved.map(p => <PkgRow key={p.id} pkg={p} showClient onClick={() => onSelect(p.id)} />)}
        </Table>
      </Panel>
    </div>
  );
}

Object.assign(window, { AdminPortal, AdminPkgDetail, CostEditor, AdminOverview, Recepcion, Cola, Costos });
