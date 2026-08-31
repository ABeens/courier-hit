/**
 * Cascara del portal: sidebar + area de contenido. El menu se arma desde el ROL
 * de la sesion usando el RBAC compartido (resourcesFor), replicando NAVS sin
 * confiar en el cliente: cada endpoint revalida el permiso (docs/06 §8).
 * La pantalla activa va en la URL (/app/<slug>, portal/routes.ts): deep-links,
 * recarga y botones atras/adelante funcionan.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Permission, ROLE_LABELS, Resource, Role, can, formatLockerCode, resourcesFor } from '@courier/shared';
import type { Me } from './PortalApp';
import { api } from './lib/api';
import type { NavIntent } from './lib/nav';
import { pathForResource, resourceFromPath } from './routes';
import { AnnouncementBanners } from './components/AnnouncementBanners';
import { AnnouncementsScreen } from './screens/AnnouncementsScreen';
import { UsersScreen } from './screens/UsersScreen';
import { CostServicesScreen } from './screens/CostServicesScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { CostsScreen } from './screens/CostsScreen';
import { TariffsScreen } from './screens/TariffsScreen';
import { RoutesScreen } from './screens/RoutesScreen';
import { ShipmentsScreen } from './screens/ShipmentsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { DeliveriesScreen } from './screens/DeliveriesScreen';
import { ClientsScreen } from './screens/ClientsScreen';
import { ProviderLinksScreen } from './screens/ProviderLinksScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { ReceptionScreen } from './screens/ReceptionScreen';
import { ControlRoomScreen } from './screens/ControlRoomScreen';
import { ApiKeysScreen } from './screens/ApiKeysScreen';
import { LockerScreen } from './screens/LockerScreen';
import { ProfileScreen } from './screens/ProfileScreen';

interface NavItem { resource: Resource; label: string }
/**
 * Seccion plegable del menu. Agrupa pantallas afines detras de una etiqueta con
 * chevron para que la columna se lea de un vistazo: con 16 entradas planas hay
 * que recorrerlas todas para encontrar una; con secciones se elige primero el
 * area y despues la pantalla.
 */
interface NavSection { id: SectionId; label: string; items: NavItem[] }
type NavEntry = NavItem | NavSection;

type SectionId = 'operacion' | 'finanzas' | 'admin';

function isSection(entry: NavEntry): entry is NavSection {
  return 'items' in entry;
}
/** Pantallas de una entrada, sea seccion o item suelto (para buscar/filtrar). */
function entryItems(entry: NavEntry): NavItem[] {
  return isSection(entry) ? entry.items : [entry];
}

/**
 * Menu del titular de casillero. Va aparte del de staff porque comparten el
 * recurso Package con etiquetas distintas: para el cliente son "sus" paquetes,
 * no la cola de operacion. Son cuatro entradas: van planas, plegarlas seria
 * esconder un menu que ya cabe entero a la vista.
 *
 * Prealertar NO tiene entrada propia: es una accion de "Mis paquetes" (el boton
 * abre `ClientShipmentModal`), porque el cliente avisa de un paquete para verlo
 * aparecer en ese mismo listado.
 *
 * "Otros tramites" es el listado de lo que NO es Paqueteria (aereo, maritimo,
 * agenciamiento): son tramites con otro flujo, otros campos y otra guia (AWB/BL),
 * asi que no caben en un listado que se llama "Mis paquetes". Es SOLO CONSULTA y
 * no tiene boton de alta: esos tramites no se prealertan, los registra el staff
 * (`tramite.manage`) tras acordar la gestion con el cliente.
 */
const CLIENT_NAV: NavEntry[] = [
  { resource: Resource.Locker, label: 'Mi casillero' },
  { resource: Resource.Package, label: 'Mis paquetes' },
  { resource: Resource.Tramite, label: 'Otros trámites' },
  { resource: Resource.Profile, label: 'Mi perfil' },
  // Ultima: es la unica entrada que no sirve para la operacion diaria del
  // casillero sino para conectar un sistema, y a eso se entra una vez. Se llama
  // "API" y no "Llaves de API" porque ahi dentro no solo estan las llaves:
  // tambien la documentacion de uso, que es lo que se busca la primera vez.
  { resource: Resource.ApiKeys, label: 'API' },
];

