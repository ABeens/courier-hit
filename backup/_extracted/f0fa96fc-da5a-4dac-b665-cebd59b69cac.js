/* ============================================================
   HS GLOBAL — Tracking timeline & package widgets (shared)
   ============================================================ */

/* Vertical timeline of package events */
function TrackingTimeline({ pkg, compact = false }) {
  const idx = DATA.statusIndex(pkg.status);
  return (
    <div style={{ position: 'relative' }}>
      {pkg.events.map((ev, i) => {
        const meta = DATA.statusMeta(ev.status);
        const [fg, bg] = TONE[meta.tone] || TONE.info;
        const isCurrent = i === 0;
        const last = i === pkg.events.length - 1;
        return (
          <div key={i} style={{ display: 'flex', gap: 16, position: 'relative' }}>
            {/* rail */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{
                width: isCurrent ? 32 : 26, height: isCurrent ? 32 : 26, borderRadius: '50%',
                background: isCurrent ? fg : 'var(--surface)', border: `2px solid ${isCurrent ? fg : 'var(--line)'}`,
                display: 'grid', placeItems: 'center', marginTop: 2,
                boxShadow: isCurrent ? `0 0 0 5px ${bg}` : 'none', transition: 'all .3s',
              }}>
                <Icon name={ev.status === 'entregado' ? 'check' : isCurrent ? 'truck' : 'check'} size={isCurrent ? 15 : 12} color={isCurrent ? '#fff' : 'var(--faint)'} />
              </div>
              {!last && <div style={{ width: 2, flex: 1, minHeight: compact ? 22 : 30, background: i < idx ? 'var(--line)' : 'var(--line)', marginTop: 2 }} />}
            </div>
            {/* content */}
            <div style={{ paddingBottom: last ? 0 : (compact ? 16 : 22), flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: compact ? 14 : 15, color: isCurrent ? 'var(--ink)' : 'var(--ink-2)', fontFamily: 'var(--font-display)' }}>{ev.label}</span>
                {isCurrent && <span style={{ fontSize: 10.5, fontWeight: 700, color: fg, background: bg, padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase', letterSpacing: '.06em' }}>Actual</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4, color: 'var(--muted)', fontSize: 13 }}>
                <Icon name="pin" size={13} color="var(--faint)" />{ev.loc}
              </div>
              {ev.note && <div style={{ fontSize: 12.5, color: 'var(--faint)', marginTop: 3, fontStyle: 'italic' }}>{ev.note}</div>}
              <div className="mono" style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 5 }}>{DATA.fmtDateTime(ev.at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* Horizontal step strip showing the full flow with current highlighted */
function StepStrip({ statusKey }) {
  const idx = DATA.statusIndex(statusKey);
  const steps = DATA.STATUSES;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', width: '100%', overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((s, i) => {
        const done = i < idx, current = i === idx;
        const [fg, bg] = TONE[s.tone] || TONE.info;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'flex-start', flex: i === steps.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, minWidth: 64 }}>
              <div style={{
                width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                background: current ? fg : done ? 'var(--brand-soft)' : 'var(--paper-2)',
                border: current ? `2px solid ${fg}` : done ? `2px solid var(--brand)` : '2px solid var(--line)',
                boxShadow: current ? `0 0 0 4px ${bg}` : 'none',
              }}>
                {done ? <Icon name="check" size={13} color="var(--brand)" /> : <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: current ? '#fff' : 'var(--faint)' }}>{i + 1}</span>}
              </div>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: current ? 'var(--ink)' : done ? 'var(--ink-2)' : 'var(--faint)', textAlign: 'center', lineHeight: 1.25, maxWidth: 72 }}>{s.short}</span>
            </div>
            {i < steps.length - 1 && <div style={{ flex: 1, height: 2, background: done ? 'var(--brand)' : 'var(--line)', marginTop: 14, minWidth: 14 }} />}
          </div>
        );
      })}
    </div>
  );
}

/* Compact carrier badge */
function CarrierBadge({ carrier }) {
  const colors = {
    Amazon: ['#FF9900', '#fff8ef'], UPS: ['#7a5c2e', '#f6f0e6'], FedEx: ['#660099', '#f6eefb'],
    USPS: ['#004B87', '#eaf1f8'], DHL: ['#c8a200', '#fbf7e2'], SHEIN: ['#222', '#f0f0f0'],
    eBay: ['#e53238', '#fdeceb'], Walmart: ['#0071dc', '#e9f3fc'],
  };
  const [fg, bg] = colors[carrier] || ['var(--muted)', 'var(--paper-2)'];
  return <span style={{ fontSize: 11, fontWeight: 700, color: fg, background: bg, padding: '3px 9px', borderRadius: 6, letterSpacing: '-.01em' }}>{carrier}</span>;
}

/* Striped placeholder for imagery */
function Placeholder({ label, h = 200, style = {}, radius = 'var(--r-md)' }) {
  return (
    <div style={{
      height: h, borderRadius: radius, border: '1px dashed oklch(0.80 0.02 263)',
      background: 'repeating-linear-gradient(135deg, var(--paper-2), var(--paper-2) 11px, transparent 11px, transparent 22px)',
      display: 'grid', placeItems: 'center', ...style,
    }}>
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--faint)', letterSpacing: '.02em', textTransform: 'uppercase', background: 'var(--surface)', padding: '4px 10px', borderRadius: 6, border: '1px solid var(--line)' }}>{label}</span>
    </div>
  );
}

Object.assign(window, { TrackingTimeline, StepStrip, CarrierBadge, Placeholder });
