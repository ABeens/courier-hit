-- Un intento de entrega pasa de UNA foto a hasta tres (MAX_DELIVERY_PHOTOS).
--
-- El array sustituye a la columna suelta en vez de convivir con ella: la prueba
-- de una entrega es el conjunto de fotos, y dos sitios donde mirarla acabaria
-- con lecturas que solo ven la primera. Lo que ya estaba se conserva como el
-- primer (y unico) elemento del array.
ALTER TABLE "delivery_attempts" ADD COLUMN "photo_file_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "delivery_attempts" SET "photo_file_keys" = ARRAY["photo_file_key"] WHERE "photo_file_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_attempts" DROP COLUMN "photo_file_key";
