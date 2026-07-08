/* ============================================================
   HS GLOBAL — Admin portal: ruta, entregas, reportes, facturación, usuarios, API
   ============================================================ */

/* ---- Ruta de entrega ---- */
function Ruta({ pkgs, actions, toast, onSelect }) {
  const route = pkgs.filter(p => p.status === 'en_ruta');
  return (
    <div className="fadeIn">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
        <Stat icon="truck" label="Paradas de hoy" value={route.length} tone="brand" sub="Bogotá · zona norte" />
        <Stat icon="checkCircle" label="Entregados hoy" value={pkgs.filter(p => p.status === 'entregado').length} tone="ok" />
        <Stat icon="scale" label="Peso total en ruta" value={route.reduce((s, p) => s + p.weight, 0).toFixed(1) + ' kg'} tone="info" />
      </div>
      <Panel title="Mi ruta de hoy" sub="Confirma cada entrega al completarla" pad={route.length ? 16 : 24}>
        {route.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {route.map((p, i) => (
              <div key={p.id} className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="mono" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'grid', placeItems: 'center', fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onSelect(p.id)}>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>{p.desc}</div>
                  <div className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}><Icon name="pin" size={13} />{p.client} · Calle 127 #15-{20 + i}, {DATA.CLIENTS.find(c => c.code === p.clientCode)?.city || 'Bogotá'}</div>
                </div>
                <div style={{ textAlign: 'right' }}><div className="mono" style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--ok)' }}>Pagado</div><div className="faint" style={{ fontSize: 12 }}>{p.weight} kg</div></div>
                <button className="btn btn-primary btn-sm" onClick={() => { actions.deliver(p); toast(`Entrega confirmada: ${p.desc}`, 'ok'); }}><Icon name="check" size={15} />Entregar</button>
              </div>
            ))}
          </div>
        ) : <div style={{ textAlign: 'center', padding: 16 }}><Icon name="checkCircle" size={32} color="var(--ok)" /><div style={{ fontWeight: 600, marginTop: 8 }}>¡Ruta completada!</div><div className="muted" style={{ fontSize: 13.5 }}>No quedan entregas pendientes.</div></div>}
      </Panel>
    </div>
  );
}

function Entregados({ pkgs, onSelect }) {
  const done = pkgs.filter(p => p.status === 'entregado');
  return (
    <div className="fadeIn">
      <div className="card" style={{ padding: 0 }}>
        <Table head={['Paquete', 'Cliente', 'Transportista', 'Estado', { label: 'Peso', align: 'right' }, { label: 'Total', align: 'right' }, '']}>
          {done.map(p => <PkgRow key={p.id} pkg={p} showClient onClick={() => onSelect(p.id)} />)}
        </Table>
        {!done.length && <div className="muted" style={{ textAlign: 'center', padding: 32 }}>Aún no hay entregas registradas.</div>}
      </div>
    </div>
  );
}

/* ---- Reportes (finanzas) ---- */
function Reportes({ pkgs }) {
  const paid = pkgs.filter(p => p.paid);
  const rev = paid.reduce((s, p) => s + p.costs.total, 0);
  const tax = paid.reduce((s, p) => s + p.costs.impuesto, 0);
  const flete = paid.reduce((s, p) => s + p.costs.flete, 0);
  return (
    <div className="fadeIn">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginBottom: 20 }}>
        <Stat icon="trending" label="Ingresos del mes" value={DATA.money(rev)} tone="ok" delta="+12%" />
        <Stat icon="dollar" label="Flete cobrado" value={DATA.money(flete)} tone="brand" />
        <Stat icon="receipt" label="Impuestos recaudados" value={DATA.money(tax)} tone="warn" />
        <Stat icon="box" label="Transacciones" value={paid.length} tone="info" sub="Pagos completados" />
      </div>
      <Panel title="Transacciones cobradas" sub="Junio 2026" action={<button className="btn btn-ghost btn-sm"><Icon name="download" size={15} />Exportar CSV</button>} pad={0}>
        <Table head={['Comprobante', 'Cliente', 'Paquete', { label: 'Flete', align: 'right' }, { label: 'Impuesto', align: 'right' }, { label: 'Total', align: 'right' }]}>
          {paid.map(p => (
            <tr key={p.id} style={{ borderBottom: '1px solid var(--line-2)' }}>
              <td className="mono" style={{ padding: '13px 16px', fontSize: 12.5 }}>HS-PAY-{p.id.slice(-4)}</td>
              <td style={{ padding: '13px 16px', fontSize: 13.5 }}>{p.client}</td>
              <td style={{ padding: '13px 16px', fontSize: 13 }} className="muted">{p.desc}</td>
              <td style={{ padding: '13px 16px', textAlign: 'right' }} className="mono">{DATA.money(p.costs.flete)}</td>
              <td style={{ padding: '13px 16px', textAlign: 'right' }} className="mono">{DATA.money(p.costs.impuesto)}</td>
              <td className="mono" style={{ padding: '13px 16px', textAlign: 'right', fontWeight: 700 }}>{DATA.money(p.costs.total)}</td>
            </tr>
          ))}
        </Table>
      </Panel>
    </div>
  );
}

