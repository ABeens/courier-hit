/**
 * Pantalla "API" del portal del cliente (docs/16 §3). Son dos pestañas: las
 * llaves del casillero y la guia de uso (`ApiDocsPanel`), que es lo que se busca
 * el primer dia. Van en la misma pantalla porque son los dos lados del mismo
 * acto (emitir la credencial y saber que hacer con ella), y la pestaña activa se
 * refleja en la URL para que un enlace a la documentacion abra la documentacion.
 *
 * La de llaves es una pestaña de CREDENCIALES, y eso manda sobre el diseño en
 * tres puntos:
 *
 *   1. El token se enseña UNA vez, al crearlo o al rotarlo, en un panel que no
 *      se puede volver a abrir. No es una limitación técnica que haya que
 *      disculpar: es la propiedad que hace que una llave filtrada se pueda dar
 *      por perdida con certeza. El aviso lo dice con esas palabras.
 *   2. Rotar y revocar piden confirmación con el nombre de la llave delante,
 *      porque las dos cortan una integración en producción y no se deshacen.
 *   3. La columna que de verdad se mira es "Último uso": es lo que responde
 *      "¿esta llave la sigue usando alguien?", que es la pregunta previa a
 *      revocar una que sobra.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiKeyCreatedDto, ApiKeyDto, ApiKeyListDto } from '@courier/shared';
import { ApiKeyRevokeReason } from '@courier/shared';
import { IconButton } from '../components/IconButton';
import { ModalOverlay } from '../components/ModalOverlay';
import { ApiError, api } from '../lib/api';
import { formatDateTime } from '../lib/datetime';
import { ApiDocsPanel } from './ApiDocsPanel';

/** Qué está a punto de hacer el modal de confirmación. */
type Pending = { action: 'rotate' | 'revoke'; row: ApiKeyDto } | null;

/** Las dos pestañas. El valor viaja en la URL, asi que es parte del contrato. */
type Tab = 'llaves' | 'documentacion';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'llaves', label: 'Llaves' },
  { id: 'documentacion', label: 'Documentación' },
];

/** `?tab=` de la URL actual, si nombra una pestaña que existe. */
function tabFromUrl(): Tab {
  if (typeof window === 'undefined') return 'llaves';
  const value = new URLSearchParams(window.location.search).get('tab');
  return TABS.some((t) => t.id === value) ? (value as Tab) : 'llaves';
}

