/* ============================================================
   HS GLOBAL — Mock data & domain helpers  (window.DATA)
   ============================================================ */
(function () {
  // ---- Status flow (ordered) ----
  const STATUSES = [
    { key: 'prealertado',    label: 'Prealertado',        short: 'Prealerta',  tone: 'purple', loc: 'Pendiente de llegada a Miami' },
    { key: 'recibido_miami', label: 'Recibido en Miami',   short: 'En Miami',   tone: 'info',   loc: 'Bodega Miami, FL (USA)' },
    { key: 'transito',       label: 'En tránsito',          short: 'Tránsito',   tone: 'info',   loc: 'En ruta internacional' },
    { key: 'aduana',         label: 'En aduana',            short: 'Aduana',     tone: 'info',   loc: 'Proceso aduanero' },
    { key: 'bodega_local',   label: 'En bodega local',      short: 'Bodega',     tone: 'brand',  loc: 'Bodega HS Global' },
    { key: 'pendiente_pago', label: 'Pendiente de pago',    short: 'Por pagar',  tone: 'warn',   loc: 'Retenido — pago requerido' },
    { key: 'en_ruta',        label: 'En ruta de entrega',   short: 'En ruta',    tone: 'brand',  loc: 'Con mensajero' },
    { key: 'entregado',      label: 'Entregado',            short: 'Entregado',  tone: 'ok',     loc: 'Entregado al destinatario' },
  ];
  const statusIndex = (k) => STATUSES.findIndex(s => s.key === k);
  const statusMeta = (k) => STATUSES.find(s => s.key === k) || STATUSES[0];

  const CARRIERS = ['Amazon', 'UPS', 'FedEx', 'USPS', 'DHL', 'SHEIN', 'eBay', 'Walmart'];

  // ---- helpers ----
  const pad = (n) => String(n).padStart(2, '0');
  function dt(daysAgo, h = 9, m = 0) {
    const d = new Date(2026, 5, 3, h, m); // base June 3, 2026
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    return `${pad(d.getDate())} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    return `${fmtDate(iso)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function money(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // build a timeline of events up to a status
  function buildEvents(statusKey, startDaysAgo) {
    const idx = statusIndex(statusKey);
    const evs = [];
    for (let i = 0; i <= idx; i++) {
      const s = STATUSES[i];
      evs.push({
        status: s.key,
        label: s.label,
        loc: s.loc,
        at: dt(startDaysAgo - i * 1.5, 8 + i, (i * 17) % 60),
        note: i === 0 ? 'Prealerta registrada por el cliente' : null,
      });
    }
    return evs.reverse();
  }

  function makeCosts(weight, withValues) {
    if (!withValues) return null;
    const flete = +(weight * 8.5).toFixed(2);
    const manejo = 4.50;
    const seguro = +(weight * 1.2).toFixed(2);
    const impuesto = +((flete + manejo + seguro) * 0.07).toFixed(2);
    const total = +(flete + manejo + seguro + impuesto).toFixed(2);
    return { flete, manejo, seguro, impuesto, total, approved: true };
  }

  let pkgN = 4821;
  function pkg(o) {
    const weight = o.weight;
    const costs = ['pendiente_pago','en_ruta','entregado'].includes(o.status) || o.costs ? makeCosts(weight, true) : (o.partialCost ? makeCosts(weight, true) : null);
    const paid = ['en_ruta','entregado'].includes(o.status);
    return {
      id: 'PKG-' + (pkgN++),
      tracking: o.tracking,
      carrier: o.carrier,
      desc: o.desc,
      client: o.client,
      clientCode: o.clientCode,
      weight,
      declared: o.declared,
      pieces: o.pieces || 1,
      invoice: o.invoice || null,
      observations: o.observations || '',
      status: o.status,
      prealerted: o.prealerted !== false,
      events: buildEvents(o.status, o.startDaysAgo ?? 8),
      costs,
      paid,
      createdAt: dt(o.startDaysAgo ?? 8, 10, 12),
    };
  }

  // ---- Clients ----
  const CLIENTS = [
    { code: 'HS-1042', name: 'Ana María Restrepo', email: 'ana.restrepo@gmail.com', phone: '+57 310 555 2204', city: 'Bogotá', since: '2024' },
    { code: 'HS-1108', name: 'Carlos Méndez',       email: 'carlos.mendez@outlook.com', phone: '+57 320 441 9087', city: 'Medellín', since: '2023' },
    { code: 'HS-1290', name: 'Lucía Fernández',     email: 'lucia.fz@gmail.com', phone: '+57 315 998 1120', city: 'Cali', since: '2025' },
    { code: 'HS-1377', name: 'Diego Salcedo',       email: 'd.salcedo@proton.me', phone: '+57 301 220 7741', city: 'Barranquilla', since: '2025' },
  ];

  // ---- Packages (the demo client is Ana María / HS-1042) ----
  const ME = CLIENTS[0];
  const PACKAGES = [
    pkg({ tracking: '1Z999AA10123456784', carrier: 'UPS',    desc: 'Audífonos Sony WH-1000XM5', client: ME.name, clientCode: ME.code, weight: 1.2, declared: 348, status: 'pendiente_pago', startDaysAgo: 9, invoice: 'factura-sony.pdf', observations: 'Frágil — caja sellada' }),
    pkg({ tracking: 'TBA305812994771',     carrier: 'Amazon', desc: 'Cafetera Breville Barista', client: ME.name, clientCode: ME.code, weight: 6.4, declared: 699, status: 'transito', startDaysAgo: 4, invoice: 'amazon-order-114.pdf' }),
    pkg({ tracking: '9400110200881234567', carrier: 'USPS',   desc: 'Vitaminas y suplementos (3)', client: ME.name, clientCode: ME.code, weight: 0.8, declared: 92, status: 'prealertado', startDaysAgo: 1, observations: 'Compra recurrente' }),
    pkg({ tracking: '7749112038',          carrier: 'SHEIN',  desc: 'Ropa — lote 12 prendas', client: ME.name, clientCode: ME.code, weight: 2.1, declared: 156, status: 'entregado', startDaysAgo: 22, invoice: 'shein-inv.pdf' }),
    pkg({ tracking: '8801442290117',       carrier: 'FedEx',  desc: 'Repuesto laptop (teclado)', client: ME.name, clientCode: ME.code, weight: 0.5, declared: 64, status: 'en_ruta', startDaysAgo: 12, invoice: 'fedex-receipt.pdf' }),
  ];

  // ---- Warehouse queue (incoming / admin view) — broader set ----
  const WAREHOUSE = [
    pkg({ tracking: '1Z999AA10123456784', carrier: 'UPS',    desc: 'Audífonos Sony WH-1000XM5', client: ME.name, clientCode: ME.code, weight: 1.2, declared: 348, status: 'pendiente_pago', startDaysAgo: 9 }),
    pkg({ tracking: '8801442290117',       carrier: 'FedEx',  desc: 'Repuesto laptop (teclado)', client: ME.name, clientCode: ME.code, weight: 0.5, declared: 64, status: 'en_ruta', startDaysAgo: 12 }),
    pkg({ tracking: '420889015582',        carrier: 'Walmart',desc: 'Set de cocina inox.', client: 'Carlos Méndez', clientCode: 'HS-1108', weight: 3.7, declared: 210, status: 'bodega_local', startDaysAgo: 3 }),
    pkg({ tracking: 'TBA771209933561',     carrier: 'Amazon', desc: 'Monitor LG 27"', client: 'Lucía Fernández', clientCode: 'HS-1290', weight: 5.2, declared: 320, status: 'recibido_miami', startDaysAgo: 2 }),
    pkg({ tracking: '9400111899223344551', carrier: 'USPS',   desc: 'Libros (4)', client: 'Diego Salcedo', clientCode: 'HS-1377', weight: 2.9, declared: 88, status: 'aduana', startDaysAgo: 5 }),
    pkg({ tracking: '6129004471',          carrier: 'eBay',   desc: 'Cámara vintage Canon AE-1', client: 'Carlos Méndez', clientCode: 'HS-1108', weight: 1.1, declared: 175, status: 'pendiente_pago', startDaysAgo: 7 }),
  ];

  // ---- System users (admin / roles) ----
  const SYS_USERS = [
    { name: 'Roberto Salas',   email: 'r.salas@hsglobal.ltd',   role: 'Administrador', status: 'activo', last: 'Hace 5 min', avatar: 'RS' },
    { name: 'Marta Quintero',  email: 'm.quintero@hsglobal.ltd',role: 'Bodega',        status: 'activo', last: 'Hace 12 min', avatar: 'MQ' },
    { name: 'José Ramírez',    email: 'j.ramirez@hsglobal.ltd', role: 'Bodega',        status: 'activo', last: 'Hace 1 h', avatar: 'JR' },
    { name: 'Paola Ríos',      email: 'p.rios@hsglobal.ltd',    role: 'Entrega',       status: 'activo', last: 'Hace 30 min', avatar: 'PR' },
    { name: 'Andrés Lozano',   email: 'a.lozano@hsglobal.ltd',  role: 'Finanzas',      status: 'activo', last: 'Ayer', avatar: 'AL' },
    { name: 'Camila Vega',     email: 'c.vega@hsglobal.ltd',    role: 'Entrega',       status: 'inactivo', last: 'Hace 8 días', avatar: 'CV' },
  ];

  // ---- Services (public site) ----
  const SERVICES = [
    { id: 'casillero', icon: 'box', name: 'Casillero en Miami', tag: 'El más popular',
      short: 'Tu dirección propia en EE. UU. para comprar en cualquier tienda y recibir en casa.',
      desc: 'Te asignamos una dirección física en Miami al registrarte. Compra en Amazon, eBay, SHEIN o cualquier tienda de EE. UU. y envía a tu casillero. Nosotros consolidamos, procesamos y despachamos hacia tu país.',
      points: ['Dirección de Miami al instante', 'Sin cuota mensual', 'Consolidación de paquetes gratis 30 días'] },
    { id: 'consolidacion', icon: 'layers', name: 'Consolidación de paquetes', tag: null,
      short: 'Junta varias compras en un solo envío y paga menos flete.',
      desc: 'Cuando esperas varios paquetes, los agrupamos en una sola caja optimizada. Menos peso volumétrico, menos flete, un solo trámite aduanero.',
      points: ['Hasta 60% de ahorro en flete', 'Reempaque optimizado', 'Fotos antes de despachar'] },
    { id: 'aereo', icon: 'plane', name: 'Carga aérea exprés', tag: null,
      short: 'Entrega rápida puerta a puerta con seguimiento en tiempo real.',
      desc: 'Para lo urgente. Despacho aéreo con tiempos de 3 a 6 días hábiles, tracking en vivo y gestión aduanera incluida.',
      points: ['3–6 días hábiles', 'Tracking en vivo', 'Gestión aduanera incluida'] },
    { id: 'maritimo', icon: 'ship', name: 'Carga marítima', tag: 'Mejor precio',
      short: 'La opción más económica para volúmenes grandes y mudanzas.',
      desc: 'Ideal para compras voluminosas, equipos o mudanzas. Tarifa por volumen, ruta marítima consolidada y manejo completo de documentación.',
      points: ['Tarifa por volumen', 'Sin límite de peso', 'Ideal para mudanzas'] },
    { id: 'compras', icon: 'cart', name: 'Servicio de compra asistida', tag: null,
      short: '¿La tienda no acepta tu tarjeta? Compramos por ti.',
      desc: 'Si una tienda no acepta tarjetas internacionales o no envía a casilleros, nuestro equipo realiza la compra por ti y la gestiona hasta tu puerta.',
      points: ['Compramos en tu nombre', 'Comisión transparente', 'Soporte de un asesor'] },
  ];

  window.DATA = {
    STATUSES, statusIndex, statusMeta, CARRIERS, CLIENTS, ME, PACKAGES, WAREHOUSE,
    SYS_USERS, SERVICES,
    fmtDate, fmtDateTime, money, buildEvents, makeCosts,
  };
})();