/* ---- Facturación Hacienda ---- */
function Facturacion({ pkgs, toast }) {
  const [period, setPeriod] = useState('2026-06');
  const [generated, setGenerated] = useState(false);
  const paid = pkgs.filter(p => p.paid);
  const base = paid.reduce((s, p) => s + (p.costs.total - p.costs.impuesto), 0);
  const iva = paid.reduce((s, p) => s + p.costs.impuesto, 0);
  const total = base + iva;
  return (
    <div className="fadeIn">
      <Panel title="Generar reporte para Hacienda" sub="Base para levantar la facturación tributaria del periodo" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div><label className="field-label">Periodo</label>
            <select className="input" value={period} onChange={e => { setPeriod(e.target.value); setGenerated(false); }} style={{ width: 180 }}>
              <option value="2026-06">Junio 2026</option><option value="2026-05">Mayo 2026</option><option value="2026-04">Abril 2026</option>
            </select>
          </div>
          <div><label className="field-label">Tipo de documento</label>
            <select className="input" style={{ width: 200 }}><option>Resumen de IVA</option><option>Detalle de transacciones</option></select>
          </div>
          <button className="btn btn-primary" onClick={() => { setGenerated(true); toast('Reporte generado', 'ok'); }} style={{ height: 46 }}><Icon name="receipt" size={16} />Generar reporte</button>
        </div>
      </Panel>

      {generated && (
        <div className="fadeUp">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 18 }}>
            <Stat icon="dollar" label="Base imponible" value={DATA.money(base)} tone="brand" />
            <Stat icon="receipt" label="IVA / Impuestos (7%)" value={DATA.money(iva)} tone="warn" />
            <Stat icon="trending" label="Total facturado" value={DATA.money(total)} tone="ok" />
          </div>
          <Panel title={`Reporte tributario · ${period === '2026-06' ? 'Junio' : period === '2026-05' ? 'Mayo' : 'Abril'} 2026`}
            action={<div style={{ display: 'flex', gap: 8 }}><button className="btn btn-ghost btn-sm"><Icon name="download" size={15} />Excel</button><button className="btn btn-dark btn-sm"><Icon name="file" size={15} />PDF Hacienda</button></div>} pad={0}>
            <Table head={['Doc.', 'Cliente', 'Fecha', { label: 'Base', align: 'right' }, { label: 'IVA', align: 'right' }, { label: 'Total', align: 'right' }]}>
              {paid.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--line-2)' }}>
                  <td className="mono" style={{ padding: '12px 16px', fontSize: 12 }}>FE-{p.id.slice(-4)}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13.5 }}>{p.client}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13 }} className="muted">{DATA.fmtDate(p.createdAt)}</td>
                  <td className="mono" style={{ padding: '12px 16px', textAlign: 'right' }}>{DATA.money(p.costs.total - p.costs.impuesto)}</td>
                  <td className="mono" style={{ padding: '12px 16px', textAlign: 'right' }}>{DATA.money(p.costs.impuesto)}</td>
                  <td className="mono" style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 700 }}>{DATA.money(p.costs.total)}</td>
                </tr>
              ))}
              <tr style={{ background: 'var(--paper-2)' }}>
                <td colSpan={3} style={{ padding: '13px 16px', fontWeight: 700 }}>Totales del periodo</td>
                <td className="mono" style={{ padding: '13px 16px', textAlign: 'right', fontWeight: 700 }}>{DATA.money(base)}</td>
                <td className="mono" style={{ padding: '13px 16px', textAlign: 'right', fontWeight: 700 }}>{DATA.money(iva)}</td>
                <td className="mono" style={{ padding: '13px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>{DATA.money(total)}</td>
              </tr>
            </Table>
          </Panel>
        </div>
      )}
    </div>
  );
}

