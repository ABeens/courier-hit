ALTER TYPE "public"."service_value_type" ADD VALUE 'per_kg';--> statement-breakpoint
ALTER TYPE "public"."cost_line_source" ADD VALUE 'per_kg';--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD COLUMN "weight_kg" double precision;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD COLUMN "price_per_kg" double precision;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD COLUMN "weight_kg" double precision;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD COLUMN "price_per_kg" double precision;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_weight_positive" CHECK ("shipment_costs"."weight_kg" is null or "shipment_costs"."weight_kg" > 0);--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_price_per_kg_nonneg" CHECK ("shipment_costs"."price_per_kg" is null or "shipment_costs"."price_per_kg" >= 0);--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_weight_positive" CHECK ("proforma_costs"."weight_kg" is null or "proforma_costs"."weight_kg" > 0);--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_price_per_kg_nonneg" CHECK ("proforma_costs"."price_per_kg" is null or "proforma_costs"."price_per_kg" >= 0);