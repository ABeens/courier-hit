/*
  Avisos flotantes (toasts) del portal.

  Existen por los modales: el error se pintaba como banner arriba del cuerpo, y
  quien habia hecho scroll hasta el boton de guardar no lo veia. Un toast queda
  fijo en la ventana, sin importar donde este el scroll del modal.

  El estado vive en el modulo (no en un contexto de React) para poder lanzar un
  aviso desde cualquier sitio sin pasar nada por props. `<Toaster />` se
  suscribe con useSyncExternalStore y los pinta.
*/
import { useCallback, useRef } from 'react';

export type ToastTone = 'err' | 'ok' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

/** Cuanto se queda un aviso a la vista si nadie lo cierra. */
const DURATION_MS: Record<ToastTone, number> = { err: 7000, ok: 4000, info: 5000 };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function showToast(message: string, tone: ToastTone = 'info'): number {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }];
  timers.set(id, setTimeout(() => dismissToast(id), DURATION_MS[tone]));
  emit();
  return id;
}

export const toast = {
  error: (message: string) => showToast(message, 'err'),
  success: (message: string) => showToast(message, 'ok'),
  info: (message: string) => showToast(message, 'info'),
};

/**
 * Sustituto de `const [error, setError] = useState<string | null>(null)` para
 * los modales: misma firma, pero el mensaje sale en un toast.
 *
 * - `setError(msg)` muestra el aviso y reemplaza el anterior de este mismo
 *   componente (repetir el mismo error lo vuelve a animar en vez de apilarlo).
 * - `setError(null)` lo retira, igual que antes desaparecia el banner al
 *   reintentar.
 * - Al desmontar NO se retira: si el modal se cierra, el aviso sigue siendo cierto.
 */
export function useErrorToast(): (message: string | null) => void {
  const current = useRef<number | null>(null);

  return useCallback((message: string | null) => {
    if (current.current != null) dismissToast(current.current);
    current.current = message ? toast.error(message) : null;
  }, []);
}
