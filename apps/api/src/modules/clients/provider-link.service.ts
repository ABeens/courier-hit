/**
 * Enlace de casilleros con el proveedor: consulta y correccion manual (docs/13).
 *
 * Por que existe: con la integracion encendida, el login de un cliente exige que
 * su casillero este `synced` (`auth.service.login`). Un rechazo de Helga lo deja
 * FUERA del portal, y el robot reintenta lo mismo cada hora sin que nadie vea el
 * motivo. Hay rechazos que ningun reintento arregla —el caso tipico es el nombre
 * duplicado, porque Helga exige nombre unico dentro de la cuenta— asi que sin una
 * salida manual ese cliente queda encerrado para siempre.
 *
 * Solo Admin (`Permission.ConfigManage`, el mismo permiso del disparo manual de la
 * sincronizacion): tocar el enlace a mano puede abrirle el portal a un cliente que
 * el proveedor no reconoce, y esa decision no es de la operacion diaria.
 *
 * Toda correccion queda en `client_provider_link_events` con su autor y su motivo.
 */
import { HelgaSyncStatus, ProviderLinkSource, paged } from '@courier/shared';
import type {
  ListProviderLinksQuery,
  ProviderLinkDetailDto,
  ProviderLinkDto,
  ProviderLinkEventDto,
  ProviderLinkListDto,
  Session,
  UpdateProviderLinkInput,
} from '@courier/shared';
import { ProviderLinkErrors, ShipmentErrors } from '../../core/errors';
import { isHelgaEnabled } from '../../integrations/helga/helga.client';
import { providerLinkRepo } from './provider-link.repo';

type LinkRow = NonNullable<Awaited<ReturnType<typeof providerLinkRepo.findByClientId>>>;
type EventRow = Awaited<ReturnType<typeof providerLinkRepo.listEvents>>[number];

/**
 * Fila -> DTO. `blocksLogin` se calcula aqui y no en la web porque depende de si
 * la integracion esta encendida: con Helga apagado un casillero 'pending' es
 * normal y no bloquea a nadie, con Helga encendido es un cliente sin acceso.
 */
function toDto(row: LinkRow): ProviderLinkDto {
  return {
    clientId: row.clientId,
    clientCode: row.clientCode,
    name: row.name,
    email: row.email,
    idNumber: row.idNumber,
    status: row.status,
    helgaClientId: row.helgaClientId,
    subLocker: row.subLocker,
    attempts: row.attempts,
    lastError: row.lastError,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    blocksLogin: isHelgaEnabled() && row.status !== HelgaSyncStatus.Synced,
  };
}

function toEventDto(row: EventRow): ProviderLinkEventDto {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    detail: row.detail,
    changes: row.changes,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Diff de la correccion, en el formato de la bitacora. Solo entran los campos
 * que de verdad cambiaron: registrar un campo que se reenvio igual haria pensar
 * que alguien lo toco.
 */
function diffOf(
  current: LinkRow,
  input: UpdateProviderLinkInput,
): Record<string, { from: string | null; to: string | null }> {
  const changes: Record<string, { from: string | null; to: string | null }> = {};

  if (input.status !== undefined && input.status !== current.status) {
    changes.status = { from: current.status, to: input.status };
  }
  if (input.helgaClientId !== undefined && (input.helgaClientId ?? null) !== current.helgaClientId) {
    changes.helgaClientId = { from: current.helgaClientId, to: input.helgaClientId ?? null };
  }
  if (input.subLocker !== undefined && (input.subLocker ?? null) !== current.subLocker) {
    changes.subLocker = { from: current.subLocker, to: input.subLocker ?? null };
  }
  return changes;
}

export const providerLinkService = {
  /**
   * Una pagina de casilleros con problema de enlace (o filtrados por
   * estado/busqueda), mas cuantos de todo el filtro estan bloqueando un login.
   *
   * `blockedCount` se pregunta a la BD solo con la integracion encendida: con
   * Helga apagado, un casillero sin enlazar es normal y no deja a nadie fuera, asi
   * que el conteo seria una consulta para devolver siempre cero. Es el mismo
   * criterio con el que `toDto` calcula `blocksLogin` fila a fila.
   */
  async list(query: ListProviderLinksQuery): Promise<ProviderLinkListDto> {
    const [rows, total, blockedCount] = await Promise.all([
      providerLinkRepo.list(query),
      providerLinkRepo.countList(query),
      isHelgaEnabled() ? providerLinkRepo.countUnsynced(query) : Promise.resolve(0),
    ]);
    return { ...paged(rows.map(toDto), total, query), blockedCount };
  },

  /** Un enlace con su bitacora completa: es la pantalla de diagnostico. */
  async get(clientId: string): Promise<ProviderLinkDetailDto> {
    const row = await providerLinkRepo.findByClientId(clientId);
    if (!row) throw ShipmentErrors.clientNotFound();

    const events = await providerLinkRepo.listEvents(clientId);
    return { link: toDto(row), events: events.map(toEventDto) };
  },

  /**
   * Correccion manual del enlace.
   *
   * Al marcar `synced` se sella `helgaSyncedAt` y se limpia `helgaLastError`: si
   * el error viejo sobreviviera, el panel seguiria mostrando como motivo de fallo
   * algo que ya se resolvio. Se conserva en la bitacora, que es donde pertenece.
   *
   * NO se llama al proveedor. Es deliberado: este camino existe justo para cuando
   * el proveedor no coopera, y el alta automatica sigue disponible en el robot.
   * Quien corrige a mano ya resolvio el enlace del otro lado (creo el destinatario
   * en la interfaz de Helga) y aqui solo lo esta reflejando.
   */
  async update(
    session: Session,
    clientId: string,
    input: UpdateProviderLinkInput,
  ): Promise<ProviderLinkDetailDto> {
    const current = await providerLinkRepo.findByClientId(clientId);
    if (!current) throw ShipmentErrors.clientNotFound();

    const changes = diffOf(current, input);
    if (Object.keys(changes).length === 0) throw ProviderLinkErrors.unchanged();

    const nextStatus = input.status ?? current.status;
    const becameSynced = nextStatus === HelgaSyncStatus.Synced;

    // Coherencia: 'synced' sin destinatario dejaria entrar al portal a un cliente
    // cuyos paquetes el proveedor no puede atribuir. El esquema ya rechaza mandar
    // `null` explicito junto con 'synced'; esto cubre el caso de no mandarlo y que
    // el casillero tampoco lo tenga.
    const nextHelgaClientId =
      input.helgaClientId === undefined ? current.helgaClientId : input.helgaClientId;
    if (becameSynced && !nextHelgaClientId) throw ProviderLinkErrors.needsHelgaId();

    await providerLinkRepo.updateLink(clientId, {
      helgaSyncStatus: input.status,
      helgaClientId: input.helgaClientId,
      helgaSubLocker: input.subLocker,
      ...(becameSynced ? { helgaSyncedAt: new Date(), helgaLastError: null } : {}),
    });

    await providerLinkRepo.addEvent({
      clientId,
      source: ProviderLinkSource.Manual,
      status: nextStatus,
      detail: input.note,
      changes,
      createdBy: session.userId,
    });

    return this.get(clientId);
  },
};
