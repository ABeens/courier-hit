/**
 * Armado de los BORRADORES de proforma (docs/proformas-cambios.html, area 2).
 *
 * Reemplaza a la facturacion automatica anterior (OPS-003), que al recibir un
 * paquete le cotizaba el flete, APROBABA la factura y lo movia a cobro sin que
 * nadie lo mirara. El SOW de proformas elimino eso: toda proforma nace en
 * borrador y la aprueba una persona. Lo que se conservo es la mitad util, el
 * calculo: "calcular si, aprobar no" (decision P11).
 *
 * Tres reglas, las tres del negocio:
 *
 * 1. PAQUETERIA AGRUPA SOLA. Al entrar a "Facturacion en proceso", el paquete cae
 *    en el borrador que acumula de su cliente (se abre uno si no hay) y se le
 *    calcula el flete como una linea mas. No se aprueba ni se mueve de estado.
 * 2. TRANSPORTE Y AGENCIAMIENTO NO AGRUPAN. Cada tramite abre su propio borrador;
 *    juntarlos es una accion manual del operador. No hay flete que calcular: ahi
 *    todo el importe se digita.
 * 3. EL FLETE SIGUE AL PAQUETE MIENTRAS ES BORRADOR. Si cambia el peso o el dueño
 *    (y con el la tarifa), el flete se recalcula. Una vez aprobada la proforma la
 *    factura esta congelada y aqui no se toca nada.
 *
 * Como antes, NADA de esto es un error del usuario: recibir un paquete nunca
 * falla por no poder armarle el borrador. Si falta el peso, la tarifa o la tasa
 * de cambio, el paquete entra al borrador sin flete y el operador lo completa.
 *
 * Vive en su propio modulo y no depende de `transitions.service` ni de
 * `shipments.service`: los dos lo llaman, y colgarlo de cualquiera crearia un
 * ciclo de imports.
 */
import {
  Flow,
  categoryForLine,
  costLineExchangeRateSchema,
  flowForType,
  canChooseProformaCurrency,
  groupsAutomatically,
  initialProformaCurrency,
  isProformaEditable,
} from '@courier/shared';
import type { Session, ShipmentType } from '@courier/shared';
import { costsRepo } from '../costs/costs.repo';
import { catalogCurrency } from '../costs/costs.service';
import { buildFreight } from '../costs/freight';
import { settingsRepo } from '../settings/settings.repo';
import { proformasRepo } from './proformas.repo';

/** Lo que hace falta del tramite para armarle el borrador. */
export interface DraftSubject {
  id: string;
  clientId: string | null;
  shipmentType: ShipmentType;
  weightKg: number | null;
  /** Factura congelada: con ella ya no se recalcula nada. */
  costsApprovedAt: Date | null;
}

/** Por que no se pudo calcular el flete de un paquete en borrador. */
export type FreightMissing = 'sin_peso' | 'sin_tarifa' | 'sin_tasa';

/**
 * Resultado de `refreshFreight`: `priced` si quedo con flete, el motivo si no se
 * pudo, y `not_applicable` si el paquete no lleva flete recalculable (otro flujo,
 * sin dueño, factura congelada o fuera de un borrador).
 */
export type FreightOutcome = 'priced' | FreightMissing | 'not_applicable';

/** Resumen de una corrida de `reconcileMissingFreight`. */
export type FreightReconcileReport = { checked: number; priced: number } & Record<FreightMissing, number>;

/** Paquetes por corrida del robot: acota la pasada si se acumularan muchos. */
const RECONCILE_BATCH = 200;

/**
 * Tasa con la que se guarda la linea de flete: la que ya tienen las demas
 * lineas del tramite (todas comparten una, ver `costsService.save`) o, si es la
 * primera, la vigente del sistema. `null` si no hay ninguna valida: sin testigo
 * de conversion no se guarda un monto (regla M5).
 */
