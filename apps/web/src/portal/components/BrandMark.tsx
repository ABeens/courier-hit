/**
 * BrandMark — version React del logo oficial (components/ui/Logo.astro): la
 * imagen de /public/logo.png mas el wordmark "HS Global · Courier".
 *
 * Existe porque las pantallas de autenticacion son islas React y no pueden
 * montar el componente Astro. Los estilos viven en portal.css para no duplicar
 * tokens; aqui solo la estructura.
 */

/** Relacion de aspecto real del archivo (1145 x 961). */
const RATIO = 1145 / 961;

interface Props {
  /** Alto de la imagen en px; el wordmark escala a partir de este valor. */
  size?: number;
  /** Sobre fondo oscuro: la imagen va en pastilla blanca y el texto en claro. */
  dark?: boolean;
}

export function BrandMark({ size = 44, dark = false }: Props) {
  return (
    <div
      className={dark ? 'brandmark brandmark--dark' : 'brandmark'}
      style={{ '--brandmark-h': `${size}px` } as React.CSSProperties}
    >
      <img
        className="brandmark__img"
        src="/logo.png"
        alt=""
        width={Math.round(size * RATIO)}
        height={size}
        decoding="async"
      />
      <div className="brandmark__text">
        <span className="brandmark__name">HS Global</span>
        <span className="brandmark__sub">Courier</span>
      </div>
    </div>
  );
}
