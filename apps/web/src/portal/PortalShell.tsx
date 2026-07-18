/**
 * Cascara del portal: sidebar + area de contenido. El menu se arma desde el ROL
 * de la sesion usando el RBAC compartido (resourcesFor), replicando NAVS sin
 * confiar en el cliente: cada endpoint revalida el permiso (docs/06 §8).
 * La pantalla activa va en la URL (/app/<slug>, portal/routes.ts): deep-links,
 * recarga y botones atras/adelante funcionan.
 */
import { useEffect, useMemo, useState } from 'react';
import { ROLE_LABELS, Resource, resourcesFor } from '@courier/shared';
import type { Me } from './PortalApp';
import { api } from './lib/api';
import { pathForResource, resourceFromPath } from './routes';
import { UsersScreen } from './screens/UsersScreen';
import { CostServicesScreen } from './screens/CostServicesScreen';
import { TariffsScreen } from './screens/TariffsScreen';
import { RoutesScreen } from './screens/RoutesScreen';

interface NavItem { resource: Resource; label: string }
const NAV_GROUPS: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operación',
    items: [
      { resource: Resource.Dashboard, label: 'Resumen' },
      { resource: Resource.Package, label: 'Paquetes' },
      { resource: Resource.Costs, label: 'Costos' },
      { resource: Resource.Delivery, label: 'Entregas' },
      { resource: Resource.Clients, label: 'Clientes' },
      { resource: Resource.Tramite, label: 'Trámites' },
    ],
  },
  {
    group: 'Gestión',
    items: [
      { resource: Resource.Reports, label: 'Reportes' },
      { resource: Resource.Tariffs, label: 'Tarifas' },
      { resource: Resource.CostServices, label: 'Servicios de costos' },
      { resource: Resource.Routes, label: 'Rutas' },
      { resource: Resource.Config, label: 'Configuración' },
      { resource: Resource.Users, label: 'Usuarios' },
      { resource: Resource.Announcements, label: 'Anuncios' },
    ],
  },
];

export function PortalShell({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const allowed = useMemo(() => resourcesFor(me.role), [me.role]);
  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => allowed.has(i.resource)) })).filter(
        (g) => g.items.length > 0,
      ),
    [allowed],
  );

  const firstResource = visibleGroups[0]?.items[0]?.resource ?? Resource.Users;
  const defaultResource = allowed.has(Resource.Users) ? Resource.Users : firstResource;

  // Pantalla inicial: la de la URL si el rol la permite; si no, la por defecto.
  const [current, setCurrent] = useState<Resource>(() => {
    const fromUrl = resourceFromPath(window.location.pathname);
    return fromUrl && allowed.has(fromUrl) ? fromUrl : defaultResource;
  });
  const [navOpen, setNavOpen] = useState(false);

  // Botones atras/adelante del navegador.
  useEffect(() => {
    function onPopState() {
      const fromUrl = resourceFromPath(window.location.pathname);
      setCurrent(fromUrl && allowed.has(fromUrl) ? fromUrl : defaultResource);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [allowed, defaultResource]);

  // Canonicaliza la URL al recurso activo (cubre /app a secas y slugs no validos).
  useEffect(() => {
    const path = pathForResource(current);
    if (window.location.pathname !== path) window.history.replaceState(null, '', path);
  }, [current]);

  function selectResource(resource: Resource) {
    setCurrent(resource);
    setNavOpen(false); // en móvil, cerrar el drawer al navegar
    const path = pathForResource(resource);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }

  const roleLabel = ROLE_LABELS[me.role];
  const currentLabel =
    NAV_GROUPS.flatMap((g) => g.items).find((i) => i.resource === current)?.label ?? 'Portal';

  async function logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      onLoggedOut();
    }
  }

  return (
    <div className="portal">
      {navOpen && <div className="side-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`side${navOpen ? ' open' : ''}`}>
        <div className="side-brand">
          <img className="side-logo" src="/logo.png" alt="" />
          <span className="side-brand-text">
            <span className="n">HS Global</span>
            <span className="s">Courier</span>
          </span>
        </div>

        {visibleGroups.map((g) => (
          <div key={g.group}>
            <div className="side-group-label">{g.group}</div>
            {g.items.map((i) => (
              <button
                key={i.resource}
                className={`navitem${current === i.resource ? ' active' : ''}`}
                onClick={() => selectResource(i.resource)}
              >
                <NavIcon resource={i.resource} /> {i.label}
              </button>
            ))}
          </div>
        ))}

        <div className="side-foot">
          <div className="side-user">
            <span className="avatar">{initials(roleLabel)}</span>
            <span className="who">
              <div className="n">{roleLabel}</div>
              <div className="r">Cuenta interna</div>
            </span>
          </div>
          <button className="side-logout" onClick={logout}>Cerrar sesión</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            className="topbar-burger"
            type="button"
            aria-label="Abrir menú"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <h2>{currentLabel}</h2>
        </header>
        <section className="content">
          {current === Resource.Users ? (
            <UsersScreen />
          ) : current === Resource.Tariffs ? (
            <TariffsScreen />
          ) : current === Resource.CostServices ? (
            <CostServicesScreen />
          ) : current === Resource.Routes ? (
            <RoutesScreen />
          ) : (
            <div className="stub">
              <div className="big">{currentLabel}</div>
              <div>Esta pantalla se construirá en su módulo.</div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function initials(text: string): string {
  return text
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** Iconos minimos por recurso (stroke = currentColor). */
function NavIcon({ resource }: { resource: Resource }) {
  const paths: Partial<Record<Resource, JSX.Element>> = {
    [Resource.Dashboard]: <path d="M3 12h7V3H3zM14 21h7V3h-7zM3 21h7v-6H3z" />,
    [Resource.Package]: <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" />,
    [Resource.Costs]: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
    [Resource.CostServices]: <path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4M4 6v12c0 1.1.9 2 2 2h14v-4M18 12a2 2 0 000 4h4v-4z" />,
    [Resource.Tariffs]: <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01" />,
    [Resource.Routes]: <path d="M6 3a3 3 0 013 3c0 2-3 5-3 5S3 8 3 6a3 3 0 013-3zM18 13a3 3 0 013 3c0 2-3 5-3 5s-3-3-3-5a3 3 0 013-3zM6 11v3a4 4 0 004 4h4" />,
    [Resource.Delivery]: <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 21a2 2 0 100-4 2 2 0 000 4zM18.5 21a2 2 0 100-4 2 2 0 000 4z" />,
    [Resource.Clients]: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13A4 4 0 0116 11" />,
    [Resource.Tramite]: <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />,
    [Resource.Reports]: <path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3" />,
    [Resource.Config]: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-2.82 1.17V21a2 2 0 11-4 0v-.09A1.65 1.65 0 007 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 14 1.65 1.65 0 003 12.09V12a2 2 0 110-4h.09A1.65 1.65 0 004.6 7a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.31.22.66.22 1.02" />,
    [Resource.Users]: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13A4 4 0 0116 11" />,
    [Resource.Announcements]: <path d="M3 11l18-5v12L3 13v-2zM11.6 16.8a3 3 0 11-5.8-1.6" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[resource] ?? <circle cx="12" cy="12" r="9" />}
    </svg>
  );
}
