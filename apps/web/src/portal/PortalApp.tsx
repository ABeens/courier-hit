/**
 * Raiz de la isla-app (Opción B). Al montar consulta GET /api/auth/me para
 * hidratar la sesion (docs/04 §6). Sin sesion => Login; con sesion => el Shell
 * con el menu segun rol. Toda autorizacion real la revalida la API.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Principal, Role } from '@courier/shared';
import { api } from './lib/api';
import { LoginScreen } from './screens/LoginScreen';
import { PortalShell } from './PortalShell';
import './portal.css';

export interface Me {
  userId: string;
  principal: Principal;
  role: Role;
  clientCode?: string;
}

export default function PortalApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <div className="portal-splash">Cargando…</div>;
  if (!me) return <LoginScreen onLoggedIn={refresh} />;
  return <PortalShell me={me} onLoggedOut={() => setMe(null)} />;
}
