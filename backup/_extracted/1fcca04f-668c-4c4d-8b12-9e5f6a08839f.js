/* ============================================================
   HS GLOBAL — Shared package components
   ============================================================ */

function CostBreakdown({ costs, compact }) {
  if (!costs) return <div className="muted" style={{ fontSize: 13.5, fontStyle: 'italic' }}>Costos aún no calculados. Se definen al recibir el paquete en bodega.</div>;
  const rows = [['Flete internacional', costs.flete], ['Manejo', costs.manejo], ['Seguro', costs.seguro], ['Impuestos (7%)', costs.impuesto]];
  return (
    <div>
      {rows.map(([l, v]) => (
        <div key={l} className="between" style={{ padding: compact ? '5px 0' : '8px 0', fontSize: 14 }}>
          <span className="muted">{l}</span><span className="mono" style={{ fontWeight: 600 }}>{DATA.money(v)}</span>
        </div>
      ))}
      <div className="between" style={{ padding: '12px 0 2px', marginTop: 6, borderTop: '1px solid var(--line)', fontSize: 16 }}>
        <span style={{ fontWeight: 700 }}>Total a pagar</span><span className="mono" style={{ fontWeight: 700, color: 'var(--brand)' }}>{DATA.money(costs.total)}</span>
      </div>
    </div>
  );
}

