-- Costo real de cada linea, al lado del costo facturado (`amount`). Null = igual
-- al facturado, asi que las lineas existentes no necesitan backfill.
ALTER TABLE "shipment_costs" ADD COLUMN "real_amount" double precision;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD COLUMN "real_amount" double precision;--> statement-breakpoint
ALTER TABLE "shipment_costs" ADD CONSTRAINT "shipment_costs_real_amount_nonneg" CHECK ("shipment_costs"."real_amount" is null or "shipment_costs"."real_amount" >= 0);--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_real_amount_nonneg" CHECK ("proforma_costs"."real_amount" is null or "proforma_costs"."real_amount" >= 0);