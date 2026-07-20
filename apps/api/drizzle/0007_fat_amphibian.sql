CREATE TYPE "public"."client_review_status" AS ENUM('nuevo', 'revisado');--> statement-breakpoint
-- Los campos nuevos del casillero (cedula, direccion de entrega en Costa Rica)
-- se agregan NULLABLE, se backfillean y recien despues se fuerzan NOT NULL: de
-- otro modo la migracion falla en cuanto exista un solo casillero previo.
ALTER TABLE "clients" ADD COLUMN "id_number" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "province_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "canton_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "district_code" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "review_status" "client_review_status" DEFAULT 'nuevo' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "client_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "helga_client_id" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "helga_synced_at" timestamp with time zone;--> statement-breakpoint
-- Backfill de los casilleros anteriores al requerimiento. No inventamos datos
-- validos: se marcan como pendientes y quedan en review_status = 'nuevo' (el
-- default de la columna) para que un administrador los complete.
-- La cedula lleva el id de la fila para no violar el UNIQUE.
UPDATE "clients" SET "id_number" = 'PENDIENTE-' || "id"::text WHERE "id_number" IS NULL;--> statement-breakpoint
-- Terna territorial provisional: San José / San José / Carmen (codigos INEC).
UPDATE "clients" SET "province_code" = '1', "canton_code" = '101', "district_code" = '10101' WHERE "province_code" IS NULL;--> statement-breakpoint
UPDATE "clients" SET "address_line" = 'Pendiente de actualizar' WHERE "address_line" IS NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "id_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "province_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "canton_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "district_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "address_line" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_client_rate_id_client_rates_id_fk" FOREIGN KEY ("client_rate_id") REFERENCES "public"."client_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_id_number_unique" UNIQUE("id_number");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_helga_client_id_unique" UNIQUE("helga_client_id");--> statement-breakpoint
-- Los casilleros existentes quedan en la tarifa por defecto del sistema, que es
-- la misma regla que aplica a los nuevos.
UPDATE "clients" SET "client_rate_id" = (SELECT "id" FROM "client_rates" WHERE "is_default" LIMIT 1) WHERE "client_rate_id" IS NULL;
