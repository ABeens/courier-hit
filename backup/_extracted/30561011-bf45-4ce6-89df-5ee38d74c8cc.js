/* ============================================================
   HS GLOBAL — Public pages: About, Services, Legal, Track
   ============================================================ */
const PUB_WRAP = { maxWidth: 'var(--maxw)', margin: '0 auto', padding: '0 28px' };

function PubPageHead({ eyebrow, title, sub }) {
  return (
    <div style={{ background: 'linear-gradient(180deg, var(--brand-softer), var(--paper))', borderBottom: '1px solid var(--line)' }}>
      <div style={{ ...PUB_WRAP, padding: '56px 28px 48px' }}>
        <span className="chip" style={{ background: 'var(--surface)', borderColor: 'var(--brand-soft)', color: 'var(--brand-600)' }}>{eyebrow}</span>
        <h1 style={{ fontSize: 44, marginTop: 16, letterSpacing: '-.035em', maxWidth: 720 }}>{title}</h1>
        {sub && <p className="muted" style={{ fontSize: 17, marginTop: 14, maxWidth: 620, lineHeight: 1.55 }}>{sub}</p>}
      </div>
    </div>
  );
}

/* ---------------- ABOUT ---------------- */
function PubAbout({ go }) {
  return (
    <div className="fadeIn">
      <PubPageHead eyebrow="Quiénes somos" title="Conectamos a Latinoamérica con las tiendas del mundo." sub="HS Global Ltd nació para que comprar fuera de tu país sea tan simple como comprar en casa: transparente, rápido y sin letra pequeña." />
      <section style={{ ...PUB_WRAP, padding: '64px 28px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48, alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: 30, letterSpacing: '-.03em' }}>Resumen</h2>
            <p className="muted" style={{ fontSize: 16, marginTop: 16, lineHeight: 1.65 }}>Somos un operador logístico especializado en compras internacionales y casilleros. Recibimos tus paquetes en nuestra bodega de Miami, los consolidamos para ahorrarte flete, gestionamos la aduana y los entregamos en la puerta de tu casa.</p>
            <p className="muted" style={{ fontSize: 16, marginTop: 14, lineHeight: 1.65 }}>Cada paso es visible desde tu portal: prealertas, estados en tiempo real, costos y pagos. Sin llamadas, sin filas, sin incertidumbre.</p>
            <div style={{ display: 'flex', gap: 28, marginTop: 30 }}>
              {[['+12k', 'paquetes al año'], ['3', 'países atendidos'], ['98%', 'entregas a tiempo']].map(([a, b]) => (
                <div key={b}><div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 30, color: 'var(--brand)', letterSpacing: '-.02em' }}>{a}</div><div className="muted" style={{ fontSize: 13.5 }}>{b}</div></div>
              ))}
            </div>
          </div>
          <Placeholder label="Foto — equipo / bodega Miami" h={340} radius="var(--r-lg)" />
        </div>
      </section>
      <section style={{ background: 'var(--paper-2)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div style={{ ...PUB_WRAP, padding: '64px 28px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {[
            ['zap', 'Nuestra misión', 'Eliminar las fronteras del comercio para que cualquier persona en Latinoamérica acceda a los productos del mundo con total confianza, a un precio justo y con visibilidad de principio a fin.'],
            ['globe', 'Nuestra visión', 'Ser la plataforma de compras internacionales más confiable de la región: la primera opción cuando alguien piensa en traer algo desde el exterior, por su transparencia y tecnología.'],
          ].map(([ic, t, d]) => (
            <div key={t} className="card" style={{ padding: 32 }}>
              <span style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--brand)', display: 'grid', placeItems: 'center', boxShadow: 'var(--sh-brand)' }}><Icon name={ic} size={25} color="#fff" /></span>
              <h3 style={{ fontSize: 23, marginTop: 20 }}>{t}</h3>
              <p className="muted" style={{ fontSize: 15.5, marginTop: 12, lineHeight: 1.65 }}>{d}</p>
            </div>
          ))}
        </div>
      </section>
      <section style={{ ...PUB_WRAP, padding: '64px 28px' }}>
        <h2 style={{ fontSize: 30, letterSpacing: '-.03em', marginBottom: 8 }}>Lo que nos mueve</h2>
        <p className="muted" style={{ fontSize: 16, marginBottom: 32 }}>Tres principios que aplicamos en cada envío.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }}>
          {[['eye', 'Transparencia', 'Ves cada estado, cada costo y cada documento. Nada oculto.'], ['zap', 'Velocidad', 'Procesos optimizados para que tu paquete no se quede esperando.'], ['shield', 'Confianza', 'Tus paquetes y tus pagos, protegidos en todo momento.']].map(([ic, t, d]) => (
            <div key={t} style={{ padding: '4px 4px' }}>
              <span style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name={ic} size={21} color="var(--brand)" /></span>
              <h4 style={{ fontSize: 18, marginTop: 16 }}>{t}</h4>
              <p className="muted" style={{ fontSize: 14.5, marginTop: 8, lineHeight: 1.6 }}>{d}</p>
            </div>
          ))}
        </div>
      </section>
      <CtaStrip go={go} />
    </div>
  );
}

