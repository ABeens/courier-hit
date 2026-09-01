/**
 * Pantalla "Cuentas de Miami" (permiso provider_accounts.manage, solo Admin).
 *
 * Es el mantenimiento de las cuentas EXCLUSIVAS del operador: las cuentas
 * dedicadas que el operador le crea a un cliente consolidado, y que aquí se
 * conectan con la plataforma. La cuenta principal de HS Global aparece primero,
 * de solo lectura, porque vive en la configuración del despliegue: sale en la
 * lista para responder "¿contra qué cuentas trabaja el sistema?", no para
 * editarla desde aquí.
 *
 * El orden de la pantalla es el del trabajo real: primero se registran las
 * credenciales de la cuenta (que el operador entrega), y solo después se da de
 * alta a su cliente. Por eso una cuenta recién creada se ve incompleta y lo dice:
 * sin cliente no se le puede atribuir ni un paquete, así que el robot la salta.
 */
import { useCallback, useEffect, useState } from 'react';
import { PROVIDER_ACCOUNT_KIND_LABELS, ProviderAccountKind } from '@courier/shared';
import type { ProviderAccountDto, ProviderAccountListDto } from '@courier/shared';
import { ApiError, api } from '../lib/api';
import { IconButton } from '../components/IconButton';
import { ConsolidatedClientModal } from './ConsolidatedClientModal';
import { ProviderAccountFormModal } from './ProviderAccountFormModal';

type ModalState =
  | { mode: 'create' }
  | { mode: 'edit'; row: ProviderAccountDto }
  | { mode: 'client'; row: ProviderAccountDto }
  | null;

/** Fecha en hora local del usuario; en UTC se guarda, aquí solo se muestra. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-CR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Estado de la última importación, en una línea.
 *
 * Es lo primero que se mira cuando un cliente consolidado dice que no le llegan
 * sus paquetes, así que un error se muestra entero y no recortado: casi siempre
 * es la contraseña caducada o la IP fuera de la lista blanca del operador, y las
 * dos se leen en el mensaje del operador.
 */
function ImportState({ row }: { row: ProviderAccountDto }) {
  if (row.kind === ProviderAccountKind.Principal) {
    return <span className="empty-val">Se importa en cada corrida</span>;
  }
  if (row.lastImportError) {
    return (
      <span className="spill danger">
        <span className="dot" />
        {row.lastImportError}
      </span>
    );
  }
  if (!row.lastImportAt) return <span className="empty-val">Todavía no ha corrido</span>;
  return <>{formatDate(row.lastImportAt)}</>;
}

export function ProviderAccountsScreen() {
  const [data, setData] = useState<ProviderAccountListDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ProviderAccountListDto>('/provider-accounts'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar el listado.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(row: ProviderAccountDto) {
    if (!row.id) return;
    setError(null);
    setNotice(null);
    try {
      await api.patch(`/provider-accounts/${row.id}`, { active: !row.active });
      setNotice(`${row.code}: cuenta ${row.active ? 'desactivada' : 'activada'}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cambiar el estado.');
    }
  }

  const exclusivas = data?.items.filter((i) => i.kind === ProviderAccountKind.Exclusiva) ?? [];
  const sinCliente = exclusivas.filter((i) => !i.client).length;

  return (
    <div className="fadeIn">
      <div className="head-row">
        <div>
          <div className="title">Cuentas del operador de Miami</div>
          {data && (
            <div className="count">
              {exclusivas.length} cuenta{exclusivas.length === 1 ? '' : 's'} exclusiva
              {exclusivas.length === 1 ? '' : 's'}
              {sinCliente > 0 && ` · ${sinCliente} sin cliente asignado`}
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ mode: 'create' })}>
          + Nueva cuenta
        </button>
      </div>

      {error && <div className="banner err" style={{ marginBottom: 14 }}>{error}</div>}
      {notice && <div className="banner ok" style={{ marginBottom: 14 }}>{notice}</div>}

      <div className="banner" style={{ marginBottom: 14 }}>
        Una cuenta exclusiva importa <strong>toda</strong> su paquetería a un único cliente
        consolidado, vengan sus paquetes de uno o de varios sub-casilleros. Los clientes que se
        registran desde el sitio público quedan siempre en la cuenta principal, y un cliente que ya
        existe no se puede pasar a una cuenta exclusiva.
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Casillero</th>
              <th>A nombre de</th>
              <th>Tipo</th>
              <th>Usuario</th>
              <th>Cliente consolidado</th>
              <th>Última importación</th>
              <th>Estado</th>
              <th style={{ textAlign: 'right' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id ?? `principal-${row.code}`}>
                <td>
                  <div className="cell-name mono">{row.code}</div>
                </td>
                <td>{row.name}</td>
                <td>{PROVIDER_ACCOUNT_KIND_LABELS[row.kind]}</td>
                <td className="mono">{row.username}</td>
                <td>
                  {row.kind === ProviderAccountKind.Principal ? (
                    <span className="empty-val">Reparte entre todos los clientes</span>
                  ) : row.client ? (
                    <>
                      <div className="cell-name">{row.client.name}</div>
                      <div className="cell-sub mono">{row.client.code}</div>
                    </>
                  ) : (
                    <span className="spill warn">
                      <span className="dot" />
                      Sin cliente: no se importa
                    </span>
                  )}
                </td>
                <td>
                  <ImportState row={row} />
                </td>
                <td>
                  <span className={`spill ${row.active ? 'ok' : 'off'}`}>
                    <span className="dot" />
                    {row.active ? 'Activa' : 'Inactiva'}
                  </span>
                </td>
                <td>
                  <div className="actions">
                    {/* La principal no se administra desde aquí: vive en el .env. */}
                    {row.kind === ProviderAccountKind.Exclusiva && (
                      <>
                        <IconButton
                          label="Editar cuenta"
                          icon="edit"
                          onClick={() => setModal({ mode: 'edit', row })}
                        />
                        {!row.client && (
                          <IconButton
                            label="Crear el cliente consolidado"
                            icon="userPlus"
                            onClick={() => setModal({ mode: 'client', row })}
                          />
                        )}
                        {row.active ? (
                          <IconButton
                            label="Desactivar cuenta"
                            icon="ban"
                            onClick={() => toggleActive(row)}
                          />
                        ) : (
                          <IconButton
                            label="Activar cuenta"
                            icon="checkCircle"
                            onClick={() => toggleActive(row)}
                          />
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && exclusivas.length === 0 && (
        <div className="empty">
          Todavía no hay cuentas exclusivas. Regístralas cuando el operador de Miami cree una cuenta
          dedicada para un cliente.
        </div>
      )}

      {modal?.mode === 'client' ? (
        <ConsolidatedClientModal
          account={modal.row}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      ) : modal ? (
        <ProviderAccountFormModal
          mode={modal.mode}
          row={modal.mode === 'edit' ? modal.row : undefined}
          onClose={() => setModal(null)}
          onSaved={(message) => {
            setModal(null);
            setNotice(message);
            setError(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
