/**
 * Automatizaciones de correo (docs/manuales/flujo.md, "AUTOMATIZACIONES DEL
 * SISTEMA", L173-207).
 *
 * Las plantillas son las del manual, literales. Los DESTINATARIOS y el CUANDO no
 * se deciden aqui: salen de la maquina de estados. Un estado dispara correo si su
 * step declara `Trigger.NotifyStateChange`, y entra al resumen diario si declara
 * `Trigger.DailyActiveSummary`. Por eso este modulo no tiene ninguna lista de
 * estados: preguntarle a `triggersOnEnter` es lo que evita que la matriz de
 * automatizaciones viva en dos sitios y se desincronice.
 */
import { STATE_LABELS, Trigger, flowForType, triggersOnEnter } from '@courier/shared';
import type { ShipmentType, State } from '@courier/shared';
import { mailer } from '../../core/mailer';
import { notificationsRepo } from './notifications.repo';

/** Datos del tramite que necesitan las plantillas. */
export interface NotifiableShipment {
  id: string;
  shipmentType: ShipmentType;
  tracking: string;
  description: string;
}

export const notificationsService = {
  /**
   * Aviso inmediato de cambio de estado al dueño del paquete. Se llama SIEMPRE
   * que un tramite cambia de estado; el filtro de "¿este estado avisa?" lo hace
   * la maquina, no quien llama. Asi ningun punto de transicion tiene que recordar
   * la lista de estados notificables.
   */
  async onStateChange(shipment: NotifiableShipment, state: State): Promise<void> {
    const flow = flowForType(shipment.shipmentType);
    if (!triggersOnEnter(flow, state).includes(Trigger.NotifyStateChange)) return;

    const recipient = await notificationsRepo.ownerOf(shipment.id);
    if (!recipient) return;

    const stateLabel = STATE_LABELS[state];
    await mailer.send({
      to: recipient.email,
      subject: `Actualización de su paquete ${shipment.tracking}: ${stateLabel}`,
      body: [
        `Estimado(a) ${recipient.name}:`,
        '',
        `Le informamos que el estado de su paquete ${shipment.tracking} – ${shipment.description} ha sido actualizado a:`,
        '',
        stateLabel,
        '',
        'Puede ingresar a nuestro sistema con sus credenciales para consultar los detalles completos de su envío.',
        'Si tiene alguna consulta, no dude en contactarnos.',
        '',
        'Saludos cordiales,',
        'Equipo HS Global',
      ].join('\n'),
    });
  },

  /**
   * Resumen diario de tramites de Transporte y Agenciamiento activos: un correo
   * por cliente con todos sus tramites (el manual pide "un correo donde indique
   * el estado del trámite", agrupado por cliente).
   *
   * Devuelve cuantos correos salieron para que quien lo dispare lo pueda registrar.
   *
   * TODO(despliegue): programar esta funcion una vez al dia. Hoy se invoca a mano
   * desde `POST /notifications/daily-summary` (permiso config.manage) para poder
   * probarla; en AWS sera un EventBridge -> tarea programada.
   */
  async sendDailySummary(): Promise<{ sent: number }> {
    const rows = await notificationsRepo.activeTransportShipments();

    // Agrupar por cliente: el manual pide UN correo por cliente con la lista de
    // sus tramites, no un correo por tramite.
    const byClient = new Map<string, { name: string; email: string; lines: string[] }>();
    for (const row of rows) {
      const flow = flowForType(row.shipmentType);
      if (!triggersOnEnter(flow, row.state).includes(Trigger.DailyActiveSummary)) continue;

      const entry = byClient.get(row.email) ?? { name: row.name, email: row.email, lines: [] };
      entry.lines.push(
        `- Trámite ${row.code} – ${row.description} — Estado actual: ${STATE_LABELS[row.state]}`,
      );
      byClient.set(row.email, entry);
    }

    for (const client of byClient.values()) {
      await mailer.send({
        to: client.email,
        subject: 'Estado de sus trámites de transporte y agenciamiento',
        body: [
          `Estimado(a) ${client.name}:`,
          '',
          'Le compartimos la actualización diaria de sus trámites de transporte y agenciamiento activos:',
          '',
          ...client.lines,
          '',
          'Puede ingresar a nuestro sistema con sus credenciales para consultar el detalle completo y el avance de cada trámite.',
          'Si tiene alguna consulta, no dude en contactarnos.',
          '',
          'Saludos cordiales,',
          'Equipo HS Global',
        ].join('\n'),
      });
    }

    return { sent: byClient.size };
  },
};
