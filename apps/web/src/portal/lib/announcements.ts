/**
 * Datos y descarte de los banners del portal del cliente (docs/manuales/roles.md §3.4).
 *
 * Refresco (§3.4.5: "deja de mostrarse automáticamente"). En vez de sondear a
 * ciegas cada X, la API devuelve `nextChangeAt` — el fin de vigencia mas proximo
 * del conjunto que acaba de entregar — y aqui se agenda UN solo temporizador que
 * se auto-reprograma: si un banner vence en 40 s, se recarga en 40 s; si no vence
 * nada en horas, se recarga al llegar al techo de sondeo. Ademas se revalida al
 * volver a la pestaña. Resultado: el banner desaparece al vencer sin tener que
 * recargar la pagina, y sin martillear la API.
 *
 * Descarte (§3.4.4). Vive en `sessionStorage`, no en el servidor: la persistencia
 * es POR SESION, no por usuario. Recargar la pagina lo conserva; volver a iniciar
 * sesion lo limpia (lo hace PortalApp), que es exactamente lo que pide el spec.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ActiveAnnouncementDto } from '@courier/shared';
import { api } from './api';

/** Techo de refresco: nunca se deja pasar mas de esto sin revalidar. */
const MAX_REFRESH_MS = 5 * 60_000;
/** Piso: evita una tormenta de peticiones si el vencimiento es inminente. */
const MIN_REFRESH_MS = 5_000;
/** Colchon tras el vencimiento, para que el servidor ya lo vea fuera de vigencia. */
const EXPIRY_GRACE_MS = 1_000;

const DISMISSED_KEY = 'hsg.announcements.dismissed';

/** sessionStorage puede lanzar (modo privado, cookies bloqueadas): nunca romper el portal por esto. */
function safeSession<T>(fn: (s: Storage) => T, fallback: T): T {
  try {
    return typeof sessionStorage === 'undefined' ? fallback : fn(sessionStorage);
  } catch {
    return fallback;
  }
}

function readDismissed(): string[] {
  return safeSession((s) => {
    const raw = s.getItem(DISMISSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  }, []);
}

/** Borra los descartes: la llama PortalApp al iniciar y al cerrar sesion. */
export function clearDismissedAnnouncements(): void {
  safeSession((s) => s.removeItem(DISMISSED_KEY), undefined);
}

interface ActiveResponse {
  items: ActiveAnnouncementDto[];
  nextChangeAt: string | null;
}

/**
 * Anuncios vigentes que el usuario aun no ha descartado. El servidor ya los
 * entrega ordenados por severidad + recencia y recortados al maximo visible, asi
 * que aqui no se reordena ni se recorta: solo se restan los descartados.
 */
export function useActiveAnnouncements(enabled: boolean) {
  const [items, setItems] = useState<ActiveAnnouncementDto[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  // Todo el ciclo (peticion + reagendado) vive dentro del efecto: asi el
  // temporizador solo se crea y se destruye cuando cambia `enabled`, y no hace
  // falta arrastrar la funcion por refs entre renders.
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      let delay = MAX_REFRESH_MS;
      try {
        const data = await api.get<ActiveResponse>('/announcements/active');
        if (cancelled) return;
        setItems(data.items);
        if (data.nextChangeAt) {
          const untilExpiry = new Date(data.nextChangeAt).getTime() - Date.now() + EXPIRY_GRACE_MS;
          delay = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, untilExpiry));
        }
      } catch {
        // Un fallo de red no debe vaciar los banners que ya se estan mostrando:
        // se conserva lo ultimo bueno y se reintenta en el siguiente ciclo.
      }
      if (cancelled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), delay);
    }

    void load();

    // Al volver a la pestaña, revalidar: pudo vencer algo mientras estaba oculta
    // (los temporizadores se ralentizan en pestañas de fondo).
    function onVisible() {
      if (document.visibilityState === 'visible') void load();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      safeSession((s) => s.setItem(DISMISSED_KEY, JSON.stringify(next)), undefined);
      return next;
    });
  }, []);

  return { items: items.filter((a) => !dismissed.includes(a.id)), dismiss };
}
