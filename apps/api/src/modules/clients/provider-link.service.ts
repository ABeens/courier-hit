/**
 * Enlace de casilleros con el proveedor: consulta y correccion manual (docs/13).
 *
 * Por que existe: con la integracion encendida, el login de un cliente exige que
 * su casillero este `synced` (`auth.service.login`). Un rechazo de Helga lo deja
 * FUERA del portal, y hay rechazos que ningun reintento arregla (el caso tipico
 * es el duplicado, porque Helga exige nombre y cedula unicos en la cuenta), asi
 * que el robot ya no los reintenta. Cuando el duplicado es el mismo cliente, la
 * adopcion (`adoptExistingRecipient`) lo enlaza sola; el resto necesita esta
 * salida manual o el cliente queda encerrado para siempre.
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
  ProviderLinkAdoptResultDto,
  ProviderLinkDetailDto,
  ProviderLinkDto,
  ProviderLinkEventDto,
  ProviderLinkListDto,
  Session,
  UpdateProviderLinkInput,
} from '@courier/shared';
import { ProviderLinkErrors, ShipmentErrors } from '../../core/errors';
import { isHelgaEnabled, listHelgaRecipients } from '../../integrations/helga/helga.client';
import type { HelgaCallPriority } from '../../integrations/helga/helga.client';
import { providerLinkRepo } from './provider-link.repo';

type LinkRow = NonNullable<Awaited<ReturnType<typeof providerLinkRepo.findByClientId>>>;
type EventRow = Awaited<ReturnType<typeof providerLinkRepo.listEvents>>[number];

/** Codigo de Postgres para violacion de restriccion unica. */
const PG_UNIQUE_VIOLATION = '23505';

/** True si el error (o su causa, segun como lo envuelva Drizzle) es un 23505. */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: unknown }).code : undefined;
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? (err as { cause?: unknown }).cause : undefined;
  return codeOf(err) === PG_UNIQUE_VIOLATION || codeOf(cause) === PG_UNIQUE_VIOLATION;
}

/**
 * Cedula comparable: sin espacios, guiones ni puntos, en mayusculas. Helga y
 * nosotros no tienen por que escribirla igual ("1-1234-5678" vs "112345678"), y
 * la comparacion tiene que ser EXACTA sobre los caracteres que importan.
 */