function CtaStrip({ go }) {
  return (
    <section style={{ ...PUB_WRAP, padding: '0 28px 80px' }}>
      <div className="between" style={{ background: 'var(--brand)', borderRadius: 'var(--r-xl)', padding: '38px 44px', flexWrap: 'wrap', gap: 20, boxShadow: 'var(--sh-brand)' }}>
        <div>
          <h3 style={{ fontSize: 26, color: '#fff' }}>¿List@ para tu primer envío?</h3>
          <p style={{ color: 'oklch(0.95 0.03 263)', fontSize: 15.5, marginTop: 6 }}>Crea tu casillero gratis y empieza a comprar hoy mismo.</p>
        </div>
        <button className="btn btn-lg" onClick={() => go('auth', 'register')} style={{ background: '#fff', color: 'var(--brand-600)' }}>Crear casillero<Icon name="arrowR" size={17} /></button>
      </div>
    </section>
  );
}

/* ---------------- SERVICES LIST ---------------- */
function PubServices({ go }) {
  return (
    <div className="fadeIn">
      <PubPageHead eyebrow="Servicios" title="Cinco formas de traer lo que quieras." sub="Desde un casillero gratuito hasta carga marítima para mudanzas. Elige el servicio que se ajusta a tu compra." />
      <section style={{ ...PUB_WRAP, padding: '56px 28px 72px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {DATA.SERVICES.map((s, i) => (
          <div key={s.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'grid', gridTemplateColumns: i % 2 ? '1fr 380px' : '380px 1fr' }}>
            <div style={{ padding: 36, order: i % 2 ? 1 : 2 }}>
              <div className="between">
                <span style={{ width: 54, height: 54, borderRadius: 15, background: 'var(--brand-soft)', display: 'grid', placeItems: 'center' }}><Icon name={s.icon} size={26} color="var(--brand)" /></span>
                {s.tag && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand-600)', background: 'var(--brand-soft)', padding: '5px 12px', borderRadius: 99 }}>{s.tag}</span>}
              </div>
              <h3 style={{ fontSize: 26, marginTop: 20, letterSpacing: '-.02em' }}>{s.name}</h3>
              <p className="muted" style={{ fontSize: 15.5, marginTop: 10, lineHeight: 1.6, maxWidth: 520 }}>{s.desc}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
                {s.points.map(p => <span key={p} className="chip"><Icon name="check" size={13} color="var(--ok)" />{p}</span>)}
              </div>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 24 }} onClick={() => go('public', 'service', { id: s.id })}>Ver detalle<Icon name="arrowR" size={15} /></button>
            </div>
            <div style={{ order: i % 2 ? 2 : 1, padding: 18, background: 'var(--paper-2)', display: 'grid' }}>
              <Placeholder label={`Imagen — ${s.name}`} h="100%" style={{ minHeight: 220 }} radius="var(--r-md)" />
            </div>
          </div>
        ))}
      </section>
      <CtaStrip go={go} />
    </div>
  );
}

