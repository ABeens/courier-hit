/**
 * Pantalla "Mi casillero" — Requerimientos Parte 2.
 *
 * Muestra la dirección de Miami que el cliente pega en el checkout de Amazon o
 * eBay. Es una pantalla de COPIAR: cada línea tiene su acción, porque los
 * formularios de compra piden los campos por separado y seleccionar a mano un
 * bloque de texto en el móvil es donde se cometen los errores que hacen que un
 * paquete llegue sin identificador de casillero. La acción es un icono de
 * libreta (sin texto) para no llenar la tarjeta de botones repetidos.
 *
 * La dirección la arma la API con `lockerAddressFor`; aquí no se construye nada,
 * solo se pinta lo que llega.
 */
import { useEffect, useState } from 'react';
import { formatLockerCode } from '@courier/shared';
import { ApiError, api } from '../lib/api';

interface LockerLine {
  label: string;
  value: string;
}

interface Locker {
  clientCode: string;
  /** Sub-casillero del proveedor; `null` si el casillero aún no se sincronizó. */
  subLocker: string | null;
  lines: LockerLine[];
}

export function LockerScreen() {
  const [locker, setLocker] = useState<Locker | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Locker>('/clients/me/locker')
      .then(setLocker)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'No se pudo cargar tu casillero.'),
      );
  }, []);

  async function copy(line: LockerLine) {
    try {
      await navigator.clipboard.writeText(line.value);
      setCopied(line.label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Sin permiso de portapapeles (o navegador antiguo) no hay alternativa
      // silenciosa: se avisa para que el usuario copie a mano.
      setError('Tu navegador no permitió copiar. Selecciona el texto manualmente.');
    }
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Mi casillero</div>
          <div className="count">
            Usa esta dirección al comprar en tiendas de Estados Unidos.
          </div>
        </div>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

      {locker && (
        <>
          <div className="banner info" style={{ marginBottom: 16 }}>
            Escribe <strong>siempre</strong> tu identificador de casillero junto a tu nombre. La
            dirección es la misma para todos los clientes: sin ese identificador no podemos saber
            que el paquete es tuyo.
          </div>

          {/*
            La dirección ya no depende del proveedor (siempre lleva el código
            HS), pero un casillero sin enlazar todavía no existe para nuestra
            bodega de Miami: el paquete llegaría sin dueño. Es mejor decirlo que
            dejar que el cliente compre a ciegas.
          */}
          {!locker.subLocker && (
            <div className="banner warn" style={{ marginBottom: 16 }}>
              Tu casillero aún se está activando con nuestra bodega de Miami.
              Escríbenos antes de hacer tu primera compra para que no se retrase tu entrega.
            </div>
          )}

          <section className="locker-panel">
            <header className="locker-panel-head">
              <span className="locker-panel-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              </span>
              <div>
                <div className="locker-panel-title">Dirección en Miami</div>
                <div className="locker-panel-sub">Toca la libreta para copiar cada línea</div>
              </div>
              <span className="locker-code">{formatLockerCode(locker.clientCode)}</span>
            </header>

            <dl className="locker-rows">
              {locker.lines.map((line) => (
                <div className="locker-row" key={line.label}>
                  <dt>{line.label}</dt>
                  <dd>{line.value}</dd>
                  <button
                    type="button"
                    className={`locker-copy${copied === line.label ? ' is-copied' : ''}`}
                    onClick={() => copy(line)}
                    aria-label={`Copiar ${line.label}`}
                    title={copied === line.label ? 'Copiado' : 'Copiar'}
                  >
                    {copied === line.label ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="m4 12.5 5 5L20 6.5" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                        <rect x="8" y="3" width="12" height="16" rx="2.5" />
                        <path d="M16 19v1.5A2.5 2.5 0 0 1 13.5 23h-7A2.5 2.5 0 0 1 4 20.5v-11A2.5 2.5 0 0 1 6.5 7H8" />
                      </svg>
                    )}
                  </button>
                </div>
              ))}
            </dl>
          </section>
          {/* Confirmación audible del copiado: el icono solo la da en visual. */}
          <p className="sr-only" aria-live="polite">
            {copied ? `${copied} copiado` : ''}
          </p>
        </>
      )}
    </div>
  );
}
