CREATE TYPE "public"."helga_sync_status" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "helga_sync_status" "helga_sync_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "helga_sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "helga_last_error" text;--> statement-breakpoint
-- Backfill: los casilleros que ya tienen enlace con el proveedor quedan
-- 'synced' (con 1 intento efectivo); el resto conserva el default 'pending'
-- para que la reconciliacion los tome cuando la integracion este encendida.
UPDATE "clients" SET "helga_sync_status" = 'synced', "helga_sync_attempts" = 1 WHERE "helga_client_id" IS NOT NULL;