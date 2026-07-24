ALTER TABLE "shipments" ADD COLUMN "helga_prealert_status" "helga_sync_status";--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "helga_prealert_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "helga_prealert_error" text;