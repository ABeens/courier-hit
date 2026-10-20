/**
 * Sincronizacion de estados con el proveedor (docs/13).
 *
 * El proveedor reporta el tramo de USA -> Costa Rica; nosotros lo traducimos a
 * nuestros estados y avanzamos el tramite. De "En Aduanas" en adelante manda la
 * operacion manual de HS Global y esta sincronizacion ya no toca nada.
 *
 * Cinco decisiones que viven aqui:
 *
 * 1. LA CONSULTA VA POR TRACKING. La op. B de Helga busca UN paquete por su
 *    HAWB/tracking, no lista los de un casillero. Asi que la sincronizacion parte
 *    de NUESTROS envios en tramo y le pregunta a Helga por cada tracking. Un 404
 *    significa que el paquete aun no llega a bodega (prealerta): no es error.
 *    En cuanto el tramite tiene HAWB se pregunta por el HAWB, que Helga busca por
 *    igualdad; por tracking busca por "contiene" (ver `lookupProviderPackage`).
 * 2. SOLO SE AVANZA, NUNCA SE RETROCEDE. Se aplica `canTransition` como cualquier
 *    otro movimiento: si el proveedor reporta un estado anterior al que ya
 *    tenemos (llega tarde, o es una correccion suya), se ignora.
 * 3. NO AVANZA MAS ALLA DE "EN ADUANAS". Es el limite acordado del tramo del
 *    proveedor. Un paquete ya recibido en bodega no puede volver atras porque
 *    Helga siga moviendo su guia.
 * 4. UN ESTADO DESCONOCIDO SE REGISTRA. No se ignora en silencio: si el proveedor
 *    agrega un estado, preferimos un aviso en el log a paquetes congelados.
 * 5. SE PREGUNTA CON EL TOKEN DE LA CUENTA DE LA QUE VINO EL PAQUETE. Cada cuenta
 *    de Helga ve solo lo suyo, asi que preguntar por el paquete de un cliente
 *    consolidado con el token de la cuenta principal no da un error de permisos
 *    sino un 404, indistinguible de "aun no llega a bodega". El origen viaja en
 *    `shipments.provider_account_code` desde que el paquete entro.
 *
 * Se agenda en el scheduler (`core/scheduler/jobs.ts`) cada `ROBOT_PROVIDER_SYNC_EVERY`;
 * tambien se puede disparar a mano desde `POST /shipments/sync-provider`.
 */
import {
  Flow,
  ShipmentType,
  State,
  canTransition,
  flowForType,
  isProviderDrivenState,
  mapProviderState,
} from '@courier/shared';
import type { Session } from '@courier/shared';
import { isProviderRateLimited } from '../../core/errors';
import type { HelgaAccount } from '../../core/config';
import type { HelgaPackageStatus } from '../../integrations/helga/helga.types';
import type { HelgaCallPriority } from '../../integrations/helga/helga.client';
import {
  isHelgaEnabled,
  isHelgaSimulated,
  fetchHelgaPackageState,
} from '../../integrations/helga/helga.client';
import type { ImportableAccount } from '../provider-accounts/provider-accounts.service';
import { providerAccountsService } from '../provider-accounts/provider-accounts.service';
import { providerSyncRepo } from './provider-sync.repo';
import { shipmentsRepo } from './shipments.repo';

/**
 * Ultimo estado que la sincronizacion puede alcanzar. Coincide con el final del
 * tramo del proveedor: mas alla empieza el flujo manual (decision 3).
 */
const PROVIDER_LAST_STATE = State.EnAduanas;

/** Techo de envios a consultar por corrida (una llamada a Helga por cada uno). */
const SYNC_BATCH = 200;

/**
 * Helga a veces reporta el peso como cadena ("1.38"); lo normaliza a numero.
 * Exportado porque el descubrimiento (flujo 2) lee los mismos campos del mismo
 * proveedor: dos copias de esta normalizacion podrian divergir.
 */