/* Compact package card (dashboard / grids) */
function PkgCard({ pkg, onClick, accent }) {
  return (
    <button onClick={onClick} className="card" style={{ padding: 18, textAlign: 'left', width: '100%', transition: 'all .16s', cursor: 'pointer', display: 'block' }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--sh-2)'; e.currentTarget.style.borderColor = 'oklch(0.85 0.01 263)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--sh-1)'; e.currentTarget.style.borderColor = 'var(--line)'; }}>
      <div className="between" style={{ marginBottom: 12 }}>
        <CarrierBadge carrier={pkg.carrier} />
        <StatusPill statusKey={pkg.status} size="sm" />
      </div>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{pkg.desc}</div>
      <div className="mono muted" style={{ fontSize: 12, marginBottom: 14 }}>{pkg.tracking}</div>
      <MiniProgress statusKey={pkg.status} />
      <div className="between" style={{ marginTop: 13, fontSize: 12.5 }}>
        <span className="muted">{pkg.weight} kg · {pkg.pieces} pza</span>
        {pkg.status === 'pendiente_pago' && pkg.costs
          ? <span className="mono" style={{ fontWeight: 700, color: 'oklch(0.52 0.13 60)' }}>{DATA.money(pkg.costs.total)} por pagar</span>
          : <span style={{ color: 'var(--brand)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>Ver detalle<Icon name="chevR" size={13} /></span>}
      </div>
    </button>
  );
}

/* Table row */
function PkgRow({ pkg, onClick, showClient, right }) {
  return (
    <tr onClick={onClick} style={{ cursor: 'pointer', transition: 'background .12s' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <td style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="box" size={18} color="var(--brand)" /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 230 }}>{pkg.desc}</div>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{pkg.tracking}</div>
          </div>
        </div>
      </td>
      {showClient && <td style={{ padding: '14px 16px' }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>{pkg.client}</div><div className="mono muted" style={{ fontSize: 11.5 }}>{pkg.clientCode}</div></td>}
      <td style={{ padding: '14px 16px' }}><CarrierBadge carrier={pkg.carrier} /></td>
      <td style={{ padding: '14px 16px' }}><StatusPill statusKey={pkg.status} size="sm" /></td>
      <td style={{ padding: '14px 16px', textAlign: 'right' }} className="mono muted">{pkg.weight} kg</td>
      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
        {right || (pkg.costs ? <span className="mono" style={{ fontWeight: 700, fontSize: 13.5, color: pkg.paid ? 'var(--ok)' : pkg.status === 'pendiente_pago' ? 'oklch(0.52 0.13 60)' : 'var(--ink)' }}>{DATA.money(pkg.costs.total)}</span> : <span className="faint" style={{ fontSize: 13 }}>—</span>)}
      </td>
      <td style={{ padding: '14px 8px 14px 0', textAlign: 'right' }}><Icon name="chevR" size={16} color="var(--faint)" /></td>
    </tr>
  );
}

function Table({ head, children }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--line)' }}>
            {head.map((h, i) => { const obj = h && typeof h === 'object'; return <th key={i} style={{ padding: '11px 16px', textAlign: (obj && h.align) || 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)' }}>{obj ? h.label : h}</th>; })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* Full detail panel (drill-in). footer = action buttons */
function PkgDetailPanel({ pkg, onBack, footer, extra }) {
  return (
    <div className="fadeIn">
      <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontWeight: 600, marginBottom: 16 }}><Icon name="chevR" size={15} style={{ transform: 'rotate(180deg)' }} />Volver</button>
      <div className="card" style={{ padding: 26, marginBottom: 18 }}>
        <div className="between" style={{ flexWrap: 'wrap', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name="box" size={26} color="var(--brand)" /></span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}><CarrierBadge carrier={pkg.carrier} /><span className="mono" style={{ fontSize: 12.5, color: 'var(--muted)' }}>{pkg.tracking}</span></div>
              <h2 style={{ fontSize: 22, letterSpacing: '-.02em' }}>{pkg.desc}</h2>
            </div>
          </div>
          <StatusPill statusKey={pkg.status} />
        </div>
        <div style={{ background: 'var(--paper-2)', borderRadius: 'var(--r-md)', padding: '22px 20px 16px', marginTop: 22 }}><StepStrip statusKey={pkg.status} /></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: 18 }}>
        <Panel title="Historial de movimientos" sub="Datos del transportista + bodega HS Global">
          <TrackingTimeline pkg={pkg} />
        </Panel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Detalles del paquete" pad={0}>
            <div style={{ padding: '4px 22px 14px' }}>
              {[['Código de paquete', pkg.id], ['Cliente', `${pkg.client} (${pkg.clientCode})`], ['Peso', `${pkg.weight} kg`], ['Piezas', pkg.pieces], ['Valor declarado', DATA.money(pkg.declared)], ['Registrado', DATA.fmtDate(pkg.createdAt)]].map(([l, v]) => (
                <div key={l} className="between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line-2)', fontSize: 13.5 }}><span className="muted">{l}</span><span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span></div>
              ))}
              <div className="between" style={{ padding: '12px 0 2px', fontSize: 13.5 }}>
                <span className="muted">Factura</span>
                {pkg.invoice ? <button style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--brand)', fontWeight: 600, fontSize: 13 }}><Icon name="file" size={15} />{pkg.invoice}<Icon name="download" size={14} /></button> : <span className="faint">No adjunta</span>}
              </div>
              {pkg.observations && <div style={{ marginTop: 12, padding: '12px 14px', background: 'var(--paper-2)', borderRadius: 10, fontSize: 13, color: 'var(--ink-2)' }}><span style={{ fontWeight: 700 }}>Observaciones: </span>{pkg.observations}</div>}
            </div>
          </Panel>
          <Panel title="Costos del envío"><CostBreakdown costs={pkg.costs} /></Panel>
          {extra}
          {footer && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{footer}</div>}
        </div>
      </div>
    </div>
  );
}

/* Payment flow modal */
function PayModal({ pkg, open, onClose, onPaid }) {
  const [stage, setStage] = useState(0); // 0 review, 1 method, 2 processing, 3 done
  const [method, setMethod] = useState('card');
  useEffect(() => { if (open) setStage(0); }, [open]);
  if (!pkg) return null;
  const total = pkg.costs ? pkg.costs.total : 0;
  return (
    <Modal open={open} onClose={stage === 2 ? () => {} : onClose} width={480} label="Pagar paquete">
      {stage < 2 && (
        <div className="between" style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ fontSize: 18 }}>{stage === 0 ? 'Confirmar pago' : 'Método de pago'}</h3>
          <button onClick={onClose} style={{ color: 'var(--faint)', padding: 4 }}><Icon name="x" size={20} /></button>
        </div>
      )}
      <div style={{ padding: 24 }}>
        {stage === 0 && (
          <div className="fadeIn">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name="box" size={21} color="var(--brand)" /></span>
              <div><div style={{ fontWeight: 700, fontSize: 15 }}>{pkg.desc}</div><div className="mono muted" style={{ fontSize: 12 }}>{pkg.tracking}</div></div>
            </div>
            <div className="card" style={{ padding: 18, background: 'var(--paper-2)', marginBottom: 18 }}><CostBreakdown costs={pkg.costs} /></div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}><Icon name="alert" size={15} color="oklch(0.52 0.13 60)" />Tu paquete saldrá a ruta una vez confirmado el pago.</div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 16, height: 48 }} onClick={() => setStage(1)}>Continuar al pago · {DATA.money(total)}</button>
          </div>
        )}
        {stage === 1 && (
          <div className="fadeIn">
            <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
              {[['card', 'card', 'Tarjeta de crédito/débito', '•••• 4242'], ['pse', 'building', 'PSE — débito bancario', 'Bancolombia']].map(([k, ic, t, s]) => (
                <button key={k} onClick={() => setMethod(k)} className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', borderColor: method === k ? 'var(--brand)' : 'var(--line)', background: method === k ? 'var(--brand-softer)' : 'var(--surface)' }}>
                  <span style={{ width: 36, height: 36, borderRadius: 9, background: 'var(--paper-2)', display: 'grid', placeItems: 'center' }}><Icon name={ic} size={18} color="var(--ink-2)" /></span>
                  <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{t}</div><div className="muted" style={{ fontSize: 12.5 }}>{s}</div></div>
                  <span style={{ width: 20, height: 20, borderRadius: 99, border: `2px solid ${method === k ? 'var(--brand)' : 'var(--line)'}`, display: 'grid', placeItems: 'center' }}>{method === k && <span style={{ width: 10, height: 10, borderRadius: 99, background: 'var(--brand)' }} />}</span>
                </button>
              ))}
            </div>
            {method === 'card' && (
              <div style={{ display: 'grid', gap: 12, marginBottom: 8 }}>
                <div><label className="field-label">Número de tarjeta</label><input className="input mono" defaultValue="4242 4242 4242 4242" /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div><label className="field-label">Vencimiento</label><input className="input mono" defaultValue="08 / 28" /></div>
                  <div><label className="field-label">CVV</label><input className="input mono" defaultValue="123" /></div>
                </div>
              </div>
            )}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 14, height: 48 }} onClick={() => { setStage(2); setTimeout(() => setStage(3), 1900); }}>Pagar {DATA.money(total)}<Icon name="lock" size={15} /></button>
          </div>
        )}
        {stage === 2 && (
          <div style={{ textAlign: 'center', padding: '36px 0' }}>
            <span style={{ width: 56, height: 56, border: '4px solid var(--brand-soft)', borderTopColor: 'var(--brand)', borderRadius: 99, display: 'inline-block', animation: 'spin .8s linear infinite' }} />
            <div style={{ fontWeight: 700, fontSize: 17, marginTop: 22 }}>Procesando pago…</div>
            <div className="muted" style={{ fontSize: 14, marginTop: 6 }}>No cierres esta ventana</div>
          </div>
        )}
        {stage === 3 && (
          <div className="fadeIn" style={{ textAlign: 'center', padding: '20px 0 8px' }}>
            <span style={{ width: 76, height: 76, borderRadius: 22, background: 'var(--ok-soft)', display: 'grid', placeItems: 'center', margin: '0 auto 20px' }}><Icon name="checkCircle" size={40} color="oklch(0.45 0.12 160)" /></span>
            <h3 style={{ fontSize: 22 }}>¡Pago confirmado!</h3>
            <p className="muted" style={{ fontSize: 14.5, marginTop: 8, lineHeight: 1.55 }}>Pagaste <strong className="mono">{DATA.money(total)}</strong>. Tu paquete entrará en ruta de entrega.</p>
            <div className="card" style={{ padding: '12px 16px', background: 'var(--paper-2)', marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="muted" style={{ fontSize: 13 }}>Comprobante</span><span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>HS-PAY-{pkg.id.slice(-4)}-2026</span>
            </div>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 18, height: 46 }} onClick={() => { onPaid(pkg); onClose(); }}>Listo<Icon name="check" size={16} /></button>
          </div>
        )}
      </div>
    </Modal>
  );
}

Object.assign(window, { CostBreakdown, PkgCard, PkgRow, Table, PkgDetailPanel, PayModal });
