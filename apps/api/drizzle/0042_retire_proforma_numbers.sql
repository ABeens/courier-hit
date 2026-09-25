-- MODULO DE PROFORMAS, fase 2: se retira la serie vieja.
--
-- `proforma_numbers` numeraba la proforma AL IMPRIMIRLA, un documento por tramite
-- (y otro por cobro consolidado), con una secuencia que podia dejar huecos. La
-- reemplaza el numero de la tabla `proformas`, asignado AL APROBAR desde el
-- contador `proforma_counter` (0041). No hay produccion: los numeros viejos no se
-- conservan.
DROP TABLE "proforma_numbers" CASCADE;--> statement-breakpoint
DROP SEQUENCE "public"."hs_proforma_number_seq";