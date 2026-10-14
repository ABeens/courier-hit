-- Un tramite pasa de UN documento a hasta diez (MAX_SHIPMENT_DOCUMENTS).
--
-- El array sustituye a la columna suelta en vez de convivir con ella, igual que
-- se hizo con las fotos de entrega: dos sitios donde mirar acabaria con lecturas
-- que solo ven el primero. Lo que ya estaba se conserva como el primer (y unico)
-- elemento del array.
ALTER TABLE "shipments" ADD COLUMN "document_file_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "shipments" SET "document_file_keys" = ARRAY["document_file_key"] WHERE "document_file_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "document_file_key";
