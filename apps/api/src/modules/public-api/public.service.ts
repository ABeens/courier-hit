/**
 * API publica: la capa que traduce entre el sistema y el contrato de fuera
 * (docs/16 §4).
 *
 * NO hay logica de negocio aqui, y no puede haberla. Prealertar por la API tiene
 * que ser exactamente el mismo acto que prealertar desde el portal —mismo
 * consecutivo, mismo aviso a la bodega de Miami, mismas validaciones—, asi que
 * esto llama al servicio de tramites de siempre. Lo unico propio de este modulo
 * es el MAPEO: recortar el DTO interno al contrato publico y acotar todo al
 * casillero de la llave.
 *
 * Si algun dia una regla vive solo aqui, es un error: significaria que la API
 * publica y el portal pueden divergir.
 */
import { Principal, Role, STATE_LABELS, ShipmentType, lockerAddressFor } from '@courier/shared';
import type {
  ListShipmentsQuery,
  PublicClient,
  PublicLocker,
  PublicPackage,
  PublicPackagesQuery,
  PublicPage,
  PublicPrealertInput,
  Session,
  ShipmentDto,
  State,
} from '@courier/shared';
import { PublicApiErrors, ShipmentErrors } from '../../core/errors';
import type { ApiClient } from '../../core/http';
import { clientsRepo } from '../clients/clients.repo';
import { shipmentsRepo } from '../shipments/shipments.repo';
import { shipmentsService, toDto } from '../shipments/shipments.service';

/**
 * DTO interno -> contrato publico. Es una lista EXPLICITA de campos y no un
 * `omit` de los que sobran: con un `omit`, un campo nuevo del DTO interno se
 * publicaria solo, y lo que se publica ya no se puede retirar sin romperle la
 * integracion a alguien. Aqui, lo que no se nombra no sale.
 */
function toPublicPackage(shipment: ShipmentDto): PublicPackage {
  return {
    code: shipment.code,
    tracking: shipment.tracking,
    description: shipment.description,
    state: shipment.state,
    stateLabel: STATE_LABELS[shipment.state],
    store: shipment.store,
    carrier: shipment.carrier,
    hawb: shipment.hawb,
    weightKg: shipment.weightKg,
    declaredValueUsd: shipment.declaredValueUsd,
    invoiceTotalCrc: shipment.invoiceTotalCrc,
    invoiceTotalUsd: shipment.invoiceTotalUsd,
    pendingCrc: shipment.pendingCrc,
    settled: shipment.settled,
    createdAt: shipment.createdAt,
    updatedAt: shipment.updatedAt,
  };
}

/**
 * Sesion equivalente a la llave, para poder llamar a los servicios de siempre.
 *
 * No es un atajo para saltarse permisos: la llave YA identifica al titular del
 * casillero (`requireApiKey`), y el rol que se le pone es exactamente el que ese
 * usuario tiene en el portal. Lo que se evita es duplicar la logica de prealerta
 * en una version "para la API" que acabaria divergiendo.
 */
function sessionFor(apiClient: ApiClient, userId: string): Session {
  return {
    // La llave no abre una sesion de portal: no hay cookie ni fila en `sessions`.
    // El identificador deja rastro de por donde entro en los eventos del tramite.
    sessionId: `api-key:${apiClient.keyId}`,
    userId,
    principal: Principal.Client,
    role: Role.Client,
    clientId: apiClient.clientId,
    clientCode: apiClient.clientCode,
  };
}

/**
 * Los filtros publicos traducidos al listado interno.
 *
 * Los tres campos que NO se dejan tocar desde fuera son los que definen el
 * alcance: `clientId` (lo pone la llave), `owner` y `discarded`. Un paquete
 * descartado es un error de la operacion archivado en la sala de control; no es
 * asunto del cliente ni tiene sentido para el.
 */
function toInternalQuery(query: PublicPackagesQuery): ListShipmentsQuery {
  return {
    state: query.state as State | undefined,
    from: query.from,
    to: query.to,
    discarded: false,
    page: query.page,
    pageSize: query.pageSize,
  } as ListShipmentsQuery;
}

export const publicApiService = {
  /**
   * Comprueba que el `clientCode` de la consulta, si viene, es el de la llave.
   * Ver `PublicApiErrors.clientMismatch` para el porque de un 403 y no una lista
   * vacia.
   */
  assertOwnClient(apiClient: ApiClient, clientCode?: string): void {
    if (clientCode && clientCode !== apiClient.clientCode) throw PublicApiErrors.clientMismatch();
  },

  /** La cuenta detras de la llave. */
  async client(apiClient: ApiClient): Promise<PublicClient> {
    const row = await clientsRepo.findById(apiClient.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();
    return {
      clientCode: row.code,
      name: row.name,
      email: row.email,
      memberSince: row.memberSince ?? null,
    };
  },

  /** Casillero en Miami. Misma direccion que enseña el portal, misma funcion. */
  async locker(apiClient: ApiClient): Promise<PublicLocker> {
    const row = await clientsRepo.findById(apiClient.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();
    return {
      clientCode: row.code,
      subLocker: row.helgaSubLocker,
      lines: lockerAddressFor(row.name, row.code),
    };
  },

  /**
   * Paquetes del casillero de la llave. El recorte por dueño va como parametro
   * del repositorio, no como filtro de la consulta publica: asi no hay forma de
   * que un filtro nuevo lo pise sin querer.
   */
  async packages(apiClient: ApiClient, query: PublicPackagesQuery): Promise<PublicPage<PublicPackage>> {
    this.assertOwnClient(apiClient, query.clientCode);

    const internal = toInternalQuery(query);
    const [rows, total] = await Promise.all([
      shipmentsRepo.list(internal, apiClient.clientId, query.tracking),
      shipmentsRepo.countList(internal, apiClient.clientId, query.tracking),
    ]);

    return {
      items: rows.map((row) => toPublicPackage(toDto(row))),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  /**
   * Un paquete por su guia. Devuelve el MAS RECIENTE si hay varios: el listado
   * ya viene ordenado por fecha descendente, asi que basta con pedir uno.
   *
   * 404 tanto si no existe como si es de otro casillero, porque el recorte por
   * dueño se aplica antes de mirar: desde fuera, un paquete ajeno y un paquete
   * inexistente son indistinguibles, que es lo que se quiere.
   */
  async packageByTracking(apiClient: ApiClient, tracking: string): Promise<PublicPackage> {
    const query = { discarded: false, page: 1, pageSize: 1 } as ListShipmentsQuery;
    const rows = await shipmentsRepo.list(query, apiClient.clientId, tracking.trim().toUpperCase());
    const row = rows[0];
    if (!row) throw PublicApiErrors.packageNotFound();
    return toPublicPackage(toDto(row));
  },

  /**
   * Prealerta. Delega en el servicio de tramites con el tipo Paqueteria fijado
   * aqui: por la API publica no se puede dar de alta otra cosa, igual que en el
   * portal (los tramites de transporte y agenciamiento los registra HS Global).
   */
  async prealert(apiClient: ApiClient, input: PublicPrealertInput): Promise<PublicPackage> {
    const row = await clientsRepo.findById(apiClient.clientId);
    if (!row) throw ShipmentErrors.missingClientProfile();

    const created = await shipmentsService.prealert(sessionFor(apiClient, row.userId), {
      shipmentType: ShipmentType.Paqueteria,
      tracking: input.tracking,
      description: input.description,
      store: input.store,
      carrier: input.carrier,
      declaredValueUsd: input.declaredValueUsd,
    });
    return toPublicPackage(created);
  },
};
