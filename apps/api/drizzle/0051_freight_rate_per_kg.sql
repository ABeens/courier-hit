-- La tarifa de transporte internacional pasa de USD por libra a USD por kg y se
-- aplica directo al peso en kg (sin el factor 2.204). Solo se renombran las
-- columnas: los valores guardados se leen tal cual como USD por kg. Los CHECK
-- siguen a la columna renombrada.
ALTER TABLE "app_settings" RENAME COLUMN "freight_rate_usd_per_lb" TO "freight_rate_usd_per_kg";--> statement-breakpoint
ALTER TABLE "shipments" RENAME COLUMN "freight_rate_usd_per_lb" TO "freight_rate_usd_per_kg";--> statement-breakpoint
ALTER TABLE "freight_rate_history" RENAME COLUMN "usd_per_lb" TO "usd_per_kg";--> statement-breakpoint
ALTER TABLE "freight_rate_history" RENAME COLUMN "previous_usd_per_lb" TO "previous_usd_per_kg";