/* ---- Usuarios (admin) ---- */
function Usuarios({ toast }) {
  const [users, setUsers] = useState(DATA.SYS_USERS);
  const [adding, setAdding] = useState(false);
  const [nu, setNu] = useState({ name: '', email: '', role: 'Bodega' });
  const roleTone = { Administrador: 'purple', Bodega: 'brand', Entrega: 'info', Finanzas: 'warn' };
  const add = () => {
    if (!nu.name.trim() || !/\S+@\S+/.test(nu.email)) return;
    setUsers(u => [{ ...nu, status: 'activo', last: 'Nunca', avatar: nu.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() }, ...u]);
    setAdding(false); setNu({ name: '', email: '', role: 'Bodega' }); toast('Usuario creado', 'ok');
  };
  const toggle = (i) => setUsers(u => u.map((x, j) => j === i ? { ...x, status: x.status === 'activo' ? 'inactivo' : 'activo' } : x));
  const remove = (i) => { setUsers(u => u.filter((_, j) => j !== i)); toast('Usuario removido', 'warn'); };
  return (
    <div className="fadeIn">
      <div className="between" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ fontSize: 14 }}>{users.length} usuarios · {users.filter(u => u.status === 'activo').length} activos</p>
        <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Agregar usuario</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <Table head={['Usuario', 'Rol', 'Estado', 'Último acceso', { label: '', align: 'right' }]}>
          {users.map((u, i) => {
            const [fg, bg] = TONE[roleTone[u.role] || 'brand'];
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--line-2)' }}>
                <td style={{ padding: '13px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Avatar name={u.name} size={36} />
                    <div><div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div><div className="muted mono" style={{ fontSize: 12 }}>{u.email}</div></div>
                  </div>
                </td>
                <td style={{ padding: '13px 16px' }}><span style={{ fontSize: 12, fontWeight: 700, color: fg, background: bg, padding: '4px 10px', borderRadius: 99 }}>{u.role}</span></td>
                <td style={{ padding: '13px 16px' }}>
                  <button onClick={() => toggle(i)} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: u.status === 'activo' ? 'var(--ok)' : 'var(--faint)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: u.status === 'activo' ? 'var(--ok)' : 'var(--faint)' }} />{u.status === 'activo' ? 'Activo' : 'Inactivo'}
                  </button>
                </td>
                <td style={{ padding: '13px 16px', fontSize: 13 }} className="muted">{u.last}</td>
                <td style={{ padding: '13px 16px', textAlign: 'right' }}>
                  <button onClick={() => remove(i)} style={{ color: 'var(--faint)', padding: 7, borderRadius: 8 }} title="Remover"
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'var(--danger-soft)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--faint)'; e.currentTarget.style.background = 'transparent'; }}><Icon name="trash" size={16} /></button>
                </td>
              </tr>
            );
          })}
        </Table>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} width={440} label="Agregar usuario">
        <div className="between" style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ fontSize: 18 }}>Nuevo usuario del sistema</h3>
          <button onClick={() => setAdding(false)} style={{ color: 'var(--faint)' }}><Icon name="x" size={20} /></button>
        </div>
        <div style={{ padding: 24, display: 'grid', gap: 14 }}>
          <div><label className="field-label">Nombre completo</label><input className="input" value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} placeholder="Ej. María Gómez" /></div>
          <div><label className="field-label">Correo</label><input className="input" value={nu.email} onChange={e => setNu({ ...nu, email: e.target.value })} placeholder="usuario@hsglobal.ltd" /></div>
          <div><label className="field-label">Rol</label><select className="input" value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>{['Administrador', 'Bodega', 'Entrega', 'Finanzas'].map(r => <option key={r}>{r}</option>)}</select></div>
          <button className="btn btn-primary" style={{ marginTop: 6, height: 46 }} onClick={add}><Icon name="check" size={16} />Crear usuario</button>
        </div>
      </Modal>
    </div>
  );
}

