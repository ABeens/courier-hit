/**
 * Accion de fila, en icono.
 *
 * Las listas repiten las mismas cuatro o cinco acciones en cada registro, asi
 * que el texto no informa: se lee una vez y luego solo ocupa el ancho que le
 * falta a los datos. En icono la fila cabe entera y la accion se reconoce por
 * la forma. A cambio hay que sostener DOS cosas, y por eso existe este
 * componente en vez de escribir el `<button>` a mano en cada pantalla:
 *
 *   - `aria-label`: sin el, un lector de pantalla anuncia "boton" y nada mas.
 *     El icono va `aria-hidden`, no aporta nombre.
 *   - `title`: el globo nativo del navegador. Es lo que rescata a quien ve el
 *     icono y no lo reconoce. Se usa el nativo y no un globo en CSS porque la
 *     ficha es `overflow: hidden` y recortaria cualquier cosa que se salga.
 *
 * `hint` sustituye al globo cuando hay algo mas que decir que el nombre de la
 * accion (tipicamente por que esta deshabilitada).
 *
 * Solo para acciones DENTRO de una fila. Un boton de alta, de formulario o de
 * pie de modal conserva su texto: se ve una vez, no se aprende por repeticion y
 * equivocarse ahi cuesta caro.
 */
import { Icon } from './Icon';
import type { IconName } from './Icon';

type Tone = 'ghost' | 'primary' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  ghost: 'btn-ghost',
  primary: 'btn-primary',
  danger: 'btn-ghost btn-danger-ghost',
};

interface BaseProps {
  /** Nombre accesible y texto del globo. En infinitivo, como el boton que sustituye. */
  label: string;
  icon: IconName | string;
  /** Reemplaza al globo cuando hace falta explicar algo mas que el nombre. */
  hint?: string;
  tone?: Tone;
}

export function IconButton({
  label,
  icon,
  hint,
  tone = 'ghost',
  disabled,
  onClick,
}: BaseProps & {
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn ${TONE_CLASS[tone]} btn-sm btn-icon`}
      title={hint ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

/**
 * Variante enlace. La descarga de un documento la resuelve el navegador contra
 * la API (que es quien comprueba el permiso), asi que tiene que ser un `<a>`
 * de verdad y no un boton: un boton no abre pestaña ni ofrece "guardar como".
 */
export function IconLink({
  label,
  icon,
  hint,
  tone = 'ghost',
  href,
}: BaseProps & { href: string }) {
  return (
    <a
      className={`btn ${TONE_CLASS[tone]} btn-sm btn-icon`}
      title={hint ?? label}
      aria-label={label}
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      <Icon name={icon} />
    </a>
  );
}
