/**
 * Reglas de negocio de los tramites.
 *
 * Tres decisiones que viven aqui y en ningun otro lado:
 *
 * 1. ESTADO INICIAL. Nunca llega del cliente: sale de `initialState(flow)` de la
 *    maquina compartida. Alta y prealerta arrancan igual (Prealertado).
 * 2. PERMISO SEGUN TIPO. El RBAC separa Paqueteria (package.write) de Transporte
 *    y Agenciamiento (tramite.manage), asi que el permiso del alta depende del
 *    tipo que viene en el cuerpo: no se puede resolver con un middleware fijo.
 * 3. ALCANCE. Con un permiso de scope Own (el rol client) la consulta se acota al
 *    casillero de la SESION, nunca a un clientId del query string.
 */
import {
  HelgaSyncStatus,
  Permission,
  Role,
  STATE_LABELS,
  ShipmentField,
  can,
  editableFieldsAt,
  flowForType,
  initialState,
  roundWeightKg,
  usesPackageFields,
} from '@courier/shared';
import type {
  CreateShipmentInput,
  ListShipmentsQuery,
  PrealertShipmentInput,
  Session,
  ShipmentDto,
  ShipmentType,
  UpdateShipmentInput,
} from '@courier/shared';
import { AuthErrors, ShipmentErrors } from '../../core/errors';
import { formatShipmentCode } from '@courier/shared';
import { createHelgaPrealert, isHelgaEnabled } from '../../integrations/helga/helga.client';
import { clientsRepo } from '../clients/clients.repo';
import { shipmentsRepo } from './shipments.repo';

/** Fila de la vista de lectura del repo (tramite + cliente + ruta). */
type ShipmentRowView = Awaited<ReturnType<typeof shipmentsRepo.findById>>;

/** Resumen de una corrida de reconciliacion de prealertas (para el log del robot). */
interface PrealertReconcileReport {
  checked: number;
  synced: number;
  failed: number;
}

/**
 * Cuantas prealertas reenvia el robot por corrida. Acota el trabajo (y las
 * llamadas al proveedor) de cada pasada; el resto se drena en las siguientes.
 */
const PREALERT_RECONCILE_BATCH = 50;

/**
 * Permiso necesario para dar de alta o editar un tramite de ese tipo. Paqueteria
 * la maneja bodega (package.write); Transporte y Agenciamiento son manuales y los
 * lleva quien gestiona tramites (tramite.manage).
 */
function writePermissionFor(type: ShipmentType): Permission {
  return usesPackageFields(type) ? Permission.PackageWrite : Permission.TramiteManage;
}

/** 403 si el rol de la sesion no puede escribir tramites de ese tipo. */
function assertCanWrite(session: Session, type: ShipmentType): void {
  if (!can(session.role, writePermissionFor(type))) throw AuthErrors.forbidden();
}

/**
 * Casillero al que se acota la consulta, o `undefined` si el rol ve todo.
 * El rol client tiene package.read.own: solo sus propios tramites.
 */
function ownerScopeFor(session: Session): string | undefined {
  if (session.role !== Role.Client) return undefined;
  if (!session.clientId) throw ShipmentErrors.missingClientProfile();
  return session.clientId;
}

/**
 * Fila de BD -> DTO de la API. Deriva el flow y normaliza fechas a ISO (UTC).
 * Exportado porque los modulos que mueven tramites (transiciones, recepcion,
 * entregas) devuelven el tramite actualizado y deben serializarlo IGUAL que el
 * listado: dos mapeos distintos del mismo tramite serian dos contratos.
 */
