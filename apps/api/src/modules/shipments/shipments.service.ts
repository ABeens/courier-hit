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
  CORRECTION_NOTE_PREFIX,
  Condition,
  Currency,
  DOCUMENT_ATTACHMENT,
  HelgaSyncStatus,
  Permission,
  Role,
  STATE_LABELS,
  ShipmentField,
  can,
  conditionsFor,
  editableFieldsAt,
  flowForType,
  initialState,
  isSettled,
  pendingAmount,
  roundMoney,
  roundWeightKg,
  settledAmount,
  usesPackageFields,
} from '@courier/shared';
import type {
  CreateShipmentInput,
  Flow,
  ListShipmentsQuery,
  PrealertShipmentInput,
  Session,
  ShipmentDto,
  ShipmentEventsResponse,
  ShipmentType,
  State,
  UpdateShipmentInput,
} from '@courier/shared';
import { AuthErrors, ShipmentErrors } from '../../core/errors';
import { formatShipmentCode } from '@courier/shared';
import {
  createHelgaPrealert,
  deleteHelgaPrealert,
  isHelgaEnabled,
} from '../../integrations/helga/helga.client';
import { storage } from '../../core/storage';
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
 * Nota de un asiento del historial tal como puede verla el TITULAR, o null si esa
 * nota no es para el. Ver `shipmentsService.events` para el por que.
 *
 * Dos filtros, y los dos hacen falta: el estado tiene que EXIGIR comentario (solo
 * entonces la nota es la explicacion que se le debe al cliente) y el asiento no
 * puede ser una correccion administrativa, que llega al mismo estado por la
 * puerta de atras y guarda ahi el motivo de un error nuestro.
 */