/* ---- Módulo de estados (API terceros) ---- */
function EstadosAPI({ toast }) {
  const [conns, setConns] = useState({ UPS: true, FedEx: true, USPS: true, DHL: false, Amazon: true });
  const log = [
    ['UPS', '1Z999AA10123456784', 'En tránsito → En aduana', 'Hace 8 min'],
    ['Amazon', 'TBA305812994771', 'Recibido en Miami → En tránsito', 'Hace 22 min'],
    ['USPS', '9400111899223344551', 'Sincronizado', 'Hace 1 h'],
    ['FedEx', '8801442290117', 'En bodega → En ruta', 'Hace 2 h'],
  ];
  return (
    <div className="fadeIn">
      <div className="card" style={{ padding: '16px 20px', marginBottom: 18, display: 'flex', gap: 12, alignItems: 'center', background: 'var(--info-soft)', border: 'none' }}>
        <Icon name="globe" size={20} color="var(--info)" />
        <div style={{ fontSize: 13.5, color: 'var(--info)' }}>Conecta las APIs de los transportistas para que los estados se actualicen <strong>automáticamente</strong>. HS Global complementa con su propia información de bodega.</div>
        <span className="chip" style={{ marginLeft: 'auto', background: 'var(--surface)', color: 'var(--muted)', borderColor: 'var(--line)' }}>Por definir</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <Panel title="Transportistas conectados" sub="Activa la sincronización automática por carrier">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(conns).map(([k, on]) => (
              <div key={k} className="card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <CarrierBadge carrier={k} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>API {k}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>{on ? 'api.' + k.toLowerCase() + '.com/track · v2' : 'No configurada'}</div>
                </div>
                {on && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: 'var(--ok)' }}><span style={{ width: 7, height: 7, borderRadius: 99, background: 'var(--ok)', animation: 'pulseDot 1.5s infinite' }} />En línea</span>}
                <button onClick={() => { setConns(c => ({ ...c, [k]: !c[k] })); toast(`${k} ${on ? 'desconectado' : 'conectado'}`, on ? 'warn' : 'ok'); }}
                  style={{ width: 42, height: 24, borderRadius: 99, background: on ? 'var(--brand)' : 'var(--line)', position: 'relative', transition: 'all .2s', flexShrink: 0 }}>
                  <span style={{ position: 'absolute', top: 3, left: on ? 21 : 3, width: 18, height: 18, borderRadius: 99, background: '#fff', transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' }} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Configuración" pad={20}>
            <div style={{ display: 'grid', gap: 12 }}>
              <div><label className="field-label">Webhook de actualizaciones</label><input className="input mono" defaultValue="https://api.hsglobal.ltd/hooks/tracking" style={{ fontSize: 12.5 }} /></div>
              <div className="between"><span style={{ fontSize: 13.5, fontWeight: 600 }}>Frecuencia de sincronización</span><select className="input" style={{ width: 130, height: 38 }}><option>Cada 15 min</option><option>Cada hora</option><option>Tiempo real</option></select></div>
              <button className="btn btn-ghost btn-sm" onClick={() => toast('Sincronización manual ejecutada', 'ok')}><Icon name="refresh" size={15} />Sincronizar ahora</button>
            </div>
          </Panel>
          <Panel title="Registro de sincronización" pad={0}>
            <div style={{ maxHeight: 230, overflowY: 'auto' }}>
              {log.map(([carrier, tn, change, when], i) => (
                <div key={i} style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <CarrierBadge carrier={carrier} />
                  <div style={{ flex: 1, minWidth: 0 }}><div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{tn}</div><div style={{ fontSize: 12.5, fontWeight: 500 }}>{change}</div></div>
                  <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{when}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Ruta, Entregados, Reportes, Facturacion, Usuarios, EstadosAPI });
