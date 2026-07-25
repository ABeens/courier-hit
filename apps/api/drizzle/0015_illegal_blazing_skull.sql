ALTER TABLE "shipments" ADD COLUMN "declared_value_usd" double precision;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "insured_value_usd" double precision;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "tariff_position" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "retain" boolean;