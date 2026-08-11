CREATE TYPE "public"."cost_category" AS ENUM('flete', 'impuestos', 'otros', 'propio');--> statement-breakpoint
CREATE TABLE "freight_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usd_per_lb" double precision NOT NULL,
	"previous_usd_per_lb" double precision,
	"note" text,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "freight_rate_history_positive" CHECK ("freight_rate_history"."usd_per_lb" > 0)
);
--> statement-breakpoint
ALTER TABLE "cost_services" ADD COLUMN "category" "cost_category" DEFAULT 'otros' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_services" ADD COLUMN "electronic_invoice_code" text;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD COLUMN "category" "cost_category" DEFAULT 'otros' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD COLUMN "electronic_invoice_code" text;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "freight_rate_usd_per_lb" double precision;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "freight_rate_set_by" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "freight_rate_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "electronic_invoice_number" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "freight_rate_usd_per_lb" double precision;--> statement-breakpoint
ALTER TABLE "freight_rate_history" ADD CONSTRAINT "freight_rate_history_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "freight_rate_history_set_at_idx" ON "freight_rate_history" USING btree ("set_at");--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_freight_rate_set_by_users_id_fk" FOREIGN KEY ("freight_rate_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_freight_rate_positive" CHECK ("app_settings"."freight_rate_usd_per_lb" IS NULL OR "app_settings"."freight_rate_usd_per_lb" > 0);