/**
 * Menu de staff. Lo que se usa a diario y no pertenece a un area (Resumen,
 * Clientes, Reportes) queda suelto en la raiz; el resto se pliega en tres
 * secciones por el momento en que se entra a ellas: mover carga, cobrar,
 * administrar.
 */
const STAFF_NAV: NavEntry[] = [
  { resource: Resource.Dashboard, label: 'Resumen' },
  {
    id: 'operacion',
    label: 'Operación',
    items: [
      { resource: Resource.Reception, label: 'Recepción' },
      { resource: Resource.Package, label: 'Paquetería' },
      { resource: Resource.Tramite, label: 'Trámites' },
      { resource: Resource.Delivery, label: 'Entregas' },
      // Va al final de Operación y no en Administración: se entra desde la mesa
      // de bodega, con la caja en la mano, no cuando uno se sienta a administrar.
      { resource: Resource.ControlRoom, label: 'Sala de control' },
    ],
  },
  { resource: Resource.Clients, label: 'Clientes' },
  {
    id: 'finanzas',
    label: 'Costos y tarifas',
    items: [
      // Los tres son dinero y se consultan en cadena (que costo el envio, que se
      // le cobra al cliente, que servicio fijo se le suma), asi que van juntos
      // aunque Costos se opere a diario y las tarifas se toquen de vez en cuando.
      { resource: Resource.Costs, label: 'Costos' },
      { resource: Resource.Tariffs, label: 'Tarifas' },
      { resource: Resource.CostServices, label: 'Servicios de costos' },
    ],
  },
  { resource: Resource.Reports, label: 'Reportes' },
  {
    id: 'admin',
    label: 'Administración',
    items: [
      { resource: Resource.Users, label: 'Usuarios' },
      { resource: Resource.Routes, label: 'Rutas' },
      { resource: Resource.Announcements, label: 'Anuncios' },
      // El recurso se llama `config` por el permiso (config.manage cubre mas
      // automatizacion), pero la pantalla es solo el enlace con Miami: la
      // etiqueta nombra lo que el usuario encuentra al entrar, no el permiso.
      { resource: Resource.Config, label: 'Enlace con Miami' },
      { resource: Resource.Settings, label: 'Configuración' },
    ],
  },
];

/** Id de la seccion a la que pertenece una pantalla (null si es item de raiz). */
function sectionIdFor(entries: NavEntry[], resource: Resource): SectionId | null {
  for (const entry of entries) {
    if (isSection(entry) && entry.items.some((i) => i.resource === resource)) return entry.id;
  }
  return null;
}

/**
 * Que seccion dejo abierta el usuario. Se guarda por navegador (no en el
 * perfil) porque es una preferencia de la vista, no del negocio: quien trabaja
 * todo el dia en bodega deja "Operación" abierta y el resto plegado.
 *
 * Guarda un solo id (o cadena vacia = todas plegadas) porque el menu es un
 * acordeon: nunca hay mas de una abierta.
 */
const NAV_OPEN_KEY = 'portal.nav.section';
const SECTION_IDS: SectionId[] = ['operacion', 'finanzas', 'admin'];

/** `undefined` = sin preferencia guardada; ahi manda el criterio por defecto. */
function readOpenSection(): SectionId | null | undefined {
  try {
    const raw = window.localStorage.getItem(NAV_OPEN_KEY);
    if (raw === null) return undefined;
    if (raw === '') return null;
    // Un id que ya no existe (seccion renombrada entre despliegues) se ignora.
    return SECTION_IDS.includes(raw as SectionId) ? (raw as SectionId) : undefined;
  } catch {
    return undefined; // localStorage bloqueado
  }
}

