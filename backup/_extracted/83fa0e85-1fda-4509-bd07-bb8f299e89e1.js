/* ============================================================
   HS GLOBAL — App router & state
   ============================================================ */
function withEvent(pkg, statusKey, note) {
  const meta = DATA.statusMeta(statusKey);
  const ev = { status: statusKey, label: meta.label, loc: meta.loc, at: new Date().toISOString(), note: note || null };
  return { ...pkg, status: statusKey, events: [ev, ...pkg.events] };
}

function PublicSite({ page, params, go }) {
  let body;
  switch (page) {
    case 'home': body = <PubHome go={go} />; break;
    case 'about': body = <PubAbout go={go} />; break;
    case 'services': body = <PubServices go={go} />; break;
    case 'service': body = <PubServiceDetail go={go} params={params} />; break;
    case 'legal': body = <PubLegal go={go} params={params} />; break;
    case 'track': body = <PubTrack go={go} params={params} />; break;
    default: body = <PubHome go={go} />;
  }
  return (
    <div>
      <PublicNav go={go} page={page} />
      {body}
      <PublicFooter go={go} />
    </div>
  );
}

function App() {
  const [route, setRoute] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('hs_route')); if (s) return s; } catch (e) {}
    return { area: 'public', page: 'home', params: {} };
  });
  const [role, setRole] = useState(() => localStorage.getItem('hs_role') || null);

  // merged source of truth
  const [pkgs, setPkgs] = useState(() => {
    const base = [...DATA.PACKAGES, ...DATA.WAREHOUSE.filter(w => !DATA.PACKAGES.some(p => p.tracking === w.tracking))];
    return base;
  });
  const { toasts, push } = useToasts();

  useEffect(() => { localStorage.setItem('hs_route', JSON.stringify(route)); }, [route]);
  useEffect(() => { if (role) localStorage.setItem('hs_role', role); else localStorage.removeItem('hs_role'); }, [role]);

  const go = (area, page, params = {}) => { setRoute({ area, page, params }); window.scrollTo(0, 0); };
  const onAuth = (r) => {
    setRole(r);
    if (r === 'client') go('client', 'dashboard');
    else go('admin', { bodega: 'recepcion', entrega: 'ruta', finanzas: 'reportes', admin: 'admin-overview' }[r] || 'admin-overview');
  };
  const logout = () => { setRole(null); go('public', 'home'); };

  const mutate = (id, fn) => setPkgs(ps => ps.map(p => p.id === id ? fn(p) : p));
  const actions = {
    pay: (pkg) => mutate(pkg.id, p => ({ ...withEvent(p, 'en_ruta', 'Pago confirmado por el cliente'), paid: true })),
    advance: (pkg) => {
      const idx = DATA.statusIndex(pkg.status);
      const next = DATA.STATUSES[idx + 1];
      if (!next) return;
      mutate(pkg.id, p => {
        let np = withEvent(p, next.key);
        if (next.key === 'pendiente_pago' && !np.costs) np.costs = DATA.makeCosts(p.weight, true);
        return np;
      });
    },
    setCosts: (pkg, costs) => mutate(pkg.id, p => ({ ...withEvent(p, 'pendiente_pago', 'Costos aprobados por bodega'), costs })),
    deliver: (pkg) => mutate(pkg.id, p => withEvent(p, 'entregado', 'Entregado al destinatario')),
    receive: (pkg) => mutate(pkg.id, p => withEvent(p, 'recibido_miami', 'Recibido en bodega Miami')),
    prealert: (data) => {
      const np = {
        id: 'PKG-' + Math.floor(Math.random() * 9000 + 1000),
        tracking: data.tracking, carrier: data.carrier, desc: data.desc,
        client: 'Ana María Restrepo', clientCode: 'HS-1042',
        weight: data.weight, declared: data.declared, pieces: +data.pieces || 1,
        invoice: data.invoice || null, observations: data.observations || '',
        status: 'prealertado', prealerted: true,
        events: DATA.buildEvents('prealertado', 0), costs: null, paid: false,
        createdAt: new Date().toISOString(),
      };
      setPkgs(ps => [np, ...ps]);
      return np;
    },
  };

  let screen;
  if (route.area === 'public') screen = <PublicSite page={route.page} params={route.params} go={go} />;
  else if (route.area === 'auth') screen = route.page === 'register' ? <Register go={go} onAuth={onAuth} /> : <Login go={go} onAuth={onAuth} />;
  else if (route.area === 'client') screen = <ClientPortal page={route.page} go={go} pkgs={pkgs} onPay={actions.pay} onPrealert={actions.prealert} toast={push} />;
  else if (route.area === 'admin') screen = <AdminPortal role={role || 'admin'} page={route.page} go={go} pkgs={pkgs} actions={actions} toast={push} />;
  else screen = <PublicSite page="home" params={{}} go={go} />;

  return (<React.Fragment>{screen}<ToastHost toasts={toasts} /></React.Fragment>);
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
