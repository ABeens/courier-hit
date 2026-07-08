/* ============================================================
   HS GLOBAL — Public package tracking
   ============================================================ */
function findPkg(tn) {
  if (!tn) return null;
  const all = [...DATA.PACKAGES, ...DATA.WAREHOUSE];
  const q = tn.trim().toLowerCase();
  return all.find(p => p.tracking.toLowerCase() === q) || all.find(p => p.tracking.toLowerCase().includes(q));
}

function PubTrack({ go, params }) {
  const [tn, setTn] = useState(params.tn || '');
  const [query, setQuery] = useState(params.tn || '');
  const [loading, setLoading] = useState(false);
  const pkg = useMemo(() => query ? findPkg(query) : null, [query]);

  const run = (val) => {
    const v = val ?? tn;
    if (!v.trim()) return;
    setLoading(true);
    setQuery('');
    setTimeout(() => { setQuery(v); setLoading(false); }, 700);
  };
  useEffect(() => { if (params.tn) run(params.tn); /* eslint-disable-next-line */ }, []);

  return (
    <div className="fadeIn">
      <PubPageHead eyebrow="Rastreo en tiempo real" title="¿Dónde está mi paquete?" sub="Ingresa tu número de tracking. Combinamos la información del transportista con la de nuestra bodega para mostrarte el estado real." />
      <section style={{ ...PUB_WRAP, padding: '40px 28px 80px', maxWidth: 880 }}>
        {/* search */}
        <div className="card" style={{ padding: 10, display: 'flex', gap: 8, alignItems: 'center', boxShadow: 'var(--sh-2)' }}>
          <div style={{ paddingLeft: 12, color: 'var(--faint)' }}><Icon name="search" size={20} /></div>
          <input className="input mono" value={tn} onChange={e => setTn(e.target.value)} placeholder="Ej. 1Z999AA10123456784" style={{ border: 'none', boxShadow: 'none', flex: 1, fontSize: 15 }} onKeyDown={e => e.key === 'Enter' && run()} />
          <button className="btn btn-primary" onClick={() => run()}>{loading ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 15, height: 15, border: '2px solid #fff5', borderTopColor: '#fff', borderRadius: 99, animation: 'spin .7s linear infinite' }} />Buscando</span> : <>Rastrear<Icon name="arrowR" size={16} /></>}</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Ejemplos:</span>
          {['1Z999AA10123456784', 'TBA305812994771', '7749112038'].map(ex => (
            <button key={ex} className="mono" onClick={() => { setTn(ex); run(ex); }} style={{ fontSize: 12, color: 'var(--brand)', fontWeight: 600, background: 'var(--brand-soft)', padding: '4px 9px', borderRadius: 6 }}>{ex}</button>
          ))}
        </div>

        {loading && (
          <div className="card" style={{ padding: 28, marginTop: 24 }}>
            <div className="skeleton" style={{ height: 22, width: '40%', marginBottom: 16 }} />
            <div className="skeleton" style={{ height: 54, width: '100%', marginBottom: 20 }} />
            <div className="skeleton" style={{ height: 120, width: '100%' }} />
          </div>
        )}

        {!loading && query && !pkg && (
          <div className="card fadeUp" style={{ padding: 48, marginTop: 24, textAlign: 'center' }}>
            <span style={{ width: 64, height: 64, borderRadius: 18, background: 'var(--paper-2)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}><Icon name="search" size={28} color="var(--faint)" /></span>
            <h3 style={{ fontSize: 21 }}>No encontramos ese tracking</h3>
            <p className="muted" style={{ fontSize: 15, marginTop: 8, maxWidth: 420, margin: '8px auto 0', lineHeight: 1.6 }}>Verifica el número o, si aún no lo registras, créalo como prealerta desde tu portal para que aparezca aquí.</p>
            <button className="btn btn-primary" style={{ marginTop: 22 }} onClick={() => go('auth', 'register')}>Crear cuenta y prealertar</button>
          </div>
        )}

        {!loading && pkg && (
          <div className="fadeUp" style={{ marginTop: 24 }}>
            <div className="card" style={{ padding: 28, boxShadow: 'var(--sh-2)' }}>
              <div className="between" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 22 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}><CarrierBadge carrier={pkg.carrier} /><span className="mono" style={{ fontSize: 13, color: 'var(--muted)' }}>{pkg.tracking}</span></div>
                  <h3 style={{ fontSize: 22 }}>{pkg.desc}</h3>
                  <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>{pkg.weight} kg · {pkg.pieces} pieza(s) · Cliente {pkg.clientCode}</div>
                </div>
                <StatusPill statusKey={pkg.status} />
              </div>
              <div style={{ background: 'var(--paper-2)', borderRadius: 'var(--r-md)', padding: '22px 20px 16px' }}>
                <StepStrip statusKey={pkg.status} />
              </div>
              {/* data source note */}
              <div style={{ display: 'flex', gap: 16, marginTop: 18, flexWrap: 'wrap' }}>
                <span className="chip" style={{ background: 'var(--info-soft)', color: 'var(--info)', borderColor: 'transparent' }}><Icon name="globe" size={13} />Datos de {pkg.carrier}</span>
                <span className="chip" style={{ background: 'var(--brand-soft)', color: 'var(--brand-600)', borderColor: 'transparent' }}><Icon name="box" size={13} />Datos de HS Global</span>
                <span className="chip"><Icon name="refresh" size={13} />Actualizado hace 8 min</span>
              </div>
            </div>

            {pkg.status === 'pendiente_pago' && (
              <div className="card" style={{ padding: '20px 24px', marginTop: 16, background: 'var(--warn-soft)', border: '1px solid oklch(0.85 0.08 75)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--surface)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={22} color="oklch(0.52 0.13 60)" /></span>
                  <div><div style={{ fontWeight: 700, fontSize: 15.5 }}>Este paquete tiene un pago pendiente</div><div className="muted" style={{ fontSize: 13.5 }}>No saldrá a ruta de entrega hasta completar el pago.</div></div>
                </div>
                <button className="btn btn-primary" onClick={() => go('auth', 'login')}>Iniciar sesión para pagar</button>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginTop: 16 }}>
              <div className="card" style={{ padding: 28 }}>
                <h4 style={{ fontSize: 17, marginBottom: 20 }}>Historial de movimientos</h4>
                <TrackingTimeline pkg={pkg} />
              </div>
            </div>

            <div className="card" style={{ padding: '20px 24px', marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', background: 'var(--paper-2)' }}>
              <span className="muted" style={{ fontSize: 14.5 }}>Inicia sesión para ver costos, pagar y gestionar tus prealertas.</span>
              <button className="btn btn-ghost" onClick={() => go('auth', 'login')}>Ir a mi portal<Icon name="arrowR" size={15} /></button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

Object.assign(window, { PubTrack, findPkg });
