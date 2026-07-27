CREATE TYPE "public"."provider_link_source" AS ENUM('registro', 'reconciliacion', 'manual');--> statement-breakpoint
CREATE TABLE "client_provider_link_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"source" "provider_link_source" NOT NULL,
	"status" "helga_sync_status" NOT NULL,
	"detail" text,
	"changes" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_provider_link_events" ADD CONSTRAINT "client_provider_link_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_provider_link_events" ADD CONSTRAINT "client_provider_link_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_provider_link_events_client_idx" ON "client_provider_link_events" USING btree ("client_id","created_at");