async function freightExchangeRate(shipmentId: string): Promise<number | null> {
  const [saved] = await costsRepo.listLines(shipmentId);
  const candidate = saved?.exchangeRate ?? (await settingsRepo.currentExchangeRate());
  const checked = costLineExchangeRateSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

export const proformaDraftsService = {
  /**
   * El tramite entro a "Facturacion en proceso": ponerlo en su borrador.
   *
   * Si ya esta en una proforma no se hace nada. Pasa cuando vuelve a facturacion
   * por una correccion: su proforma ya existe (y puede tener numero), y moverlo a
   * otra seria perder el rastro de a cual pertenecia.
   *
   * Un tramite sin dueño tampoco entra: no hay a quien facturarle. Entra cuando
   * se le asigna (`onOwnerChanged`).
   */
  async onEnterBilling(session: Session, shipment: DraftSubject): Promise<void> {
    if (shipment.clientId === null) return;
    if (await proformasRepo.findByShipment(shipment.id)) return;

    const flow = flowForType(shipment.shipmentType);
    /**
     * Moneda con la que nace: en Transporte y Agenciamiento, la que propone su
     * catalogo de servicios; el operador la cambia al cargar los costos. En
     * Paqueteria no se consulta nada: es dolares siempre.
     */
    const proposed = canChooseProformaCurrency(flow) ? await catalogCurrency(flow) : null;
    const key = {
      clientId: shipment.clientId,
      flow,
      currency: initialProformaCurrency(shipment.shipmentType, proposed),
    };

    const draft = groupsAutomatically(flow)
      ? await proformasRepo.openAccumulatingDraft(key, session.userId)
      : await proformasRepo.createDraft(key, session.userId);

    await proformasRepo.attachShipment(draft.id, shipment.id, session.userId);
    await this.refreshFreight(session, shipment);
  },

  /**
   * Recalcula la linea de flete del paquete, si todavia se puede.
   *
   * Solo Paqueteria (es el unico flujo con flete por kilo), solo con la factura
   * sin congelar y solo dentro de un borrador. Fuera de esas tres condiciones el
   * flete ya es historia y recalcularlo cambiaria un cobro que alguien aprobo.
   *
   * Reemplaza unicamente la linea de flete: los servicios que el operador cargo
   * a mano se quedan. Sin peso (o sin tarifa) se quita el flete: un monto que ya
   * no se puede justificar no deberia seguir en el borrador.
   */
  async refreshFreight(
    session: Session,
    shipment: DraftSubject,
    options: { quiet?: boolean } = {},
  ): Promise<FreightOutcome> {
    if (flowForType(shipment.shipmentType) !== Flow.Paqueteria) return 'not_applicable';
    if (shipment.clientId === null || shipment.costsApprovedAt !== null) return 'not_applicable';

    const proforma = await proformasRepo.findByShipment(shipment.id);
    if (!proforma || !isProformaEditable(proforma.status)) return 'not_applicable';

    /**
     * Las tres faltas dejan el paquete en el borrador con $0, y antes lo hacian
     * en silencio: nadie se enteraba hasta abrir los costos y guardar a mano. Se
     * avisan en el log con su motivo. `quiet` lo usa el robot, que repasa los
     * mismos paquetes cada corrida y resume los motivos en una sola linea.
     */
    const missing = (reason: FreightMissing): FreightMissing => {
      if (!options.quiet) {
        console.warn(`[proformas] flete sin calcular (${reason}) para el trámite ${shipment.id}.`);
      }
      return reason;
    };

    const freight = await buildFreight({ clientId: shipment.clientId, weightKg: shipment.weightKg });
    if (!freight) {
      await costsRepo.replaceFreightLine(shipment.id, null);
      // `buildFreight` devuelve null por falta de peso o de tarifa: el peso se
      // mira aqui para poder decir cual de las dos fue.
      return missing(shipment.weightKg ? 'sin_tarifa' : 'sin_peso');
    }

    const exchangeRate = await freightExchangeRate(shipment.id);
    // Sin tasa valida el flete no se puede guardar (M5). El borrador sigue, sin
    // flete, y el operador lo completa cuando haya tasa.
    if (exchangeRate === null) return missing('sin_tasa');

    await costsRepo.replaceFreightLine(shipment.id, {
      shipmentId: shipment.id,
      costServiceId: null,
      label: freight.label,
      category: categoryForLine(freight.source, null),
      electronicInvoiceCode: null,
      source: freight.source,
      percentage: null,
      amount: freight.amount,
      currency: freight.currency,
      exchangeRate,
      createdBy: session.userId,
    });
    return 'priced';
  },

  /**
   * Red de seguridad del robot: recalcula el flete de los paquetes que estan en
   * un borrador SIN linea de flete.
   *
   * El flete se calcula al entrar a facturacion y cuando cambia el peso o el
   * dueño. Si en ese momento faltaba algo (peso, tarifa o tasa), el paquete
   * quedaba en $0 hasta que alguien abriera sus costos y guardara a mano, aunque
   * el dato faltante llegara despues por otro camino. Aqui se reintenta: los que
   * ya se pueden cotizar quedan con su flete, y los demas se cuentan por motivo.
   *
   * Solo toca paquetes SIN flete: uno con flete (calculado o ajustado a mano por
   * el operador) se respeta tal cual.
   */
  async reconcileMissingFreight(session: Session): Promise<FreightReconcileReport> {
    const report: FreightReconcileReport = { checked: 0, priced: 0, sin_peso: 0, sin_tarifa: 0, sin_tasa: 0 };
    for (const shipment of await proformasRepo.draftPackagesWithoutFreight(RECONCILE_BATCH)) {
      report.checked += 1;
      try {
        const outcome = await this.refreshFreight(session, shipment, { quiet: true });
        if (outcome !== 'not_applicable') report[outcome] += 1;
      } catch (err) {
        // Un paquete con problemas no frena a los demas.
        console.error(`[proformas] no se pudo recalcular el flete del trámite ${shipment.id}:`, err);
      }
    }
    return report;
  },

  /**
   * El tramite SALIO de "Facturacion en proceso" por una correccion de estado
   * (hacia atras o saltando). Si sigue en un BORRADOR se saca de ahi: un borrador
   * con un tramite fuera de facturacion no se podria aprobar. Si vuelve a
   * facturacion, `onEnterBilling` lo pone de nuevo en el borrador del cliente.
   *
   * Con la factura congelada o la proforma ya aprobada no se toca nada: eso se
   * deshace corrigiendo la proforma, no el estado del tramite.
   */
  async onLeaveBilling(shipment: DraftSubject): Promise<void> {
    if (shipment.costsApprovedAt !== null) return;
    const proforma = await proformasRepo.findByShipment(shipment.id);
    if (!proforma || !isProformaEditable(proforma.status)) return;
    const from = await proformasRepo.detachShipment(shipment.id);
    if (from) await proformasRepo.deleteIfEmptyDraft(from);
  },

  /**
   * El tramite cambio de dueño: sacarlo del borrador del dueño anterior y, si esta
   * en facturacion, ponerlo en el del nuevo con el flete de SU tarifa.
   *
   * Tambien entra al del nuevo si venia de un borrador sin estar en facturacion:
   * es un paquete ya entregado de una proforma corregida. Si no, se quedaria sin
   * proforma y nadie se lo cobraria al dueño correcto.
   *
   * El borrador de origen se borra si quedo vacio y nunca se numero: no hay nada
   * que mostrarle a nadie. Quien llama ya comprobo que el tramite se podia
   * reasignar (sin factura congelada ni pagos).
   */
  async onOwnerChanged(
    session: Session,
    shipment: DraftSubject,
    inBilling: boolean,
  ): Promise<void> {
    const from = await proformasRepo.detachShipment(shipment.id);
    if (from) await proformasRepo.deleteIfEmptyDraft(from);

    if (inBilling || from) await this.onEnterBilling(session, shipment);
  },
};
