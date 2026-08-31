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
  ShipmentType,
  State,
  can,
  conditionsFor,
  editableFieldsAt,
  flowForType,
  initialState,
  isSettled,
  paged,
  pendingAmount,
  roundMoney,
  settledAmount,
  usesPackageFields,
} from '@courier/shared';
import type {
  AssignShipmentOwnerInput,
  CorrectUnassignedShipmentInput,
  CreateShipmentInput,
  DiscardShipmentInput,
  Flow,
  ListShipmentsQuery,
  Page,
  PrealertShipmentInput,
  RegisterUnassignedShipmentInput,
  Session,
  ShipmentDto,
  ShipmentEventsResponse,
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
    /**
     * `null` cuando el paquete llego a bodega sin dueño y espera en la sala de
     * control. Los tres campos vienen del mismo LEFT JOIN, asi que o estan los
     * tres o no esta ninguno; se comprueba `clientId` y los otros dos se dan por
     * buenos en vez de repetir la pregunta tres veces.
     */
    client:
      row.clientId === null
        ? null
        : { id: row.clientId, code: row.clientCode ?? '', name: row.clientName ?? '' },
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
    electronicInvoiceNumber: row.electronicInvoiceNumber,
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
    /**
     * Los mismos abonos en dolares. Se mandan SIEMPRE, no solo en Paqueteria: la
     * moneda en que se leen la elige la pantalla segun quien mira
     * (`billingCurrencyFor`), y un DTO que cambia de forma segun el tipo de
     * tramite obligaria a cada consumidor a repetir esa condicion.
     */
    settledUsd: settledAmount(row.settlement, Currency.USD),
    pendingUsd: pendingAmount(row.settlement, Currency.USD),
    discardedAt: row.discardedAt?.toISOString() ?? null,
    discardReason: row.discardReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Un tracking activo no se puede repetir (mismo criterio que el indice parcial). */
async function assertTrackingFree(tracking: string): Promise<void> {
  const clash = await shipmentsRepo.findActiveByTracking(tracking);
  if (clash) throw ShipmentErrors.trackingInUse(clash.code);
}

/**
 * Estado con el que nace un paquete registrado en la sala de control.
 *
 * "Facturación en proceso" y no "Prealertado": el paquete ya esta fisicamente en
 * la bodega de HS Global —por eso lo estamos registrando—, y hacerlo nacer al
 * principio del flujo seria mentir sobre donde esta. Es el mismo estado al que lo
 * habria llevado la recepcion normal si el LES hubiera resuelto a un tramite, asi
 * que en cuanto se le asigne dueño continua por donde le toca: costos, factura,
 * cobro, entrega.
 */
const UNASSIGNED_INITIAL_STATE = State.FacturacionEnProceso;

/** 409 si el tramite esta archivado: primero se restaura, despues se opera. */
function assertNotDiscarded(row: { discardedAt: Date | null }): void {
  if (row.discardedAt !== null) throw ShipmentErrors.discarded();
}

export const shipmentsService = {
  /**
   * Una pagina del dashboard, acotada al casillero propio cuando el rol es client.
   *
   * Las dos consultas van en paralelo: son independientes (una trae la pagina, la
   * otra cuenta el filtro completo) y encadenarlas duplicaria la latencia de la
   * pantalla mas usada del portal.
   */
  async list(session: Session, query: ListShipmentsQuery): Promise<Page<ShipmentDto>> {
    const ownerClientId = ownerScopeFor(session);
    const [rows, total] = await Promise.all([
      shipmentsRepo.list(query, ownerClientId),
      shipmentsRepo.countList(query, ownerClientId),
    ]);
    return paged(rows.map(toDto), total, query);
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
   * SOLO PAQUETERIA. Transporte y Agenciamiento no se prealertan: los registra el
   * staff con `create`, que exige `tramite.manage`. La barrera se repite aqui
   * aunque el schema ya fije el tipo a `Paqueteria`, porque este es el UNICO alta
   * que no pasa por `assertCanWrite`: sin ella, aflojar el schema volveria a
   * abrir el alta de agenciamiento al cliente sin que nada lo delate.
   *
   * En Paqueteria la prealerta se replica ante el proveedor: es lo que lo
   * autoriza a reportarnos el estado del paquete mientras esta en USA. Ese paso
   * NO bloquea —a diferencia del registro del casillero— porque el tramite ya es
   * util de nuestro lado aunque el proveedor no responda; la sincronizacion lo
   * recuperara despues por tracking.
   */
  async prealert(session: Session, input: PrealertShipmentInput): Promise<ShipmentDto> {
    if (!session.clientId) throw ShipmentErrors.missingClientProfile();
    if (!usesPackageFields(input.shipmentType)) throw AuthErrors.forbidden();

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

    // Sin condicion por tipo: llegados aqui el tramite es de Paqueteria, y todo
    // paquete prealertado se replica ante el proveedor.
    await this.prealertWithProvider(session.clientId, created);
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
      console.warn(`[helga] casillero ${shipment.client?.code ?? '(sin dueño)'} sin enlazar: prealerta no replicada.`);
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
        // Peso de bascula tal cual, con decimales: el redondeo hacia arriba del
        // manual es una regla de cobro y se aplica al cotizar el flete.
        weightKg: input.weightKg ?? null,
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
    assertNotDiscarded(current);
    /**
     * Un paquete sin dueño no se edita por aqui. No es un capricho de ruta: este
     * PATCH aplica la ventana de edicion por estado, y en "Facturación en
     * proceso" —donde nacen los desconocidos— esa ventana ya congelo el tracking,
     * el HAWB, la tienda y el transportista, que es justo lo que hay que poder
     * corregir mientras se averigua de quien es la caja. Ese caso tiene su propia
     * puerta (`correctUnassigned`), con su propio permiso.
     */
    if (current.clientId === null) throw ShipmentErrors.unassigned();

    const isPackage = usesPackageFields(current.shipmentType);
    // `billingNotes` y `electronicInvoiceNumber` no estan en ninguna de las dos
    // listas: son comunes a los dos flujos (el reporte los pide en ambos).
    const notForThisType = isPackage
      ? (['warehouse', 'dua'] as const)
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
      ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
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
      ...(patch.electronicInvoiceNumber !== undefined
        ? { electronicInvoiceNumber: patch.electronicInvoiceNumber }
        : {}),
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

  // -------------------------------------------------------------------------
  // Sala de control: paquetes sin dueño (permiso control_room.manage)
  // -------------------------------------------------------------------------

  /**
   * Da de alta un paquete que aparecio en la bodega de HS Global y que nadie
   * anuncio: ni el cliente lo prealerto ni el operador de Miami lo reporto.
   *
   * Tres cosas lo separan del alta normal, y las tres son consecuencia de no
   * saber de quien es:
   *
   * 1. NACE SIN DUEÑO (`clientId: null`). Es el punto entero del alta.
   * 2. NACE EN "FACTURACIÓN EN PROCESO", no en "Prealertado": el bulto ya esta
   *    en la bodega (ver `UNASSIGNED_INITIAL_STATE`).
   * 3. NO SE PREALERTA ANTE EL PROVEEDOR, y la bandera queda en `null` en vez de
   *    'pending'. Prealertar es decirle a Helga "a este destinatario le viene un
   *    paquete", y aqui no hay destinatario ni le viene nada: el paquete ya
   *    cruzo. Con `null` la reconciliacion del robot no lo levanta nunca, que es
   *    lo correcto: seguiria sin poder mandarlo, porque un paquete sin casillero
   *    no tiene destinatario en Helga.
   *
   * El TIPO es siempre Paqueteria. Un aereo o un agenciamiento no aparecen solos
   * en una bodega: nacen de una gestion negociada con un cliente concreto, asi que
   * un tramite de esos sin dueño no describe ninguna situacion real.
   */
  async registerUnassigned(
    session: Session,
    input: RegisterUnassignedShipmentInput,
  ): Promise<ShipmentDto> {
    const code = formatShipmentCode(await shipmentsRepo.nextCodeSequence());
    /**
     * Sin guia legible se siembra el consecutivo como tracking. La columna es
     * obligatoria (es la llave contra el proveedor y contra el indice de
     * duplicados) y aflojarla por este caso obligaria a revisar el nulo en todos
     * los cruces por tracking del sistema. El consecutivo es unico por
     * construccion y no se puede confundir con la guia de ninguna tienda;
     * `knownTracking` deshace la siembra al pintarlo.
     */
    const tracking = input.tracking ?? code;
    await assertTrackingFree(tracking);

    const id = await shipmentsRepo.insert(
      {
        code,
        clientId: null,
        shipmentType: ShipmentType.Paqueteria,
        state: UNASSIGNED_INITIAL_STATE,
        tracking,
        description: input.description,
        store: input.store ?? null,
        carrier: input.carrier ?? null,
        hawb: input.hawb ?? null,
        weightKg: input.weightKg ?? null,
        declaredValueUsd:
          input.declaredValueUsd === undefined
            ? null
            : roundMoney(input.declaredValueUsd, Currency.USD),
        billingNotes: input.billingNotes ?? null,
        // Ver decision 3 de la cabecera: `null` = no aplica, no 'pending'.
        helgaPrealertStatus: null,
        createdBy: session.userId,
      },
      // El historial de este tramite empieza a media maquina; sin esta linea, en
      // seis meses nadie sabria por que no tiene ni prealerta ni recepcion.
      `${CORRECTION_NOTE_PREFIX}paquete encontrado en bodega sin aviso previo. Registrado sin dueño desde la sala de control.`,
    );

    const row = await shipmentsRepo.findById(id);
    if (!row) throw ShipmentErrors.notFound();
    return toDto(row);
  },

  /**
   * Corrige los datos de un paquete que TODAVIA no tiene dueño.
   *
   * Se salta la ventana de edicion por estado a proposito (ver
   * `correctUnassignedShipmentSchema`): esa ventana protege un tramite que fluye,
   * y este no fluye. Lo que si se conserva es la unicidad del tracking, que no es
   * politica de proceso sino integridad: dos tramites activos con la misma guia
   * rompen la sincronizacion con el proveedor y la recepcion en bodega.
   */
  async correctUnassigned(
    session: Session,
    id: string,
    patch: CorrectUnassignedShipmentInput,
  ): Promise<ShipmentDto> {
    const current = await shipmentsRepo.findById(id);
    if (!current) throw ShipmentErrors.notFound();
    assertNotDiscarded(current);
    if (current.clientId !== null) {
      throw ShipmentErrors.alreadyAssigned(current.clientCode ?? '');
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
      ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
      ...(patch.declaredValueUsd !== undefined
        ? {
            declaredValueUsd:
              patch.declaredValueUsd === null
                ? null
                : roundMoney(patch.declaredValueUsd, Currency.USD),
          }
        : {}),
      ...(patch.billingNotes !== undefined ? { billingNotes: patch.billingNotes } : {}),
    });

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return toDto(updated);
  },

  /**
   * Escribe (o cambia) el dueño del tramite. UNA operacion para los dos casos de
   * la sala de control, porque para el sistema son el mismo acto:
   *
   *   - ASIGNAR: el paquete desconocido encontro a su dueño.
   *   - REASIGNAR: el paquete estaba cargado al casillero equivocado (homonimos,
   *     dos cuentas de la misma familia, un dedazo en el alta).
   *
   * Lo que NO se toca: el estado. Asignar dueño no mueve el paquete, y un tramite
   * que ya venia avanzado sigue donde estaba. Tampoco se notifica al cliente
   * nuevo: se le esta corrigiendo un registro, no avisando de un avance, y el
   * correo llegaria sin contexto ("su paquete esta en facturación" de un paquete
   * del que nunca supo nada).
   *
   * Dos candados, y los dos son de dinero:
   *
   *   - FACTURA CONGELADA (`costsApprovedAt`): el total se calculo con la tarifa
   *     del casillero actual y ya se le presento. Cambiar el dueño despues
   *     traslada una deuda entre dos clientes sin asiento que lo explique.
   *   - PAGOS REGISTRADOS: los abonos cuelgan del tramite, no del cliente, asi
   *     que el nuevo dueño heredaria pagos que nunca hizo. Se exige resolverlos
   *     antes (anular el pago o reversar los costos), que son actos con rastro.
   *
   * Ninguno aplica al paquete desconocido, que nace sin costos y sin pagos: los
   * candados solo muerden en la reasignacion, que es donde hay algo que romper.
   */
  async assignOwner(
    session: Session,
    id: string,
    input: AssignShipmentOwnerInput,
  ): Promise<ShipmentDto> {
    const current = await shipmentsRepo.findById(id);
    if (!current) throw ShipmentErrors.notFound();
    assertNotDiscarded(current);
    if (current.clientId === input.clientId) throw ShipmentErrors.sameOwner();

    const client = await clientsRepo.findById(input.clientId);
    if (!client) throw ShipmentErrors.clientNotFound();

    const isReassignment = current.clientId !== null;
    if (isReassignment) {
      if (current.costsApprovedAt != null) throw ShipmentErrors.ownerLockedAfterInvoice();
      // `settlement` trae TODOS los abonos del tramite, no solo los confirmados:
      // un comprobante en validacion tambien esta a nombre del dueño actual.
      if (current.settlement.length > 0) throw ShipmentErrors.ownerLockedByPayments();
    }

    const previousOwner = isReassignment
      ? `${current.clientCode ?? ''} (${current.clientName ?? ''})`
      : 'sin dueño';
    // El prefijo de correccion es lo que mantiene esta linea fuera del historial
    // que ve el titular: el cliente nuevo no tiene por que leer a quien se le
    // habia cargado su paquete por error.
    const note =
      `${CORRECTION_NOTE_PREFIX}dueño cambiado de ${previousOwner} a ` +
      `${client.code} (${client.name}). ${input.note}`;

    await shipmentsRepo.assignOwner(id, current.state, input.clientId, session.userId, note);

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    const dto = toDto(updated);

    /**
     * Prealerta ante el proveedor: solo tiene sentido si el paquete SIGUE en
     * manos de Helga, y eso hoy solo pasa en "Prealertado" (los demas estados de
     * la etapa de Miami los escribe la sincronizacion, que ya trabaja sobre un
     * paquete que Helga tiene fisicamente y con destinatario asignado de su
     * lado). Reasignar ahi es cambiar a quien le va a entregar, asi que la
     * prealerta vieja se borra y se rehace a nombre del casillero nuevo.
     *
     * En cualquier otro estado —incluido el paquete desconocido, que nace ya en
     * facturacion— no se toca nada del proveedor: el bulto ya cruzo y una
     * prealerta nueva solo crearia un fantasma en su sistema.
     */
    if (usesPackageFields(dto.shipmentType) && dto.state === State.Prealertado) {
      await this.reprealertAfterTrackingChange(dto, current.helgaPrealertId);
    }

    return dto;
  },

  /**
   * Archiva un paquete sin dueño: llego destrozado, era relleno de la carga, se
   * devolvio al operador de Miami o simplemente no da para mas.
   *
   * NO borra la fila. El bulto estuvo fisicamente en la bodega y esa evidencia es
   * justo lo que alguien va a reclamar dentro de seis meses; lo que desaparece es
   * de las pantallas y del indice de trackings activos, para que un desconocido
   * mal digitado no bloquee el alta del envio legitimo que traiga esa guia.
   *
   * Solo aplica a paquetes SIN dueño. Uno que ya tiene casillero es un tramite
   * normal, y esos se enmiendan por el flujo (corregir estado, reversar costos),
   * no archivandolos por la puerta de atras.
   */
  async discard(session: Session, id: string, input: DiscardShipmentInput): Promise<ShipmentDto> {
    const current = await shipmentsRepo.findById(id);
    if (!current) throw ShipmentErrors.notFound();
    if (current.discardedAt !== null) throw ShipmentErrors.discarded();
    if (current.clientId !== null) throw ShipmentErrors.discardOnlyUnassigned();

    await shipmentsRepo.setDiscarded(
      id,
      current.state,
      session.userId,
      input.reason,
      `${CORRECTION_NOTE_PREFIX}paquete descartado. ${input.reason}`,
    );

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return toDto(updated);
  },

  /**
   * Deshace un descarte. Existe porque descartar es un clic y equivocarse de fila
   * en una lista de cajas anonimas es facil; sin vuelta atras, el unico arreglo
   * seria dar de alta el paquete otra vez y perder su historial.
   *
   * El tracking vuelve a entrar al indice de activos, asi que se comprueba que
   * nadie lo haya ocupado mientras estaba archivado.
   */
  async restore(session: Session, id: string): Promise<ShipmentDto> {
    const current = await shipmentsRepo.findById(id);
    if (!current) throw ShipmentErrors.notFound();
    if (current.discardedAt === null) throw ShipmentErrors.notDiscarded();

    await assertTrackingFree(current.tracking);
    await shipmentsRepo.setDiscarded(
      id,
      current.state,
      session.userId,
      null,
      `${CORRECTION_NOTE_PREFIX}descarte deshecho: el paquete vuelve a la sala de control.`,
    );

    const updated = await shipmentsRepo.findById(id);
    if (!updated) throw ShipmentErrors.notFound();
    return toDto(updated);
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
    // Sin casillero no hay destinatario al que prealertar. Solo puede pasar por
    // la sala de control (un paquete sin dueño), y ahi la prealerta no aplica.
    if (!shipment.client) return;

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
