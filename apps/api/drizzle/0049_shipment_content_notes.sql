-- Contenido (`contenido`) y notas (`notas`) del paquete segun Helga. Las dos
-- columnas las escribe solo la integracion con el proveedor.
ALTER TABLE "shipments" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "notes" text;