function normalizeIdNumber(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/** Resultado de intentar adoptar un destinatario ya existente en Helga. */
export interface AdoptOutcome {
  adopted: boolean;
  message: string;
}

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

    // Ownership: un id o un sub-casillero que ya es de otro casillero no se mueve
    // desde aqui. Solo se miran los que cambian; los que ya tenia son suyos.
    const owner = await providerLinkRepo.findLinkOwner(clientId, {
      helgaClientId: changes.helgaClientId ? input.helgaClientId : null,
      subLocker: changes.subLocker ? input.subLocker : null,
    });
    if (owner) throw ProviderLinkErrors.linkInUse(owner.field, owner.code);

    try {
      await providerLinkRepo.updateLink(clientId, {
        helgaSyncStatus: input.status,
        helgaClientId: input.helgaClientId,
        helgaSubLocker: input.subLocker,
        ...(becameSynced ? { helgaSyncedAt: new Date(), helgaLastError: null } : {}),
      });
    } catch (err) {
      // La carrera: otro proceso lo tomo entre la comprobacion y la escritura.
      if (!isUniqueViolation(err)) throw err;
      throw ProviderLinkErrors.linkInUse(changes.helgaClientId ? 'helgaClientId' : 'subLocker', null);
    }

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

  /**
   * Busca en Helga (op. G) el destinatario que ya existe para este casillero y, si
   * es inequivocamente suyo, lo enlaza. Es la salida del rechazo "ya existe un
   * destinatario con ese nombre y/o cedula": el caso tipico es un alta que Helga
   * SI hizo pero cuya respuesta se perdio, y desde entonces cada reintento choca
   * con el mismo cliente.
   *
   * Solo adopta si se cumplen TODAS, y si no, no toca nada y lo deja explicado:
   *   1. la cedula coincide EXACTA (normalizada). El nombre nunca basta: un
   *      homonimo es otra persona;
   *   2. hay exactamente UN destinatario activo con esa cedula;
   *   3. trae sub-casillero (sin el, el cliente no sabe a donde comprar);
   *   4. ni su id ni su sub-casillero son ya de otro casillero nuestro. Esto es lo
   *      que protege el ownership: adoptarlo le desviaria los paquetes al dueño.
   * La escritura comprueba la 4 en la misma sentencia (`adoptRecipient`).
   *
   * Nunca lanza por el proveedor: la llaman el registro y el robot, que no deben
   * caerse por esto. Deja un evento en la bitacora en todos los casos.
   */
  async adoptExistingRecipient(
    clientId: string,
    opts: { source: ProviderLinkSource; actorId?: string | null; priority?: HelgaCallPriority },
  ): Promise<AdoptOutcome> {
    const current = await providerLinkRepo.findByClientId(clientId);
    if (!current) throw ShipmentErrors.clientNotFound();
    if (current.status === HelgaSyncStatus.Synced) {
      return { adopted: false, message: 'El casillero ya está enlazado.' };
    }
    // Apagado, este modulo no habla con Helga ni de verdad ni simulado.
    if (!isHelgaEnabled()) {
      return { adopted: false, message: 'La integración con el operador está apagada.' };
    }

    const outcome = await this.resolveAdoption(current, opts.priority);

    await providerLinkRepo.addEvent({
      clientId,
      source: opts.source,
      status: outcome.adopted ? HelgaSyncStatus.Synced : current.status,
      detail: outcome.message,
      changes: outcome.adopted
        ? {
            helgaClientId: { from: current.helgaClientId, to: outcome.helgaClientId },
            subLocker: { from: current.subLocker, to: outcome.subLocker },
          }
        : null,
      createdBy: opts.actorId ?? null,
    });

    return { adopted: outcome.adopted, message: outcome.message };
  },

  /** Las cuatro condiciones de `adoptExistingRecipient` y la escritura. */
  async resolveAdoption(
    current: LinkRow,
    priority: HelgaCallPriority | undefined,
  ): Promise<
    { adopted: true; message: string; helgaClientId: string; subLocker: string } | { adopted: false; message: string }
  > {
    const target = normalizeIdNumber(current.idNumber);
    if (!target) return { adopted: false, message: 'No se buscó en el operador: el casillero no tiene cédula.' };

    let found;
    try {
      found = await listHelgaRecipients({ search: current.idNumber, ...(priority ? { priority } : {}) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { adopted: false, message: `No se pudo consultar el operador: ${reason}` };
    }

    const sameId = found.filter((r) => r.active && normalizeIdNumber(r.idNumber) === target);
    if (sameId.length === 0) {
      return {
        adopted: false,
        message:
          'No se enlazó: el operador no tiene ningún destinatario activo con esta cédula. El rechazo sería por nombre (un homónimo) y hay que resolverlo a mano.',
      };
    }
    if (sameId.length > 1) {
      return {
        adopted: false,
        message: `No se enlazó: el operador tiene ${sameId.length} destinatarios con esta cédula (${sameId
          .map((r) => r.id)
          .join(', ')}). Hay que elegir a mano.`,
      };
    }

    const recipient = sameId[0]!;
    if (!recipient.subLocker) {
      return {
        adopted: false,
        message: `No se enlazó: el destinatario ${recipient.id} no tiene sub-casillero en el operador.`,
      };
    }

    const owner = await providerLinkRepo.findLinkOwner(current.clientId, {
      helgaClientId: recipient.id,
      subLocker: recipient.subLocker,
    });
    if (owner) {
      return {
        adopted: false,
        message: `No se enlazó: el destinatario ${recipient.id} (${recipient.subLocker}) ya pertenece al casillero ${owner.code}.`,
      };
    }

    let written: boolean;
    try {
      written = await providerLinkRepo.adoptRecipient(current.clientId, {
        helgaClientId: recipient.id,
        subLocker: recipient.subLocker,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      written = false;
    }
    if (!written) {
      return {
        adopted: false,
        message: `No se enlazó: el destinatario ${recipient.id} fue tomado por otro casillero al mismo tiempo, o este ya estaba enlazado.`,
      };
    }

    return {
      adopted: true,
      helgaClientId: recipient.id,
      subLocker: recipient.subLocker,
      message: `Enlazado con el destinatario que ya existía en el operador: ${recipient.id} (${recipient.subLocker}), misma cédula.`,
    };
  },

  /**
   * Disparo manual de la adopcion desde el panel (boton "Buscar en el operador").
   * No adoptar es una respuesta normal, no un error: el motivo vuelve al panel.
   */
  async adopt(session: Session, clientId: string): Promise<ProviderLinkAdoptResultDto> {
    const outcome = await this.adoptExistingRecipient(clientId, {
      source: ProviderLinkSource.Manual,
      actorId: session.userId,
    });
    return { ...outcome, detail: await this.get(clientId) };
  },
};
