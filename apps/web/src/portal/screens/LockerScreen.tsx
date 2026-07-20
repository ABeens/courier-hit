/**
 * Pantalla "Mi casillero" — Requerimientos Parte 2.
 *
 * Muestra la dirección de Miami que el cliente pega en el checkout de Amazon o
 * eBay. Es una pantalla de COPIAR: cada línea tiene su botón, porque los
 * formularios de compra piden los campos por separado y seleccionar a mano un
 * bloque de texto en el móvil es donde se cometen los errores que hacen que un
 * paquete llegue sin identificador de casillero.
 *
 * La dirección la arma la API con `lockerAddressFor`; aquí no se construye nada,
 * solo se pinta lo que llega.
 */
import { useEffect, useState } from 'react';
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
          <div className="banner" style={{ marginBottom: 16 }}>
            Incluye <strong>siempre</strong> el identificador del casillero en el nombre y en la
            línea de suite. Sin él no podemos saber que el paquete es tuyo.
          </div>

          {/*
            Sin sub-casillero la dirección lleva un identificador que nuestra
            bodega de Miami todavía no reconoce, así que el paquete puede llegar
            sin dueño. Es mejor decirlo que dejar que el cliente compre a ciegas.
          */}
          {!locker.subLocker && (
            <div className="banner warn" style={{ marginBottom: 16 }}>
              Tu casillero aún se está activando con nuestra bodega de Miami.
              Escríbenos antes de hacer tu primera compra para confirmar la dirección.
            </div>
          )}

          <div className="locker-card">
            <div className="locker-title">Dirección en Miami</div>
            <div className="cards" style={{ gap: 8 }}>
              {locker.lines.map((line) => (
                <div className="card-item-field" key={line.label}>
                  <span className="field-label">{line.label}</span>
                  <span className="locker-address" style={{ flex: 1 }}>{line.value}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => copy(line)}>
                    {copied === line.label ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
