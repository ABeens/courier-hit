CREATE TABLE "provider_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"account_code" text NOT NULL,
	"external_id" text NOT NULL,
	"hawb" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"shipment_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "provider_webhook_events" ADD CONSTRAINT "provider_webhook_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_webhook_events_queue_idx" ON "provider_webhook_events" USING btree ("received_at","id") WHERE "provider_webhook_events"."status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "provider_webhook_events_external_idx" ON "provider_webhook_events" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_events_hawb_idx" ON "provider_webhook_events" USING btree (upper("hawb"));