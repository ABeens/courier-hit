/**
 * Raiz de la isla-app (Opción B). Al montar consulta GET /api/auth/me para
 * hidratar la sesion (docs/04 §6). Sin sesion => Login; con sesion => el Shell
 * con el menu segun rol. Toda autorizacion real la revalida la API.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Principal, Role } from '@courier/shared';
import { api } from './lib/api';
import { clearDismissedAnnouncements } from './lib/announcements';
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

  /**
   * Los avisos descartados se olvidan en cada apertura y cierre de sesion, no al
   * recargar (§3.4.4: "vuelve a mostrarse en el siguiente inicio de sesión"). Por
   * eso se limpian aqui, en las transiciones de sesion, y no en el montaje del
   * componente — que tambien ocurre al recargar la pagina.
   */
  const handleLoggedIn = useCallback(() => {
    clearDismissedAnnouncements();
    return refresh();
  }, [refresh]);

  function handleLoggedOut() {
    clearDismissedAnnouncements();
    setMe(null);
  }

  if (loading) return <div className="portal-splash">Cargando…</div>;
  if (!me) return <LoginScreen onLoggedIn={handleLoggedIn} />;
  return <PortalShell me={me} onLoggedOut={handleLoggedOut} />;
}