export function toDto(row: NonNullable<ShipmentRowView>): ShipmentDto {
  return {
    id: row.id,
    code: row.code,
    shipmentType: row.shipmentType,
    flow: flowForType(row.shipmentType),
    state: row.state,
    client: { id: row.clientId, code: row.clientCode, name: row.clientName },
    tracking: row.tracking,
    description: row.description,
    store: row.store,
    carrier: row.carrier,
    hawb: row.hawb,
    weightKg: row.weightKg,
    warehouse: row.warehouse,
    dua: row.dua,
    billingNotes: row.billingNotes,
    routeNumber: row.routeNumber,
    invoiceTotalUsd: row.invoiceTotalUsd,
    invoiceTotalCrc: row.invoiceTotalCrc,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Un tracking activo no se puede repetir (mismo criterio que el indice parcial). */
async function assertTrackingFree(tracking: string): Promise<void> {
  const clash = await shipmentsRepo.findActiveByTracking(tracking);
  if (clash) throw ShipmentErrors.trackingInUse(clash.code);
}

export const shipmentsService = {
  /** Listado del dashboard, acotado al casillero propio cuando el rol es client. */
  async list(session: Session, query: ListShipmentsQuery): Promise<{ items: ShipmentDto[] }> {
    const rows = await shipmentsRepo.list(query, ownerScopeFor(session));
    return { items: rows.map(toDto) };
  },

  /** Detalle. Un cliente solo puede abrir los suyos (404, no 403: no revela existencia). */
  async get(session: Session, id: string): Promise<ShipmentDto> {
    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();

    const owner = ownerScopeFor(session);
    if (owner && row.clientId !== owner) throw ShipmentErrors.notFound();
    return toDto(row);
  },

  /** Historial de estados de un tramite (mismas reglas de acceso que el detalle). */
  async events(session: Session, id: string) {
    await this.get(session, id); // valida existencia y propiedad
    const rows = await shipmentsRepo.listEvents(id);
    return {
      items: rows.map((e) => ({
        id: e.id,
        state: e.state,
        note: e.note,
        createdByName: e.createdByName,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },

  /**
   * Prealerta del titular del casillero. El dueño es SIEMPRE el de la sesion: no
   * se acepta clientId en el cuerpo, asi un cliente no puede prealertar a nombre
   * de otro.
   *
   * En Paqueteria la prealerta se replica ante el proveedor: es lo que lo
   * autoriza a reportarnos el estado del paquete mientras esta en USA. Ese paso
   * NO bloquea —a diferencia del registro del casillero— porque el tramite ya es
   * util de nuestro lado aunque el proveedor no responda; la sincronizacion lo
   * recuperara despues por tracking.
   */
  async prealert(session: Session, input: PrealertShipmentInput): Promise<ShipmentDto> {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();

    const created = await this.insert(
      {
        clientId: session.clientId,
        shipmentType: input.shipmentType,
        tracking: input.tracking,
        description: input.description,
        store: input.store ?? null,
        carrier: input.carrier ?? null,
      },
      session.userId,
    );

    if (usesPackageFields(input.shipmentType)) {
      await this.prealertWithProvider(session.clientId, created);
    }
    return created;
  },

  /**
   * Replica la prealerta ante el proveedor. Nunca lanza: un fallo aqui no puede
   * deshacer una prealerta ya guardada ni mostrarle un error al cliente por algo
   * que no depende de el.
   *
   * El resultado se sella en `helga_prealert_status` del tramite para que la
   * reconciliacion (pendiente) sepa cuales reenviar:
   * - integracion apagada o casillero sin enlazar -> queda 'pending' (el default
   *   del insert); se reintentara cuando Helga este on y el casillero enlazado.
   * - exito -> 'synced'. fallo del proveedor -> 'failed' con el motivo.
   *
   * Aun sin replicar, la sincronizacion por tracking recupera el paquete cuando
   * llega a bodega: la bandera es una red adelantada, no un requisito.
   */
  async prealertWithProvider(clientId: string, shipment: ShipmentDto): Promise<void> {
    if (!isHelgaEnabled()) return;

    const link = await clientsRepo.providerLinkFor(clientId);
    if (!link?.helgaClientId) {
      console.warn(`[helga] casillero ${shipment.client.code} sin enlazar: prealerta no replicada.`);
      return;
    }

    let status: HelgaSyncStatus;
    let error: string | null;
    try {
      await createHelgaPrealert({
        helgaClientId: link.helgaClientId,
        tracking: shipment.tracking,
        description: shipment.description,
        store: shipment.store,
      });
      status = HelgaSyncStatus.Synced;
      error = null;
    } catch (err) {
      status = HelgaSyncStatus.Failed;
      error = err instanceof Error ? err.message : String(err);
      console.error(`[helga] no se pudo prealertar ${shipment.tracking}:`, err);
    }

    // Sella el estado sin volver a lanzar: la bandera es informativa para la
    // reconciliacion y no debe tumbar una prealerta ya guardada.
    try {
      await shipmentsRepo.update(shipment.id, {
        helgaPrealertStatus: status,
        helgaPrealertAttempts: 1,
        helgaPrealertError: error,
      });
    } catch (err) {
      console.error(`[helga] no se pudo sellar el estado de prealerta de ${shipment.tracking}:`, err);
    }
  },

  /**
   * Tarea del robot: reenvia al proveedor las prealertas que quedaron sin
   * replicar ('pending' o 'failed') y cuyo casillero YA esta enlazado. Reusa la
   * misma llamada de la prealerta en vivo (`createHelgaPrealert`) y sella el
   * resultado en la bandera del tramite, sumando un intento.
   *
   * Nunca lanza por una prealerta: un fallo con una no frena las demas. Aun sin
   * replicar, la sincronizacion por tracking recupera el paquete cuando llega a
   * bodega, asi que esto es una red adelantada, no un requisito.
   */
  async reconcilePrealerts(): Promise<PrealertReconcileReport> {
    const report: PrealertReconcileReport = { checked: 0, synced: 0, failed: 0 };
    if (!isHelgaEnabled()) return report;

    const pending = await shipmentsRepo.findPrealertsToReconcile(PREALERT_RECONCILE_BATCH);
    for (const s of pending) {
      report.checked += 1;

      let status: HelgaSyncStatus;
      let error: string | null;
      try {
        await createHelgaPrealert({
          helgaClientId: s.helgaClientId,
          tracking: s.tracking,
          description: s.description,
          store: s.store,
        });
        status = HelgaSyncStatus.Synced;
        error = null;
        report.synced += 1;
      } catch (err) {
        status = HelgaSyncStatus.Failed;
        error = err instanceof Error ? err.message : String(err);
        report.failed += 1;
        console.error(`[helga] reconciliación: no se pudo prealertar ${s.tracking}:`, err);
      }

      await shipmentsRepo.update(s.id, {
        helgaPrealertStatus: status,
        helgaPrealertAttempts: s.attempts + 1,
        helgaPrealertError: error,
      });
    }
    return report;
  },

  /** Alta por un usuario de staff. El permiso depende del tipo de tramite. */
  async create(session: Session, input: CreateShipmentInput): Promise<ShipmentDto> {
    assertCanWrite(session, input.shipmentType);

    const client = await clientsRepo.findById(input.clientId);
    if (!client) throw ShipmentErrors.clientNotFound();

    return this.insert(
      {
        clientId: input.clientId,
        shipmentType: input.shipmentType,
        tracking: input.tracking,
        description: input.description,
        store: input.store ?? null,
        carrier: input.carrier ?? null,
        hawb: input.hawb ?? null,
        // Punto unico de redondeo del peso (regla del manual: siempre hacia arriba).
        weightKg: input.weightKg === undefined ? null : roundWeightKg(input.weightKg),
        billingNotes: input.billingNotes ?? null,
      },
      session.userId,
    );
  },

  /** Inserta con consecutivo y estado inicial derivados; comun a prealerta y alta. */
  async insert(
    values: Omit<Parameters<typeof shipmentsRepo.insert>[0], 'code' | 'state' | 'createdBy'>,
    createdBy: string,
  ): Promise<ShipmentDto> {
    await assertTrackingFree(values.tracking);

    const code = formatShipmentCode(await shipmentsRepo.nextCodeSequence());
    const state = initialState(flowForType(values.shipmentType));

    // Solo Paqueteria se replica ante el proveedor: los demas tipos nacen sin
    // bandera (`null` = no aplica). El paquete arranca 'pending' y el intento
    // inmediato de `prealertWithProvider` la sella; si no se intenta o falla,
    // queda para la reconciliacion.
    const helgaPrealertStatus = usesPackageFields(values.shipmentType)
      ? HelgaSyncStatus.Pending
      : null;

    const id = await shipmentsRepo.insert({ ...values, code, state, createdBy, helgaPrealertStatus });
    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();
    return toDto(row);
  },

  /**
   * Edicion por staff. Aqui (y no en el DTO) se valida la coherencia tipo <->
   * campos: el PATCH no conoce el tipo del tramite guardado, solo la BD lo sabe.
   */
  async update(session: Session, id: string, patch: UpdateShipmentInput): Promise<ShipmentDto> {
    const current = await shipmentsRepo.findById(id);
    if (!current) throw ShipmentErrors.notFound();
    assertCanWrite(session, current.shipmentType);

    const isPackage = usesPackageFields(current.shipmentType);
    const notForThisType = isPackage
      ? (['warehouse', 'dua', 'billingNotes'] as const)
      : (['store', 'carrier', 'hawb', 'weightKg'] as const);
    for (const field of notForThisType) {
      if (patch[field] !== undefined && patch[field] !== null) throw ShipmentErrors.fieldNotForType();
    }

    // Reja por estado: la maquina de estados declara que campos admiten edicion en
    // el estado actual. Un campo presente en el patch (aunque sea `null` para
    // limpiarlo) que no este permitido -> 409. Fuente unica; la web deshabilita los
    // mismos campos con `editableFieldsAt`.
    const editable = editableFieldsAt(flowForType(current.shipmentType), current.state);
    for (const field of Object.values(ShipmentField)) {
      const present = patch[field as keyof UpdateShipmentInput] !== undefined;
      if (present && !editable.includes(field)) {
        throw ShipmentErrors.fieldNotEditableInState(STATE_LABELS[current.state]);
      }
    }

    // Candado de dinero: el peso alimenta la factura. Una vez congelada (costos
    // aprobados) no se puede tocar por PATCH aunque el estado siguiera admitiendolo;
    // corregirlo exige reversar los costos. Depende de la fila, no del estado.
    if (patch.weightKg !== undefined && current.costsApprovedAt != null) {
      throw ShipmentErrors.weightLockedAfterInvoice();
    }

    if (patch.tracking !== undefined && patch.tracking !== current.tracking) {
      await assertTrackingFree(patch.tracking);
    }

    await shipmentsRepo.update(id, {
      ...(patch.tracking !== undefined ? { tracking: patch.tracking } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.store !== undefined ? { store: patch.store } : {}),
      ...(patch.carrier !== undefined ? { carrier: patch.carrier } : {}),
      ...(patch.hawb !== undefined ? { hawb: patch.hawb } : {}),
      ...(patch.weightKg !== undefined
        ? { weightKg: patch.weightKg === null ? null : roundWeightKg(patch.weightKg) }
        : {}),
      ...(patch.warehouse !== undefined ? { warehouse: patch.warehouse } : {}),
      ...(patch.dua !== undefined ? { dua: patch.dua } : {}),
      ...(patch.billingNotes !== undefined ? { billingNotes: patch.billingNotes } : {}),
    });

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return toDto(updated);
  },
};