/* ---------------- SERVICE DETAIL ---------------- */
function PubServiceDetail({ go, params }) {
  const s = DATA.SERVICES.find(x => x.id === params.id) || DATA.SERVICES[0];
  return (
    <div className="fadeIn">
      <div style={{ ...PUB_WRAP, paddingTop: 24 }}>
        <button onClick={() => go('public', 'services')} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', fontSize: 14, fontWeight: 600, padding: '8px 0' }}><Icon name="chevR" size={15} style={{ transform: 'rotate(180deg)' }} />Servicios</button>
      </div>
      <PubPageHead eyebrow={s.tag || 'Servicio'} title={s.name} sub={s.short} />
      <section style={{ ...PUB_WRAP, padding: '56px 28px 72px', display: 'grid', gridTemplateColumns: '1.2fr .8fr', gap: 44 }}>
        <div>
          <Placeholder label={`Imagen principal — ${s.name}`} h={300} radius="var(--r-lg)" />
          <h3 style={{ fontSize: 24, marginTop: 32 }}>Cómo funciona</h3>
          <p className="muted" style={{ fontSize: 16, marginTop: 12, lineHeight: 1.7 }}>{s.desc}</p>
          <div style={{ display: 'grid', gap: 12, marginTop: 24 }}>
            {s.points.map((p, i) => (
              <div key={p} className="card" style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--ok-soft)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="check" size={16} color="oklch(0.45 0.12 160)" /></span>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
        <aside>
          <div className="card" style={{ padding: 26, position: 'sticky', top: 90, boxShadow: 'var(--sh-2)' }}>
            <h4 style={{ fontSize: 19 }}>Empieza con este servicio</h4>
            <p className="muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>Crea tu casillero gratis y selecciona este servicio al prealertar tu paquete.</p>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 18 }} onClick={() => go('auth', 'register')}>Crear casillero gratis<Icon name="arrowR" size={16} /></button>
            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => go('public', 'track')}>Rastrear un paquete</button>
            <div style={{ borderTop: '1px solid var(--line)', marginTop: 22, paddingTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[['phone', '+1 (555) 010-0000'], ['mail', 'info@hsgloballtd.com']].map(([ic, t]) => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--ink-2)' }}><Icon name={ic} size={16} color="var(--brand)" />{t}</div>
              ))}
            </div>
          </div>
        </aside>
      </section>
      <CtaStrip go={go} />
    </div>
  );
}

