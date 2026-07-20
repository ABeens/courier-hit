CREATE TYPE "public"."cost_line_source" AS ENUM('freight', 'service', 'percentage');--> statement-breakpoint
CREATE TABLE "shipment_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"cost_service_id" uuid,
	"label" text NOT NULL,
	"source" "cost_line_source" NOT NULL,
	"percentage" double precision,
	"amount" double precision NOT NULL,
	"currency" "currency" NOT NULL,
	"exchange_rate" double precision NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_costs_amount_nonneg" CHECK ("shipment_costs"."amount" >= 0),
	CONSTRAINT "shipment_costs_rate_positive" CHECK ("shipment_costs"."exchange_rate" > 0),
	CONSTRAINT "shipment_costs_percentage_range" CHECK ("shipment_costs"."percentage" is null or ("shipment_costs"."percentage" >= 0 and "shipment_costs"."percentage" <= 100))
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "invoice_total_usd" double precision;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "invoice_total_crc" double precision;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "costs_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "costs_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_cost_service_id_cost_services_id_fk" FOREIGN KEY ("cost_service_id") REFERENCES "public"."cost_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_costs_shipment_idx" ON "shipment_costs" USING btree ("shipment_id","created_at");--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_costs_approved_by_users_id_fk" FOREIGN KEY ("costs_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;