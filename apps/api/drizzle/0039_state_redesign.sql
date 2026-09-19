-- REDISENO DE ESTADOS (fase 2). Transporte pasa a entregar antes de cobrar y
-- Agenciamiento a cobrar la proforma antes de aduana; ninguno de los dos vuelve
-- a pasar por bodega ni por ruta de entrega, que quedan solo para Paqueteria.
--
-- Se hace con un CAMBIO DE TIPO y no con `ALTER TYPE ... ADD VALUE` a proposito:
-- Postgres no deja usar un valor recien agregado dentro de la misma transaccion,
-- y aqui hay que usarlos en el mismo paso (para remapear filas y para el indice
-- parcial). Renombrar el tipo viejo, crear el nuevo y convertir las columnas con
-- un USING deja todo en una sola transaccion, que es lo que se quiere: o entra
-- entero o no entra.
--
-- Lo que genera drizzle-kit por su cuenta para este cambio NO sirve: hace
-- DROP TYPE y vuelve a castear sin traducir nada, asi que cualquier fila en
-- 'pendiente_adelanto_impuestos' aborta la migracion.

-- El indice parcial nombra el estado terminal, asi que estorba para cambiar el
-- tipo. Se cae ahora y se reconstruye al final con los DOS cierres.
DROP INDEX "shipments_active_tracking";--> statement-breakpoint

ALTER TYPE "public"."shipment_state" RENAME TO "shipment_state_old";--> statement-breakpoint

CREATE TYPE "public"."shipment_state" AS ENUM('prealertado', 'facturacion_en_proceso', 'en_bodega_pendiente_pago', 'en_ruta_entrega', 'entregado', 'recoleccion_en_proceso', 'proceso_exportacion', 'en_transito_destino', 'arribo_destino', 'proceso_aduanas', 'liberado_aduanas', 'entregado_pendiente_pago', 'tramite_finalizado', 'revision_documentos', 'examen_previo', 'inspeccion_dekra', 'preparando_borrador_dua', 'proforma_pendiente_pago', 'aforando', 'recibido_bodega_miami', 'preparando_envio', 'en_transito_costa_rica', 'en_aduanas', 'devuelto_bodega');--> statement-breakpoint

-- ESTADO ACTUAL. Ademas del renombre, rescata a los tramites que quedarian en un
-- estado que su flujo ya no tiene: sin esto no podrian avanzar ni editarse (su
-- estado no esta en `statesOf(flow)`, asi que la maquina no les ofrece salida) y
-- solo un administrador podria sacarlos, uno por uno, con "Corregir estado".
--
-- El mapeo respeta lo que ya paso con el dinero:
--   - esperando pago  -> el estado donde AHORA se cobra ese flujo;
--   - ya pagado, sin cerrar -> el ultimo paso antes del cierre;
--   - entregado -> Tramite Finalizado.
-- Si la base se vacio antes (scripts/limpiar-tramites.ps1), esto no toca nada.
ALTER TABLE "public"."shipments" ALTER COLUMN "state" SET DATA TYPE "public"."shipment_state" USING (
  CASE
    WHEN "state"::text = 'pendiente_adelanto_impuestos' THEN 'proforma_pendiente_pago'

    -- Transporte: cobra en "Facturacion en proceso" (ahi factura y cobra).
    WHEN "shipment_type" IN ('aereo', 'maritimo_fcl', 'maritimo_lcl') AND "state"::text = 'en_bodega_pendiente_pago' THEN 'facturacion_en_proceso'
    WHEN "shipment_type" IN ('aereo', 'maritimo_fcl', 'maritimo_lcl') AND "state"::text = 'en_ruta_entrega' THEN 'facturacion_en_proceso'
    WHEN "shipment_type" IN ('aereo', 'maritimo_fcl', 'maritimo_lcl') AND "state"::text = 'entregado' THEN 'tramite_finalizado'

    -- Agenciamiento: cobra la proforma, y su ultimo paso antes del cierre es
    -- "Liberado de Aduanas".
    WHEN "shipment_type" = 'agenciamiento' AND "state"::text = 'en_bodega_pendiente_pago' THEN 'proforma_pendiente_pago'
    WHEN "shipment_type" = 'agenciamiento' AND "state"::text = 'en_ruta_entrega' THEN 'liberado_aduanas'
    WHEN "shipment_type" = 'agenciamiento' AND "state"::text = 'entregado' THEN 'tramite_finalizado'

    ELSE "state"::text
  END
)::"public"."shipment_state";--> statement-breakpoint

-- HISTORIAL. Aqui solo se aplica el RENOMBRE. El resto se deja tal cual a
-- proposito: un asiento dice por donde paso el tramite de verdad, y reescribirlo
-- para que encaje con el flujo nuevo seria mentir sobre lo que ocurrio. Los
-- valores viejos siguen existiendo en el tipo (Paqueteria los usa), asi que el
-- historial de Transporte y Agenciamiento se lee igual que siempre.
ALTER TABLE "public"."shipment_events" ALTER COLUMN "state" SET DATA TYPE "public"."shipment_state" USING (
  CASE
    WHEN "state"::text = 'pendiente_adelanto_impuestos' THEN 'proforma_pendiente_pago'
    ELSE "state"::text
  END
)::"public"."shipment_state";--> statement-breakpoint

DROP TYPE "public"."shipment_state_old";--> statement-breakpoint

-- Un tracking activo no se repite, pero SI puede repetirse historicamente. Ahora
-- son dos los estados que dan por cerrado un tramite: sin 'tramite_finalizado'
-- aqui, la guia de un trámite de Transporte o Agenciamiento ya cerrado quedaria
-- reservada para siempre. El test "los estados de cierre son los que el indice de
-- tracking da por terminados" (machine.test.ts) vigila que esta lista no se quede
-- vieja.
CREATE UNIQUE INDEX "shipments_active_tracking" ON "shipments" USING btree ("tracking") WHERE "shipments"."state" not in ('entregado', 'tramite_finalizado') and "shipments"."discarded_at" is null;
