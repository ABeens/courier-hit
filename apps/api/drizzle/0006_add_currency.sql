CREATE TYPE "public"."currency" AS ENUM('CRC', 'USD');--> statement-breakpoint
-- cost_services: la moneda solo aplica al monto fijo; queda NULL en porcentaje/manual.
ALTER TABLE "cost_services" ADD COLUMN "currency" "currency";--> statement-breakpoint
-- Backfill: los montos fijos existentes se mostraban en dolares ($), se fijan en USD.
UPDATE "cost_services" SET "currency" = 'USD' WHERE "value_type" = 'fixed' AND "currency" IS NULL;--> statement-breakpoint
-- client_rates: se agrega nullable, se backfillea a USD y recien despues se fuerza NOT NULL.
ALTER TABLE "client_rates" ADD COLUMN "currency" "currency";--> statement-breakpoint
UPDATE "client_rates" SET "currency" = 'USD' WHERE "currency" IS NULL;--> statement-breakpoint
ALTER TABLE "client_rates" ALTER COLUMN "currency" SET NOT NULL;
