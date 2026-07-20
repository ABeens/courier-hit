/**
 * AuthShell — marco comun de las pantallas de autenticacion (login, registro
 * de casillero e invitacion de staff).
 *
 * Dos columnas: a la izquierda el panel de marca (logo, promesa y ganchos, con
 * la misma paleta y tipografia del sitio publico); a la derecha el formulario.
 * En movil el panel se oculta y la marca aparece sobre la tarjeta, para no
 * empujar el formulario fuera de la primera pantalla.
 */
import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';

export interface AuthPoint {
  title: string;
  sub: string;
}

interface Props {
  /** Contenido de la tarjeta (formulario o resultado). */
  children: ReactNode;
  /** Promesa del panel de marca. */
  title: string;
  lead: string;
  points: AuthPoint[];
  /** El paso de datos del registro necesita una tarjeta ancha multicolumna. */
  wide?: boolean;
}

export function AuthShell({ children, title, lead, points, wide = false }: Props) {
  return (
    <div className="auth">
      <aside className="auth__aside">
        <a className="auth__brand" href="/" aria-label="Ir al inicio">
          <BrandMark size={46} dark />
        </a>

        <div className="auth__pitch">
          <span className="auth__route">Miami → Costa Rica</span>
          <h2 className="auth__title">{title}</h2>
          <p className="auth__lead">{lead}</p>

          <ul className="auth__points">
            {points.map((p) => (
              <li key={p.title} className="auth__point">
                <span className="auth__point-ic" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <span className="auth__point-body">
                  <span className="auth__point-title">{p.title}</span>
                  <span className="auth__point-sub">{p.sub}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="auth__foot">
          ¿Necesitas ayuda? Escríbenos a <a href="/contacto">soporte</a>.
        </p>
      </aside>

      <main className="auth__main">
        <div className={wide ? 'auth__inner is-wide' : 'auth__inner'}>
          <a className="auth__brand-mobile" href="/" aria-label="Ir al inicio">
            <BrandMark size={40} />
          </a>
          {children}
        </div>
      </main>
    </div>
  );
}
