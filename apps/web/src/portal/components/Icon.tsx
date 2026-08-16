/**
 * Icono del portal. Misma fuente de trazos que el sitio publico
 * (`components/ui/icons.ts`), pintada desde React en vez de Astro.
 *
 * Siempre `aria-hidden`: el icono NUNCA es el nombre accesible de nada. Quien
 * lo use dentro de un control tiene que ponerle el texto por su cuenta (lo hace
 * `IconButton` con `aria-label`), o de lo contrario el lector de pantalla anuncia
 * un boton sin nombre.
 */
import { ICONS } from '../../components/ui/icons';

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
  strokeWidth = 2,
  className,
}: {
  name: IconName | string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const raw = ICONS[name as string];
  if (!raw) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {raw.split('|').map((p, i) => {
        if (p.startsWith('o ')) {
          const [, cx, cy, r] = p.split(' ');
          return <circle key={i} cx={cx} cy={cy} r={r} />;
        }
        return <path key={i} d={p} />;
      })}
    </svg>
  );
}
