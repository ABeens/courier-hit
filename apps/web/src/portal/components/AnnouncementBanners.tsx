/**
 * Pila de banners del portal del cliente (docs/manuales/roles.md §3.4).
 *
 * Queda fija bajo el topbar y flota sobre el contenido al hacer scroll, en todas
 * las pantallas del portal. Cuando no hay nada vigente no ocupa espacio: el
 * contenido sube solo. Orden, colores y limite de 3 los define el servidor y el
 * dominio compartido; aqui solo se pintan.
 */
import { ANNOUNCEMENT_TYPE_LABELS, AnnouncementType } from '@courier/shared';
import type { ActiveAnnouncementDto } from '@courier/shared';
import { useActiveAnnouncements } from '../lib/announcements';

/** Modificador de color por tipo: informativo azul, advertencia amarillo, critico rojo (§3.4.3). */
const TYPE_CLASS: Record<AnnouncementType, string> = {
  [AnnouncementType.Informativo]: 'info',
  [AnnouncementType.Advertencia]: 'warn',
  [AnnouncementType.Critico]: 'crit',
};

/** `role` del banner: solo lo critico interrumpe al lector de pantalla. */
const TYPE_ROLE: Record<AnnouncementType, 'alert' | 'status'> = {
  [AnnouncementType.Informativo]: 'status',
  [AnnouncementType.Advertencia]: 'status',
  [AnnouncementType.Critico]: 'alert',
};

export function AnnouncementBanners({ enabled }: { enabled: boolean }) {
  const { items, dismiss } = useActiveAnnouncements(enabled);
  if (items.length === 0) return null;

  return (
    <div className="ann-stack">
      {items.map((a) => (
        <AnnouncementBanner key={a.id} announcement={a} onDismiss={() => dismiss(a.id)} />
      ))}
    </div>
  );
}

function AnnouncementBanner({
  announcement: a,
  onDismiss,
}: {
  announcement: ActiveAnnouncementDto;
  onDismiss: () => void;
}) {
  return (
    <div className={`ann ann-${TYPE_CLASS[a.type]} fadeUp`} role={TYPE_ROLE[a.type]}>
      <TypeIcon type={a.type} />
      <div className="ann-text">
        <span className="ann-title">{a.title}</span>
        <span className="ann-msg">{a.message}</span>
      </div>
      <button
        type="button"
        className="ann-close"
        onClick={onDismiss}
        aria-label={`Descartar aviso: ${a.title}`}
        title="Descartar"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

/** El icono acompaña al color: el tipo no se comunica solo con el matiz. */
function TypeIcon({ type }: { type: AnnouncementType }) {
  const paths: Record<AnnouncementType, JSX.Element> = {
    [AnnouncementType.Informativo]: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4M12 8h.01" />
      </>
    ),
    [AnnouncementType.Advertencia]: (
      <>
        <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    [AnnouncementType.Critico]: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5M12 16h.01" />
      </>
    ),
  };
  return (
    <svg
      className="ann-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={ANNOUNCEMENT_TYPE_LABELS[type]}
    >
      {paths[type]}
    </svg>
  );
}