function ownerVisibleNote(flow: Flow, state: State, note: string | null): string | null {
  if (!note) return null;
  if (!conditionsFor(flow, state).includes(Condition.RequiresComment)) return null;
  if (note.startsWith(CORRECTION_NOTE_PREFIX)) return null;
  return note;
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
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
    volumetricWeightKg: row.volumetricWeightKg,
    declaredValueUsd: row.declaredValueUsd,
    insuredValueUsd: row.insuredValueUsd,
    tariffPosition: row.tariffPosition,
    retain: row.retain,
    documentFileKey: row.documentFileKey,
    warehouse: row.warehouse,
    dua: row.dua,
    billingNotes: row.billingNotes,
    routeNumber: row.routeNumber,
    invoiceTotalUsd: row.invoiceTotalUsd,
    invoiceTotalCrc: row.invoiceTotalCrc,
    /**
     * Bandera de cobro, derivada aqui en cada lectura a partir de los abonos que
     * trajo la consulta. Las dos cifras salen de las funciones compartidas, las
     * mismas que usan la cotizacion del cliente, el reporte financiero y la
     * guarda Condition.RequiresConfirmedPayment: si algun dia discrepan es que
     * alguien sumo por su cuenta, no que haya dos reglas.
     */
    settledCrc: settledAmount(row.settlement, Currency.CRC),
    settled: isSettled(row.settlement, row.invoiceTotalCrc),
    pendingCrc: pendingAmount(row.settlement, Currency.CRC),
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

  /**
   * Historial de estados de un tramite (mismas reglas de acceso que el detalle).
   *
   * Al TITULAR se le devuelve recortado. No es una decision de pantalla sino de
   * exposicion de datos, y por eso vive aqui: la trazabilidad que el cliente pide
   * es "por donde ha pasado mi paquete y cuando", no la trastienda con la que la
   * operacion lo movio. Se le quitan dos cosas:
   *
   *   - QUIEN lo movio: es organigrama interno. Al cliente le responde HS Global,
   *     no la persona que pulso el boton.
   *   - Las notas que NO son para el: el comentario del avance es un campo libre
   *     donde la operacion se deja recados ("ojo, el peso no cuadra"), y la
   *     correccion administrativa guarda ahi el motivo de un error nuestro. La
   *     unica nota escrita PARA el cliente es la que un estado exige
   *     (Condition.RequiresComment: la razon por la que su paquete volvio a
   *     bodega), asi que ese es el filtro, y sale de la maquina de estados en vez
   *     de una lista de estados a mano.
   */
  async events(session: Session, id: string): Promise<ShipmentEventsResponse> {
    const shipment = await this.get(session, id); // valida existencia y propiedad
    const forOwner = session.role === Role.Client;
    const rows = await shipmentsRepo.listEvents(id);

    return {
      items: rows.map((e) => ({
        id: e.id,
        state: e.state,
        note: forOwner ? ownerVisibleNote(shipment.flow, e.state, e.note) : e.note,
        createdByName: forOwner ? null : e.createdByName,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },

  /**
   * Adjunta (o reemplaza) el DOCUMENTO del tramite: la factura de la compra que
   * se prealerta, tipicamente.
   *
   * Va en una peticion aparte de la prealerta, y no en el mismo cuerpo, por lo
   * mismo que el comprobante de un deposito: el archivo obliga a multipart y
   * mezclarlo con el JSON validado por Zod significaria validar datos y archivo
   * en la misma transaccion. Aqui ademas compra algo: el documento es opcional y
   * puede llegar despues, sin repetir la prealerta.
   *
   * El acceso lo resuelve `get`, que ya devuelve 404 —no 403— cuando el tramite
   * no es del cliente de la sesion: quien no puede verlo tampoco puede saber que
   * existe para adjuntarle nada.
   *
   * Que formatos entran NO se decide aqui sino en el borde (`storage.put` con el
   * catalogo `DOCUMENT_ATTACHMENT`), que es el unico punto por el que un archivo
   * entra al sistema.
   */
  async attachDocument(session: Session, id: string, file: File): Promise<ShipmentDto> {
    const shipment = await this.get(session, id);

    const key = await storage.put('documents', file, DOCUMENT_ATTACHMENT);
    // Reemplazar el documento borra el anterior: dejarlo huerfano solo acumula
    // basura en el almacen que ya nadie puede alcanzar (mismo criterio que el
    // comprobante de pago).
    if (shipment.documentFileKey) await storage.remove(shipment.documentFileKey);
    await shipmentsRepo.update(id, { documentFileKey: key });

    return this.get(session, id);
  },

  /**
   * Contenido del documento adjunto, para descargarlo. Pasa por la API en vez de
   * exponer el almacen: la clave es opaca pero no es un permiso, y quien pide el
   * archivo tiene que superar la misma barrera que para ver el tramite.
   */
  async documentFile(session: Session, id: string): Promise<{ body: ArrayBuffer; contentType: string; filename: string }> {
    const shipment = await this.get(session, id);
    if (!shipment.documentFileKey) throw ShipmentErrors.documentMissing();

    const file = await storage.get(shipment.documentFileKey);
    /**
     * El nombre de la descarga se DERIVA del consecutivo del tramite y de la
     * extension de la clave; no se guarda el nombre original. Asi lo que llega a
     * la cabecera `content-disposition` no lo escribe el usuario, y de paso el
     * archivo cae en el escritorio de quien lo baja ya identificado por tramite.
     */
    const ext = shipment.documentFileKey.split('.').pop() ?? 'bin';
    return { ...file, filename: `${shipment.code}.${ext}` };
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
        // El cliente solo declara el valor comercial; el asegurado, el arancel y el
        // retener los completa el staff, asi que aqui nacen null.
        declaredValueUsd:
          input.declaredValueUsd === undefined ? null : roundMoney(input.declaredValueUsd, Currency.USD),
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
    let prealertId: string | null = null;
    try {
      prealertId = await createHelgaPrealert({
        helgaClientId: link.helgaClientId,
        tracking: shipment.tracking,
        description: shipment.description,
        store: shipment.store,
        commercialValue: shipment.declaredValueUsd,
        insuredValue: shipment.insuredValueUsd,
        tariffPosition: shipment.tariffPosition,
        retain: shipment.retain,
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
        helgaPrealertId: prealertId,
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
      let prealertId: string | null = null;
      try {
        prealertId = await createHelgaPrealert({
          helgaClientId: s.helgaClientId,
          tracking: s.tracking,
          description: s.description,
          store: s.store,
          commercialValue: s.declaredValueUsd,
          insuredValue: s.insuredValueUsd,
          tariffPosition: s.tariffPosition,
          retain: s.retain,
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
        // Solo se pisa si el proveedor dio uno: en un fallo hay que conservar el
        // id anterior, que sigue siendo el unico modo de borrar esa prealerta.
        ...(prealertId ? { helgaPrealertId: prealertId } : {}),
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
        // Datos para la prealerta del proveedor. Los importes se redondean a 2
        // decimales (USD) en este unico punto; retener y arancel viajan tal cual.
        declaredValueUsd:
          input.declaredValueUsd === undefined ? null : roundMoney(input.declaredValueUsd, Currency.USD),
        insuredValueUsd:
          input.insuredValueUsd === undefined ? null : roundMoney(input.insuredValueUsd, Currency.USD),
        tariffPosition: input.tariffPosition ?? null,
        retain: input.retain ?? null,
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
      : (['store', 'carrier', 'hawb', 'weightKg', 'declaredValueUsd', 'insuredValueUsd', 'tariffPosition', 'retain'] as const);
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
      ...(patch.declaredValueUsd !== undefined
        ? { declaredValueUsd: patch.declaredValueUsd === null ? null : roundMoney(patch.declaredValueUsd, Currency.USD) }
        : {}),
      ...(patch.insuredValueUsd !== undefined
        ? { insuredValueUsd: patch.insuredValueUsd === null ? null : roundMoney(patch.insuredValueUsd, Currency.USD) }
        : {}),
      ...(patch.tariffPosition !== undefined ? { tariffPosition: patch.tariffPosition } : {}),
      ...(patch.retain !== undefined ? { retain: patch.retain } : {}),
      ...(patch.warehouse !== undefined ? { warehouse: patch.warehouse } : {}),
      ...(patch.dua !== undefined ? { dua: patch.dua } : {}),
      ...(patch.billingNotes !== undefined ? { billingNotes: patch.billingNotes } : {}),
    });

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    const dto = toDto(updated);

    // El tracking es la LLAVE con la que el proveedor identifica el paquete: si
    // cambia, la prealerta vieja apunta a un envio que ya no existe y la nueva no
    // existe todavia. Se rehace despues de guardar, con el tracking ya persistido.
    if (isPackage && patch.tracking !== undefined && patch.tracking !== current.tracking) {
      await this.reprealertAfterTrackingChange(dto, current.helgaPrealertId);
    }

    return dto;
  },

  /**
   * Rehace la prealerta cuando cambia el tracking: borra la anterior en Helga
   * (op. F) y crea una nueva con el tracking corregido.
   *
   * NUNCA lanza. Corregir un tracking mal digitado es una operacion de bodega que
   * no puede fallar porque el proveedor no responda; si algo sale mal, el tramite
   * queda 'failed' y la reconciliacion lo reintenta.
   *
   * El borrado va PRIMERO y su fallo no impide crear la nueva: quedarse sin
   * prealerta valida seria peor que dejar una huerfana. Un `false` (404) tampoco
   * es error: la prealerta ya no estaba, que es justo lo que se buscaba.
   */
  async reprealertAfterTrackingChange(
    shipment: ShipmentDto,
    previousPrealertId: string | null,
  ): Promise<void> {
    if (!isHelgaEnabled()) return;

    if (previousPrealertId) {
      try {
        const removed = await deleteHelgaPrealert(previousPrealertId);
        if (!removed) {
          console.warn(`[helga] la prealerta ${previousPrealertId} ya no existía al cambiar el tracking.`);
        }
      } catch (err) {
        console.error(`[helga] no se pudo borrar la prealerta ${previousPrealertId}:`, err);
      }
    }

    await this.prealertWithProvider(shipment.client.id, shipment);
  },
};