/* ---------------- LEGAL ---------------- */
const LEGAL_DOCS = {
  terminos: {
    title: 'Términos de uso', updated: '1 de junio de 2026',
    sections: [
      ['1. Aceptación', 'Al crear una cuenta y utilizar los servicios de HS Global Ltd ("HS Global", "nosotros"), usted acepta estos Términos de uso en su totalidad. Si no está de acuerdo, le pedimos no utilizar la plataforma.'],
      ['2. El servicio de casillero', 'HS Global asigna a cada cliente una dirección de recepción en Miami, FL. El cliente es responsable de la legalidad y veracidad de los bienes que envíe a dicha dirección, así como de la información declarada en cada prealerta.'],
      ['3. Prealertas y declaración', 'El cliente se compromete a registrar la prealerta de sus paquetes con datos veraces: número de tracking, factura comercial y descripción del contenido. Una declaración incorrecta puede generar retrasos, costos adicionales o retención por aduana.'],
      ['4. Costos y pagos', 'Los costos de flete, manejo, seguro e impuestos se calculan al recibir y procesar cada paquete. HS Global no despacha ni entrega un paquete cuyo pago no haya sido completado a través de la plataforma. Los precios pueden variar según peso, volumen y servicio elegido.'],
      ['5. Entrega', 'La entrega se realiza en la dirección registrada por el cliente. Es responsabilidad del cliente proporcionar una dirección correcta y disponer de una persona que reciba el paquete.'],
      ['6. Limitación de responsabilidad', 'HS Global no se responsabiliza por demoras causadas por terceros (transportistas, aduanas) ni por bienes prohibidos. La cobertura de seguro aplica según el valor declarado y las condiciones contratadas.'],
      ['7. Modificaciones', 'HS Global puede actualizar estos términos. Notificaremos los cambios relevantes a través de la plataforma y del correo registrado.'],
    ],
  },
  privacidad: {
    title: 'Política de privacidad', updated: '1 de junio de 2026',
    sections: [
      ['1. Datos que recopilamos', 'Recopilamos los datos que usted proporciona al registrarse (nombre, correo, teléfono, dirección) y los datos generados por el uso del servicio (prealertas, paquetes, pagos, estados de envío).'],
      ['2. Uso de la información', 'Usamos sus datos para operar el servicio de casillero y envíos, procesar pagos, comunicarnos con usted sobre el estado de sus paquetes y cumplir obligaciones legales y aduaneras.'],
      ['3. Validación de correo', 'Al registrarse, enviamos un código de verificación a su correo electrónico para confirmar su identidad y proteger su cuenta. La cuenta permanece limitada hasta completar esta validación.'],
      ['4. Compartir con terceros', 'Compartimos únicamente la información necesaria con transportistas, agentes de aduana y procesadores de pago para completar su envío. No vendemos sus datos personales.'],
      ['5. Seguridad', 'Aplicamos medidas técnicas y organizativas para proteger su información. Los pagos se procesan a través de pasarelas seguras y la información sensible se almacena cifrada.'],
      ['6. Sus derechos', 'Usted puede acceder, rectificar o solicitar la eliminación de sus datos personales escribiendo a info@hsgloballtd.com. Atenderemos su solicitud conforme a la normativa aplicable.'],
      ['7. Cookies', 'Utilizamos cookies para mantener su sesión y mejorar su experiencia. Puede gestionarlas desde la configuración de su navegador.'],
    ],
  },
};
function PubLegal({ go, params }) {
  const doc = LEGAL_DOCS[params.doc] || LEGAL_DOCS.terminos;
  const other = params.doc === 'privacidad' ? 'terminos' : 'privacidad';
  return (
    <div className="fadeIn">
      <PubPageHead eyebrow="Legal" title={doc.title} sub={`Última actualización: ${doc.updated}`} />
      <section style={{ ...PUB_WRAP, padding: '48px 28px 72px', display: 'grid', gridTemplateColumns: '240px 1fr', gap: 44 }}>
        <aside>
          <div style={{ position: 'sticky', top: 90 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 14 }}>Documentos</div>
            {Object.entries(LEGAL_DOCS).map(([k, d]) => (
              <button key={k} onClick={() => go('public', 'legal', { doc: k })} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '11px 14px', borderRadius: 9, fontSize: 14, fontWeight: 600, marginBottom: 4, color: params.doc === k || (!params.doc && k === 'terminos') ? 'var(--brand)' : 'var(--ink-2)', background: (params.doc === k || (!params.doc && k === 'terminos')) ? 'var(--brand-soft)' : 'transparent' }}>{d.title}</button>
            ))}
          </div>
        </aside>
        <div style={{ maxWidth: 720 }}>
          {doc.sections.map(([t, body]) => (
            <div key={t} style={{ marginBottom: 32 }}>
              <h3 style={{ fontSize: 19, marginBottom: 10 }}>{t}</h3>
              <p className="muted" style={{ fontSize: 15.5, lineHeight: 1.75 }}>{body}</p>
            </div>
          ))}
          <div className="card" style={{ padding: 22, background: 'var(--paper-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 14.5 }}>¿Tienes dudas sobre este documento?</span>
            <button className="btn btn-ghost btn-sm" onClick={() => go('public', 'legal', { doc: other })}>Ver {LEGAL_DOCS[other].title.toLowerCase()}<Icon name="arrowR" size={15} /></button>
          </div>
        </div>
      </section>
    </div>
  );
}

Object.assign(window, { PubAbout, PubServices, PubServiceDetail, PubLegal, PUB_WRAP, PubPageHead, CtaStrip });