function writeOpenSection(id: SectionId | null) {
  try {
    window.localStorage.setItem(NAV_OPEN_KEY, id ?? '');
  } catch {
    // Sin localStorage la preferencia dura lo que la pestaña; el menu funciona igual.
  }
}

export function PortalShell({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const isClient = me.role === Role.Client;
  const navEntries = isClient ? CLIENT_NAV : STAFF_NAV;
  const miamiLink = me.features.miamiLink;
  /**
   * Lo que el rol puede ver, menos lo que este despliegue no ofrece. Al quitar
   * el recurso de este conjunto (y no solo del menu) la bandera apagada tambien
   * cierra el deep-link /app/enlace-miami y el salto desde el Resumen: la URL
   * cae en la pantalla por defecto, igual que un slug de otro rol.
   */
  const allowed = useMemo(() => {
    const resources = new Set(resourcesFor(me.role));
    if (!miamiLink) resources.delete(Resource.Config);
    /**
     * Prealertar ya no es una pantalla: vive dentro de "Mis paquetes". Se quita
     * tambien de este conjunto (y no solo del menu) para que el deep-link viejo
     * /app/prealerta caiga en la pantalla por defecto en vez de en el hueco de
     * una pantalla que no existe. El permiso de la API no se toca.
     */
    resources.delete(Resource.Prealert);
    return resources;
  }, [me.role, miamiLink]);
  /**
   * El menu del rol sin lo que no puede ver. Una seccion que se queda sin
   * pantallas desaparece entera: no tiene sentido un desplegable vacio.
   */
  const visibleNav = useMemo(
    () =>
      navEntries.flatMap<NavEntry>((entry) => {
        if (!isSection(entry)) return allowed.has(entry.resource) ? [entry] : [];
        const items = entry.items.filter((i) => allowed.has(i.resource));
        return items.length > 0 ? [{ ...entry, items }] : [];
      }),
    [allowed, navEntries],
  );

  const firstResource = visibleNav.flatMap(entryItems)[0]?.resource ?? Resource.Package;
  const defaultResource = allowed.has(Resource.Users) ? Resource.Users : firstResource;

  // Pantalla inicial: la de la URL si el rol la permite; si no, la por defecto.
  const [current, setCurrent] = useState<Resource>(() => {
    const fromUrl = resourceFromPath(window.location.pathname);
    return fromUrl && allowed.has(fromUrl) ? fromUrl : defaultResource;
  });
  const [navOpen, setNavOpen] = useState(false);

  /**
   * ACORDEON: como mucho una seccion abierta. Abrir una pliega la otra, asi la
   * columna nunca vuelve a crecer hasta la lista larga que estas secciones
   * vinieron a evitar, y siempre hay un solo bloque de opciones que leer.
   *
   * Arranca en la seccion que el usuario dejo abierta; si nunca eligio, en la de
   * la pantalla de entrada (o plegado todo, si esa pantalla es de raiz).
   */
  const [openSection, setOpenSection] = useState<SectionId | null>(() => {
    const stored = readOpenSection();
    return stored !== undefined ? stored : sectionIdFor(navEntries, current);
  });
  const activeSectionId = sectionIdFor(visibleNav, current);

  function toggleSection(id: SectionId) {
    const next = openSection === id ? null : id;
    setOpenSection(next);
    writeOpenSection(next);
  }

  /**
   * Al cambiar de pantalla se abre su seccion (y se pliega la anterior). Sin
   * esto, llegar por deep-link o desde un cuadro del Resumen a una pantalla de
   * otra seccion dejaria el menu abierto en una seccion que ya no viene al caso.
   * No se persiste: la preferencia guardada es la que el usuario elige a mano.
   */
  function syncSectionTo(resource: Resource) {
    const id = sectionIdFor(navEntries, resource);
    if (id) setOpenSection(id);
  }

  /**
   * Con que filtros se abre la pantalla destino cuando se llega a ella desde
   * otra (hoy, desde los cuadros del Resumen). `key` cambia en cada salto para
   * REMONTAR la pantalla: sin eso, saltar dos veces al mismo tablero con
   * filtros distintos dejaria los del primer salto, porque el estado inicial de
   * un componente ya montado no se vuelve a leer.
   *
   * No viaja en la URL a proposito: es el punto de partida de una consulta, no
   * una pantalla distinta. Recargar deja el tablero sin filtrar, que es lo
   * esperable de un atajo.
   */
  const [nav, setNav] = useState<{ intent: NavIntent; key: string } | null>(null);
  const navSeq = useRef(0);

  // Botones atras/adelante del navegador.
  useEffect(() => {
    function onPopState() {
      const fromUrl = resourceFromPath(window.location.pathname);
      const resource = fromUrl && allowed.has(fromUrl) ? fromUrl : defaultResource;
      setCurrent(resource);
      const id = sectionIdFor(navEntries, resource);
      if (id) setOpenSection(id);
      setNav(null);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [allowed, defaultResource, navEntries]);

  // Canonicaliza la URL al recurso activo (cubre /app a secas y slugs no validos).
  useEffect(() => {
    const path = pathForResource(current);
    if (window.location.pathname !== path) window.history.replaceState(null, '', path);
  }, [current]);

  /**
   * `intent` solo lo manda quien navega desde otra pantalla; el menu lateral
   * abre siempre la pantalla limpia.
   */
  function selectResource(resource: Resource, intent?: NavIntent) {
    setCurrent(resource);
    syncSectionTo(resource);
    setNav(intent ? { intent, key: `nav-${(navSeq.current += 1)}` } : null);
    setNavOpen(false); // en móvil, cerrar el drawer al navegar
    const path = pathForResource(resource);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }

  const roleLabel = ROLE_LABELS[me.role];
  const currentLabel =
    navEntries.flatMap(entryItems).find((i) => i.resource === current)?.label ?? 'Portal';

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
            <span className="s">Services</span>
          </span>
        </div>

        <nav className="side-nav">
          {visibleNav.map((entry) => {
            if (!isSection(entry)) {
              return (
                <button
                  key={entry.resource}
                  className={`navitem${current === entry.resource ? ' active' : ''}`}
                  onClick={() => selectResource(entry.resource)}
                >
                  <NavIcon resource={entry.resource} /> {entry.label}
                </button>
              );
            }
            const hasActive = entry.id === activeSectionId;
            const open = entry.id === openSection;
            return (
              <div className="navsection" key={entry.id}>
                {/* El punto (`has-active`) marca la seccion de la pantalla
                    activa cuando esta plegada: sin el, colapsarla dejaria el
                    menu sin ninguna señal de donde esta uno parado. */}
                <button
                  type="button"
                  className={`navitem navsection-btn${open ? ' open' : ''}${
                    hasActive && !open ? ' has-active' : ''
                  }`}
                  aria-expanded={open}
                  aria-controls={`navsection-${entry.id}`}
                  onClick={() => toggleSection(entry.id)}
                >
                  <SectionIcon id={entry.id} />
                  <span className="navsection-label">{entry.label}</span>
                  <svg
                    className="navsection-chev"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {open && (
                  <div className="navsection-items" id={`navsection-${entry.id}`}>
                    {entry.items.map((i) => (
                      <button
                        key={i.resource}
                        className={`navitem navitem-sub${current === i.resource ? ' active' : ''}`}
                        onClick={() => selectResource(i.resource)}
                      >
                        <NavIcon resource={i.resource} /> {i.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
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
          {/* La cuenta vive arriba a la derecha: es lo mismo en todas las
              pantallas y no compite con la navegacion del menu lateral. */}
          <AccountMenu
            name={roleLabel}
            /* "Cuenta interna" solo aplica a staff; al titular se le muestra su
               casillero, SIEMPRE en el formato de la etiqueta de envio
               (`HS0001000`): el cliente debe leer un unico numero, no el
               `HS-1000` interno aqui y otro distinto en la direccion. */
            detail={isClient ? (me.clientCode ? formatLockerCode(me.clientCode) : 'Casillero') : 'Cuenta interna'}
            onLogout={logout}
          />
        </header>
        {/* Avisos del portal del cliente: fuera de <section.content> para que la
            pila quede sticky bajo el topbar en todas las pantallas (§3.4.1). */}
        <AnnouncementBanners enabled={me.role === Role.Client} />
        {/* El Resumen es lo unico que no es una pantalla de trabajo sobre un
            listado: reparte paneles a lo ancho, asi que se le suelta el ancho de
            lectura de 1100px que rige al resto (una columna de texto y campos
            mas ancha que eso se lee peor, un tablero no). */}
        <section className={`content${current === Resource.Dashboard ? ' content-wide' : ''}`}>
          {current === Resource.Announcements ? (
            <AnnouncementsScreen />
          ) : current === Resource.Users ? (
            <UsersScreen />
          ) : current === Resource.Tariffs ? (
            <TariffsScreen />
          ) : current === Resource.CostServices ? (
            <CostServicesScreen />
          ) : current === Resource.Costs ? (
            <CostsScreen key={nav?.key} role={me.role} initialView={nav?.intent.costsView} />
          ) : current === Resource.Config ? (
            // El recurso `config` es hoy el enlace con el operador de Miami: es lo
            // único que un Admin necesita administrar aquí. Cuando entren más
            // ajustes, esta pantalla pasa a ser una pestaña más (y ahí sí toca
            // volver a llamar "Configuración" al ítem del menú).
            <ProviderLinksScreen />
          ) : current === Resource.Settings ? (
            // Hoy la pantalla es solo la tasa de cambio, pero el recurso es
            // "ajustes generales": lo que se sume despues entra aqui, no en una
            // entrada de menu nueva por cada valor.
            <SettingsScreen
              canEdit={can(me.role, Permission.ExchangeRateWrite)}
              canEditFreight={can(me.role, Permission.FreightRateWrite)}
            />
          ) : current === Resource.Routes ? (
            <RoutesScreen />
          ) : current === Resource.Package ? (
            // Para el cliente, "sus" tramites (la API ya acota el listado);
            // para staff, el tablero de Paqueteria con opcion de ver todos.
            <ShipmentsScreen
              key={nav?.key}
              role={me.role}
              initialView={nav?.intent.view ?? (isClient ? 'propios' : 'paqueteria')}
              initialState={nav?.intent.state}
              initialQuery={nav?.intent.q}
            />
          ) : current === Resource.Tramite ? (
            // Mismo modulo, dos lecturas: el staff opera la cola de Transporte y
            // Agenciamiento; el cliente ve (y registra) los suyos.
            <ShipmentsScreen
              key={nav?.key}
              role={me.role}
              initialView={isClient ? 'propios-tramites' : 'transporte'}
              initialState={nav?.intent.state}
              initialQuery={nav?.intent.q}
            />
          ) : current === Resource.Dashboard ? (
            <DashboardScreen allowed={allowed} onNavigate={selectResource} />
          ) : current === Resource.Reception ? (
            <ReceptionScreen canRegisterUnassigned={can(me.role, Permission.ControlRoomManage)} />
          ) : current === Resource.ControlRoom ? (
            // El rol decide si además de cambiar el dueño puede corregir el
            // estado: son dos permisos distintos (ver ControlRoomScreen).
            <ControlRoomScreen role={me.role} />
          ) : current === Resource.Delivery ? (
            <DeliveriesScreen />
          ) : current === Resource.Clients ? (
            <ClientsScreen
              canWrite={can(me.role, Permission.ClientsWrite)}
              canSuspend={can(me.role, Permission.ClientsSuspend)}
            />
          ) : current === Resource.Reports ? (
            <ReportsScreen />
          ) : current === Resource.Locker ? (
            <LockerScreen />
          ) : current === Resource.Profile ? (
            <ProfileScreen onLoggedOut={onLoggedOut} />
          ) : current === Resource.ApiKeys ? (
            <ApiKeysScreen />
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

/**
 * Cuenta del usuario en el topbar: el boton muestra quien esta dentro y el
 * desplegable guarda las acciones de la sesion (hoy, cerrar sesion). Se cierra
 * al hacer clic fuera o con Escape, como el resto de paneles del portal.
 */
function AccountMenu({
  name,
  detail,
  onLogout,
}: {
  name: string;
  detail: string;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="topbar-account" ref={ref}>
      <button
        type="button"
        className={`account-btn${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar">{initials(name)}</span>
        <span className="who">
          <span className="n">{name}</span>
          <span className="r">{detail}</span>
        </span>
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          {/* En movil el boton se queda solo con el avatar, asi que el nombre y
              el casillero se repiten aqui para no perderlos. */}
          <div className="account-menu-head">
            <div className="n">{name}</div>
            <div className="r">{detail}</div>
          </div>
          <button type="button" className="account-menu-item" role="menuitem" onClick={onLogout}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Cerrar sesión
          </button>
        </div>
      )}
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

/**
 * Icono de la seccion plegable. No reusa el de ninguna de sus pantallas a
 * proposito: repetir, por ejemplo, la caja de Paqueteria en la cabecera de
 * "Operación" haria leer la seccion como si fuera esa pantalla.
 */
function SectionIcon({ id }: { id: SectionId }) {
  const paths: Record<SectionId, JSX.Element> = {
    // Capas: varias pantallas del mismo flujo de bodega.
    operacion: <path d="M12 2l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" />,
    // Billete: todo lo que es plata.
    finanzas: <path d="M2 6h20v12H2zM12 14a2 2 0 100-4 2 2 0 000 4zM6 9v.01M18 15v.01" />,
    // Deslizadores: ajustes del sistema.
    admin: <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[id]}
    </svg>
  );
}

/** Iconos minimos por recurso (stroke = currentColor). */
function NavIcon({ resource }: { resource: Resource }) {
  const paths: Partial<Record<Resource, JSX.Element>> = {
    [Resource.Dashboard]: <path d="M3 12h7V3H3zM14 21h7V3h-7zM3 21h7v-6H3z" />,
    [Resource.Package]: <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8" />,
    [Resource.Locker]: <path d="M3 3h18v18H3zM3 9h18M9 9v12M6 6h.01" />,
    [Resource.Profile]: <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />,
    [Resource.Reception]: <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M8 9.5v4M12 11v4" />,
    [Resource.Costs]: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />,
    [Resource.CostServices]: <path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4M4 6v12c0 1.1.9 2 2 2h14v-4M18 12a2 2 0 000 4h4v-4z" />,
    // Llave: la credencial con la que un sistema entra por la API.
    [Resource.ApiKeys]: <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />,
    [Resource.Tariffs]: <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01" />,
    [Resource.Routes]: <path d="M6 3a3 3 0 013 3c0 2-3 5-3 5S3 8 3 6a3 3 0 013-3zM18 13a3 3 0 013 3c0 2-3 5-3 5s-3-3-3-5a3 3 0 013-3zM6 11v3a4 4 0 004 4h4" />,
    [Resource.Delivery]: <path d="M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 21a2 2 0 100-4 2 2 0 000 4zM18.5 21a2 2 0 100-4 2 2 0 000 4z" />,
    [Resource.Clients]: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13A4 4 0 0116 11" />,
    [Resource.Tramite]: <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />,
    [Resource.Reports]: <path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3" />,
    // Eslabones: la pantalla es el enlace con el operador, no ajustes del sistema.
    [Resource.Config]: <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />,
    // Engranaje: ajustes del sistema (a diferencia del eslabon de Resource.Config).
    [Resource.Settings]: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />,
    [Resource.Users]: <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13A4 4 0 0116 11" />,
    [Resource.Announcements]: <path d="M3 11l18-5v12L3 13v-2zM11.6 16.8a3 3 0 11-5.8-1.6" />,
    // Caja con interrogante: el bulto que llegó sin que nadie sepa de quién es.
    [Resource.ControlRoom]: <path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v3M12 19h.01" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {paths[resource] ?? <circle cx="12" cy="12" r="9" />}
    </svg>
  );
}
