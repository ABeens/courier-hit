-- Contenido del paquete (`contenido` de Helga) y notas para el proveedor
-- (`notas` de la prealerta), separados de la descripcion del tramite.
ALTER TABLE "shipments" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "notes" text;--> statement-breakpoint
-- Hasta hoy la prealerta mandaba la descripcion como `contenido`, asi que eso es
-- lo que el proveedor tiene de cada paquete ya existente.
UPDATE "shipments" SET "content" = "description" WHERE "shipment_type" = 'paqueteria';
