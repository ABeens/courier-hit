/**
 * Deep-links del portal: mapa Resource <-> slug de URL (/app/<slug>). Unica
 * fuente usada por la ruta catch-all de Astro (getStaticPaths, genera una
 * pagina estatica por slug) y por el shell React (pushState/popstate).
 * Los slugs van en espanol: son visibles en la URL, como el sitio publico.
 */
import { Resource } from '@courier/shared';

export const PORTAL_BASE = '/app';

export const RESOURCE_SLUGS: Record<Resource, string> = {
  [Resource.Prealert]: 'prealerta',
  [Resource.Package]: 'paquetes',
  [Resource.Locker]: 'casillero',
  [Resource.Profile]: 'perfil',
  [Resource.Reception]: 'recepcion',
  [Resource.Dashboard]: 'resumen',
  [Resource.Costs]: 'costos',
  [Resource.CostServices]: 'servicios-costos',
  [Resource.Tramite]: 'tramites',
  [Resource.Payments]: 'pagos',
  [Resource.Delivery]: 'entregas',
  [Resource.Reports]: 'reportes',
  [Resource.Clients]: 'clientes',
  [Resource.Config]: 'configuracion',
  [Resource.Tariffs]: 'tarifas',
  [Resource.Routes]: 'rutas',
  [Resource.Users]: 'usuarios',
  [Resource.Announcements]: 'anuncios',
};

const SLUG_TO_RESOURCE: Record<string, Resource> = Object.fromEntries(
  Object.entries(RESOURCE_SLUGS).map(([resource, slug]) => [slug, resource as Resource]),
);

/** Ruta canonica de un recurso, p. ej. `/app/usuarios`. */
export function pathForResource(resource: Resource): string {
  return `${PORTAL_BASE}/${RESOURCE_SLUGS[resource]}`;
}

/** Recurso del primer segmento tras /app; undefined si no hay slug o no existe. */
export function resourceFromPath(pathname: string): Resource | undefined {
  if (!pathname.startsWith(PORTAL_BASE)) return undefined;
  const slug = pathname.slice(PORTAL_BASE.length).replace(/^\//, '').split('/')[0];
  return slug ? SLUG_TO_RESOURCE[slug] : undefined;
}