export function ApiKeysScreen() {
  const [data, setData] = useState<ApiKeyListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  /** El token recién emitido. Vive solo en memoria y solo hasta que se cierre. */
  const [issued, setIssued] = useState<ApiKeyCreatedDto | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromUrl);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ApiKeyListDto>('/api-keys'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudieron cargar tus llaves.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copyToken() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Tu navegador no permitió copiar. Selecciona la llave y cópiala a mano.');
    }
  }

  const atLimit = data !== null && data.activeCount >= data.maxActive;

  /**
   * Cambiar de pestaña reescribe la URL en vez de apilar una entrada nueva: el
   * boton de atras del navegador tiene que sacar del modulo, no pasearse por las
   * pestañas que se miraron por el camino. Aun asi la URL queda compartible y
   * sobrevive a un F5.
   */
  function selectTab(next: Tab) {
    setTab(next);
    const query = next === 'llaves' ? '' : `?tab=${next}`;
    window.history.replaceState(null, '', `${window.location.pathname}${query}`);
  }

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">API</div>
          {tab === 'documentacion' ? (
            <div className="count">Guía de integración: URL base, autenticación y operaciones</div>
          ) : (
            data && (
              <div className="count">
                {data.activeCount} de {data.maxActive} llaves activas
              </div>
            )
          )}
        </div>
        {/* El boton solo acompaña a su pestaña: en la documentacion no hay nada
            que crear, y dejarlo ahi invita a emitir una llave antes de saber si
            la API hace lo que hace falta. */}
        {tab === 'llaves' && (
          <button
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            disabled={atLimit}
            title={atLimit ? 'Revoca una llave que no uses antes de crear otra.' : undefined}
          >
            + Crear llave
          </button>
        )}
      </div>

      <div className="tabs" role="tablist" aria-label="Secciones de API">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => selectTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'documentacion' && <ApiDocsPanel />}

      {tab === 'llaves' && (
        <>
          {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="banner info" style={{ marginBottom: 16 }}>
            Con una llave, tu sistema puede consultar tu casillero, tus paquetes y registrar prealertas
            sin que nadie tenga que entrar aquí. Trátala como una contraseña: va en el servidor, nunca
            en una página web ni en un repositorio.{' '}
            <button type="button" className="btn btn-link" onClick={() => selectTab('documentacion')}>
              Ver cómo se usa
            </button>
            .
          </div>

          {/*
            El token recién emitido. Va arriba del listado y no dentro de un modal
            que se cierra al hacer clic fuera: perder esta pantalla por un clic
            distraído significa rotar la llave otra vez.
          */}
          {issued && (
            <section className="card" style={{ marginBottom: 16, padding: 16 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15.5, marginBottom: 4 }}>
                Tu llave «{issued.name}»
              </div>
              <div className="banner warn" style={{ marginBottom: 12 }}>
                Cópiala ahora. Esta es la única vez que se muestra: no la guardamos en ningún sitio y
                no podemos volver a enseñártela. Si la pierdes, rota la llave y usa la nueva.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code
                  style={{
                    flex: '1 1 320px',
                    fontFamily: 'var(--font-mono, monospace)',
                    fontSize: 13,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'var(--surface-2, #f4f5f7)',
                    wordBreak: 'break-all',
                  }}
                >
                  {issued.token}
                </code>
                <button className="btn" onClick={copyToken}>
                  {copied ? 'Copiada' : 'Copiar'}
                </button>
                <button className="btn btn-ghost" onClick={() => setIssued(null)}>
                  Ya la guardé
                </button>
              </div>
            </section>
          )}

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Llave</th>
                  <th>Último uso</th>
                  <th>Estado</th>
                  <th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="cell-name">{row.name}</div>
                      <div className="cell-sub">Creada el {formatDateTime(row.createdAt)}</div>
                    </td>
                    <td>
                      <code style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5 }}>
                        {row.preview}
                      </code>
                    </td>
                    <td>
                      {row.lastUsedAt ? (
                        formatDateTime(row.lastUsedAt)
                      ) : (
                        <span className="cell-sub">Nunca se ha usado</span>
                      )}
                    </td>
                    <td>
                      <span className={`spill ${row.active ? 'ok' : 'off'}`}>
                        <span className="dot" />
                        {row.active
                          ? 'Activa'
                          : row.revokedReason === ApiKeyRevokeReason.Rotated
                            ? 'Reemplazada'
                            : 'Revocada'}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        {row.active && (
                          <>
                            <IconButton
                              label="Rotar llave"
                              icon="refresh"
                              hint="Genera una llave nueva y desactiva esta."
                              onClick={() => setPending({ action: 'rotate', row })}
                            />
                            <IconButton
                              label="Revocar llave"
                              icon="ban"
                              hint="Deja de funcionar de inmediato."
                              onClick={() => setPending({ action: 'revoke', row })}
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data && data.items.length === 0 && (
            <div className="empty">Todavía no has creado ninguna llave.</div>
          )}
        </>
      )}

      {creating && (
        <CreateKeyModal
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setIssued(key);
            void load();
          }}
        />
      )}

      {pending && (
        <ConfirmKeyModal
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(key) => {
            setPending(null);
            if (key) setIssued(key);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Alta: lo único que se pide es el nombre. El resto lo genera el servidor. */
function CreateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: ApiKeyCreatedDto) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.post<ApiKeyCreatedDto>('/api-keys', { name: name.trim() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la llave.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <form className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h3>Nueva llave de API</h3>
          <p>
            Ponle el nombre del sistema que la va a usar. Es lo que te permitirá saber cuál revocar
            el día que haga falta.
          </p>
        </div>

        <div className="modal-body">
          {error && <div className="banner err">{error}</div>}
          <div>
            <label className="field-label" htmlFor="k-name">Nombre</label>
            <input
              id="k-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mi ERP, tienda en línea, pruebas…"
              maxLength={60}
              autoFocus
            />
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || name.trim().length < 2}>
            {busy ? 'Creando…' : 'Crear llave'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}

/**
 * Confirmación de rotar o revocar. Las dos cortan lo que haya integrado, asi que
 * el texto dice exactamente qué deja de funcionar y cuándo.
 */
function ConfirmKeyModal({
  pending,
  onClose,
  onDone,
}: {
  pending: NonNullable<Pending>;
  onClose: () => void;
  onDone: (key: ApiKeyCreatedDto | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRotate = pending.action === 'rotate';

  async function run() {
    setBusy(true);
    setError(null);
    try {
      if (isRotate) {
        onDone(await api.post<ApiKeyCreatedDto>(`/api-keys/${pending.row.id}/rotate`, {}));
      } else {
        await api.del(`/api-keys/${pending.row.id}`);
        onDone(null);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo completar la operación.');
      setBusy(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="modal fadeUp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{isRotate ? 'Rotar la llave' : 'Revocar la llave'}</h3>
          <p>
            {isRotate
              ? `Se generará una llave nueva y «${pending.row.name}» dejará de funcionar. Actualiza tu sistema con la llave nueva en cuanto la copies.`
              : `«${pending.row.name}» dejará de funcionar de inmediato y no se puede recuperar. Lo que la esté usando empezará a recibir errores.`}
          </p>
        </div>

        <div className="modal-body">{error && <div className="banner err">{error}</div>}</div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
            {busy ? 'Aplicando…' : isRotate ? 'Rotar llave' : 'Revocar llave'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