export function toNumber(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * True si el paquete que devolvio la op. B es de verdad el que preguntamos.
 *
 * Por TRACKING la op. B NO busca por igualdad sino por "contiene", y devuelve UN
 * solo paquete. Verificado en vivo (2026-10-19, cuenta Zuca): buscar
 * `FA-ZN-1-2026101402-1` devuelve el paquete `FA-ZN-1-2026101402-13`, y buscar
 * solo `2026101402` tambien. Sin esta comprobacion el tramite recibiria el
 * estado, el peso y el HAWB de otro paquete, y el portal mostraria sus fotos.
 *
 * `search` es lo que se le pregunto: el HAWB o nuestro tracking (que a su vez
 * puede ser un HAWB, porque el descubrimiento lo usa cuando la fila no trae
 * tracking), asi que vale cualquiera de los dos campos. Si el proveedor no manda
 * ninguno no hay contra que comparar y se acepta: es el comportamiento de siempre.
 */
export function isSamePackage(search: string, pkg: { tracking?: string; Sello?: string }): boolean {
  const ours = search.trim().toUpperCase();
  const theirs = [pkg.tracking, pkg.Sello]
    .map((v) => v?.trim().toUpperCase())
    .filter((v): v is string => Boolean(v));
  return theirs.length === 0 || theirs.includes(ours);
}

/** Resultado de `lookupProviderPackage`. */
export type ProviderLookup =
  | { kind: 'found'; pkg: HelgaPackageStatus }
  /** 404: el paquete aun no existe del lado de Helga (prealerta sin llegar). */
  | { kind: 'not_found' }
  /** Helga contesto con OTRO paquete (ver `isSamePackage`): no se usa nada. */
  | { kind: 'other_package'; search: string; pkg: HelgaPackageStatus };

/**
 * Op. B para UN tramite, por la llave mas segura que tenga.
 *
 * POR HAWB PRIMERO. Verificado en vivo (2026-10-19): por HAWB la op. B busca por
 * IGUALDAD (sin distinguir mayusculas; `LES4858001` o `48580012` dan 404), y por
 * tracking busca por "contiene". Asi que en cuanto el tramite tiene su LES, la
 * respuesta no puede ser de otro paquete.
 *
 * Si el HAWB da 404 se reintenta por tracking: un LES mal digitado en recepcion
 * no puede dejar al paquete sin sincronizar. Cuesta una llamada de mas solo en
 * ese caso, porque un prealertado (el grueso del lote) aun no tiene HAWB.
 *
 * Por tracking se exige `isSamePackage`. Exportada porque las fotos
 * (`shipmentsService.photosOf`) consultan la misma op. B con el mismo riesgo.
 */
export async function lookupProviderPackage(
  ref: { tracking: string | null; hawb: string | null },
  account?: HelgaAccount,
  priority?: HelgaCallPriority,
): Promise<ProviderLookup> {
  const hawb = ref.hawb?.trim();
  if (hawb) {
    const pkg = await fetchHelgaPackageState(hawb, account, priority);
    // La comprobacion sobra si Helga cumple la igualdad, pero es gratis.
    if (pkg && isSamePackage(hawb, pkg)) return { kind: 'found', pkg };
  }

  const tracking = ref.tracking?.trim();
  if (!tracking || tracking.toUpperCase() === hawb?.toUpperCase()) return { kind: 'not_found' };

  const pkg = await fetchHelgaPackageState(tracking, account, priority);
  if (!pkg) return { kind: 'not_found' };
  if (!isSamePackage(tracking, pkg)) return { kind: 'other_package', search: tracking, pkg };
  return { kind: 'found', pkg };
}

/**
 * Estados que ya pertenecen al flujo manual: el proveedor no los toca.
 *
 * La frontera sale de `isProviderDrivenState` (shared) para no tener dos copias
 * de la misma linea: la web decide con ella que avances manuales ofrecer, y si
 * aqui se listara aparte, una tarea podria avanzar lo que alla se ofrece a mano.
 * Prealertado se suma porque es el punto de partida, todavia dentro del tramo.
 */
function isBeyondProvider(state: State): boolean {
  return state !== State.Prealertado && !isProviderDrivenState(Flow.Paqueteria, state);
}

export interface SyncReport {
  checked: number;
  advanced: number;
  incidents: string[];
  unknownStates: string[];
  /** Paquetes cuyo casillero no coincide con el del tramite (ver `checkLockerMatch`). */
  lockerMismatches: string[];
  /**
   * Codigos de cuenta que traen paquetes pero ya no se pueden consultar (la cuenta
   * se apago, se borro o perdio su cliente consolidado). Sus paquetes quedan
   * CONGELADOS hasta que alguien reactive la cuenta, asi que el robot lo grita en
   * cada corrida en vez de dejarlos morir en silencio.
   */
  unknownAccounts: string[];
  /** Consultas que devolvieron OTRO paquete (ver `isSamePackage`): se ignoran. */
  trackingMismatches: string[];
}

export const providerSyncService = {
  /**
   * Recorre nuestros envios en el tramo del proveedor y le pregunta a Helga por
   * cada tracking (op. B).
   *
   * Un fallo con un envio no aborta el resto: el proveedor puede responder mal
   * para uno y bien para los demas, y detener toda la pasada por eso dejaria sin
   * actualizar a los que no tienen ningun problema.
   */
  async run(session: Session): Promise<SyncReport> {
    const report: SyncReport = {
      checked: 0,
      advanced: 0,
      incidents: [],
      unknownStates: [],
      lockerMismatches: [],
      unknownAccounts: [],
      trackingMismatches: [],
    };

    if (!isHelgaEnabled()) {
      console.warn('[helga] sincronización omitida: la integración está apagada.');
      return report;
    }

    /**
     * Las cuentas del proveedor, indexadas por su codigo de casillero. Se
     * resuelven UNA vez por corrida (son un punado de filas y descifrar sus
     * credenciales cuesta) y no una por paquete.
     */
    const accounts = new Map<string, ImportableAccount>();
    for (const a of await providerAccountsService.accountsForImport()) {
      accounts.set(a.account.code, a);
    }

    const pending = await providerSyncRepo.shipmentsInProviderTramo(SYNC_BATCH);

    for (const shipment of pending) {
      /**
       * La cuenta de la que vino el paquete (decision 5). Sin codigo es la
       * principal, y ahi se deja pasar `undefined` para que el transporte use la
       * de siempre: es el caso de todo lo anterior a que hubiera varias cuentas.
       *
       * Con el proveedor simulado el codigo se ignora: el simulador es uno solo y
       * no pide credenciales.
       */
      const target = shipment.providerAccountCode
        ? accounts.get(shipment.providerAccountCode)
        : undefined;
      if (shipment.providerAccountCode && !target && !isHelgaSimulated()) {
        // Preguntar con el token de la principal devolveria 404 para siempre, que
        // se leeria como "aun no llega": es peor que no preguntar.
        // Se marca igual: sin turno anotado volveria al frente en cada corrida y
        // le quitaria su lugar en el lote a un paquete que si se puede consultar.
        await providerSyncRepo.markChecked(shipment.id);
        if (!report.unknownAccounts.includes(shipment.providerAccountCode)) {
          report.unknownAccounts.push(shipment.providerAccountCode);
          console.warn(
            `[helga] la cuenta ${shipment.providerAccountCode} ya no está disponible: sus ` +
              'paquetes no se pueden sincronizar hasta que se reactive.',
          );
        }
        continue;
      }

      let lookup;
      try {
        // `robot`: esta pasada encola hasta SYNC_BATCH llamadas de golpe, y no
        // puede ponerse por delante de lo que una persona esta esperando.
        lookup = await lookupProviderPackage(shipment, target?.account, 'robot');
      } catch (err) {
        // El limite del proveedor no dice nada de ESTE paquete: se corta la
        // pasada y se sigue en la proxima. Insistir con los demas solo alargaria
        // la corrida (el regulador ya los tendria esperando el castigo) con el
        // advisory lock tomado todo ese rato.
        if (isProviderRateLimited(err)) {
          console.warn(
            `[helga] límite de peticiones alcanzado; se corta la sincronización tras ` +
              `${report.checked} paquete(s) y se retoma en la próxima corrida.`,
          );
          break;
        }
        console.error(`[helga] fallo consultando ${shipment.code} (${shipment.tracking}):`, err);
        // Un paquete que falla siempre no puede quedarse con su lugar en el lote.
        await providerSyncRepo.markChecked(shipment.id);
        continue;
      }

      // Ya le toco su turno, traiga o no novedades: pasa al final de la cola
      // (ver `shipmentsInProviderTramo`). Antes del 404 a proposito, que es justo
      // el caso que dejaba a los estancados ocupando el lote para siempre.
      await providerSyncRepo.markChecked(shipment.id);

      // 404: el paquete aun no existe del lado de Helga (prealerta sin llegar).
      if (lookup.kind === 'not_found') continue;

      // Un paquete ajeno contesto por el nuestro (ver `isSamePackage`): nada de
      // lo que trae se escribe ni se usa para avanzar.
      if (lookup.kind === 'other_package') {
        const detail = `${shipment.code} (${lookup.search}): Helga devolvió ${lookup.pkg.tracking ?? '-'} / ${lookup.pkg.Sello ?? '-'}`;
        report.trackingMismatches.push(detail);
        console.warn(`[helga] la consulta devolvió otro paquete, se ignora -> ${detail}`);
        continue;
      }
      const { pkg } = lookup;

      const rawState = pkg.Estado_Envio?.trim();
      // "NO TIENE ESTADO": el paquete existe pero aun no tiene tracking util; no
      // hay nada que homologar todavia.
      if (!rawState || rawState.toUpperCase() === 'NO TIENE ESTADO') continue;

      report.checked += 1;

      // El peso que reporta el proveedor (kg explicito) es mejor que el que
      // declaro el cliente al prealertar: se refresca aunque el estado no avance,
      // porque de el depende el flete. Las medidas viajan en la misma escritura:
      // son informativas, pero pedirlas de nuevo mas tarde es imposible (la op. B
      // solo responde mientras el paquete esta en el tramo del proveedor).
      // El contenido y las notas van en la misma escritura: la bodega del
      // proveedor los corrige al digitar el paquete, y lo suyo es lo que vale.
      //
      // VA ANTES DE INTERPRETAR EL ESTADO. Los datos no dependen de que el estado
      // se entienda: con la escritura despues, un estado nuevo de Helga o una
      // incidencia dejaban el paquete sin peso, contenido ni notas para siempre.
      const patch = { ...this.measurementsPatch(shipment, pkg), ...this.providerTextPatch(shipment, pkg) };
      if (Object.keys(patch).length > 0) {
        await shipmentsRepo.update(shipment.id, patch);
      }

      const mapping = mapProviderState(rawState, this.currentAltState(rawState, pkg));
      if (mapping.kind === 'unknown') {
        report.unknownStates.push(mapping.providerState);
        console.warn(`[helga] estado no homologado: "${mapping.providerState}" (${shipment.tracking}).`);
        continue;
      }
      if (mapping.kind === 'incident') {
        report.incidents.push(`${shipment.code}: ${mapping.providerState}`);
        continue;
      }
      if (mapping.kind === 'operational') continue;

      // Control de identidad: el proveedor dice de QUE casillero es el paquete.
      // Si no coincide con el nuestro, el tracking apunta a un paquete ajeno y
      // avanzarlo movería el trámite equivocado.
      //
      // NO APLICA A UNA CUENTA EXCLUSIVA: alli el cliente consolidado recibe por
      // los sub-casilleros que le haya creado el proveedor, que son varios y que
      // nosotros no conocemos. Compararlos contra el unico que guardamos daria un
      // aviso falso por cada paquete.
      if (!target?.consolidatedClientId) this.checkLockerMatch(shipment, pkg, report);

      // Sin dueño solo se refrescan los datos: el estado no avanza hasta que un
      // Admin le asigne casillero (decision 4 del descubrimiento).
      if (!shipment.clientId) continue;

      if (isBeyondProvider(shipment.state)) continue;
      if (mapping.state === shipment.state) continue;

      const flow = flowForType(shipment.shipmentType);
      const advanced = await this.advanceTowards(session, shipment, flow, mapping.state);
      report.advanced += advanced;
    }

    return report;
  },

  /**
   * `estadoAlt` del estado actual: el del evento mas reciente del historial con
   * ese mismo `estado` (Helga lo devuelve del mas nuevo al mas viejo). Solo se
   * usa para las parejas homologadas en `HELGA_ALT_STATE_MAP`.
   */
  currentAltState(rawState: string, pkg: HelgaPackageStatus): string | undefined {
    const key = rawState.toUpperCase();
    return pkg.Seguimiento?.find((e) => e.estado?.trim().toUpperCase() === key)?.estadoAlt;
  },


  /**
   * Avisa si el paquete que devolvio el proveedor NO es del casillero que
   * esperabamos.
   *
   * `datos.cliente[].codigo_casillero` es el sub-casillero del dueño segun Helga.
   * Comparado con el nuestro detecta el caso peligroso: un tracking mal digitado,
   * o reciclado por el transportista, que apunta al paquete de otra persona. Sin
   * este control la sincronizacion avanzaria el tramite equivocado y el cliente
   * veria moverse un paquete que no es suyo.
   *
   * SOLO AVISA, no bloquea. Hoy no hay certeza de que el proveedor llene siempre
   * ese campo (`cliente` puede venir vacio) ni de que el sub-casillero de un
   * paquete recibido antes del enlace coincida; convertirlo en bloqueo dejaria
   * paquetes legitimos congelados. Cuando el log confirme que no hay falsos
   * positivos, esto puede pasar a frenar el avance.
   */
  checkLockerMatch(
    shipment: { code: string; tracking: string; clientSubLocker: string | null },
    pkg: { cliente?: Array<{ codigo_casillero?: string }> },
    report: SyncReport,
  ): void {
    const expected = shipment.clientSubLocker?.trim().toUpperCase();
    if (!expected) return; // casillero aun sin enlazar: no hay contra que comparar

    const reported = pkg.cliente
      ?.map((c) => c.codigo_casillero?.trim().toUpperCase())
      .filter((c): c is string => Boolean(c));
    if (!reported?.length) return; // el proveedor no lo informo

    if (reported.includes(expected)) return;

    const detail = `${shipment.code} (${shipment.tracking}): esperado ${expected}, reportado ${reported.join(', ')}`;
    report.lockerMismatches.push(detail);
    console.warn(`[helga] el paquete no coincide con el casillero del trámite -> ${detail}`);
  },

  /**
   * Campos de medida a actualizar. Devuelve solo lo que CAMBIA: una escritura por
   * paquete y por corrida, cuando de verdad hay algo nuevo, en vez de una por
   * campo o una siempre.
   */
  measurementsPatch(
    shipment: { weightKg: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null; volumetricWeightKg: number | null },
    pkg: HelgaPackageStatus,
  ): Record<string, number> {
    const patch: Record<string, number> = {};

    const kg = toNumber(pkg.Peso_kg);
    // Se guarda el peso REAL que reporta el proveedor. El redondeo hacia arriba
    // es una regla de cobro y vive en el calculo del flete (`billableWeightKg`).
    if (kg > 0 && shipment.weightKg !== kg) patch.weightKg = kg;

    // Las dimensiones tampoco se tocan: son informativas y llegan como vienen.
    const dims = [
      ['lengthCm', toNumber(pkg.Largo_cm), shipment.lengthCm],
      ['widthCm', toNumber(pkg.Ancho_cm), shipment.widthCm],
      ['heightCm', toNumber(pkg.Alto_cm), shipment.heightCm],
      ['volumetricWeightKg', toNumber(pkg.Peso_volumen), shipment.volumetricWeightKg],
    ] as const;
    for (const [field, value, current] of dims) {
      // El proveedor manda 0 cuando no midio el paquete: no es una medida.
      if (value > 0 && current !== value) patch[field] = value;
    }

    return patch;
  },

  /**
   * Contenido, notas y HAWB que reporta el proveedor, solo lo que CAMBIA (mismo
   * criterio que `measurementsPatch`). Un valor vacio no borra el nuestro: que
   * el proveedor no lo mande no significa que el paquete no tenga contenido.
   *
   * El HAWB (LES) lo asigna la bodega del proveedor al recibir el paquete, asi
   * que el suyo es el que vale. Sin esto, un paquete que entro por prealerta
   * (flujo 1) se quedaba sin LES para siempre: solo el descubrimiento (op. E) lo
   * guardaba, y ese descarta los trackings que ya tenemos.
   *
   * La descripcion NO se toca: es nuestra (ver `shipments.schema`).
   */
  providerTextPatch(
    shipment: { content: string | null; notes: string | null; hawb: string | null },
    pkg: { contenido?: string; notas?: string | null; Sello?: string },
  ): { content?: string; notes?: string; hawb?: string } {
    const patch: { content?: string; notes?: string; hawb?: string } = {};
    const content = pkg.contenido?.trim();
    if (content && content !== shipment.content) patch.content = content;
    const notes = pkg.notas?.trim();
    if (notes && notes !== shipment.notes) patch.notes = notes;
    const hawb = pkg.Sello?.trim();
    if (hawb && hawb !== shipment.hawb) patch.hawb = hawb;
    return patch;
  },

  /**
   * Lleva el tramite hasta `target` recorriendo la ruta principal paso a paso.
   *
   * El proveedor puede saltarse tramos (su primer reporte a veces ya viene "EN
   * PLANILLA DE ENTREGA"), pero nuestra maquina exige secuencia estricta. Avanzar
   * de uno en uno respeta esa regla y deja en el historial los estados
   * intermedios, que es lo que el cliente ve como seguimiento.
   *
   * No manda correos: cada paso queda en el historial y el cliente lo recibe en
   * su CORREO DIARIO (decision P16), que lee ese historial.
   */
  async advanceTowards(
    session: Session,
    shipment: { id: string; state: State; shipmentType: ShipmentType; tracking: string; description: string },
    flow: Flow,
    target: State,
  ): Promise<number> {
    if (flow !== Flow.Paqueteria) return 0;

    const path = [
      State.Prealertado,
      State.RecibidoBodegaMiami,
      State.PreparandoEnvio,
      State.EnTransitoCostaRica,
      PROVIDER_LAST_STATE,
    ];

    const from = path.indexOf(shipment.state);
    const to = path.indexOf(target);
    // Estado anterior o fuera del tramo del proveedor: no se retrocede (decision 2).
    if (from < 0 || to <= from) return 0;

    let current = shipment.state;
    let moved = 0;

    for (const next of path.slice(from + 1, to + 1)) {
      if (!canTransition(flow, current, next)) break;
      await shipmentsRepo.transition(
        shipment.id,
        next,
        session.userId,
        'Actualizado desde el operador en Miami.',
      );
      current = next;
      moved += 1;
    }

    return moved;
  },
};
