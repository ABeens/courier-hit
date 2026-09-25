-- MODULO DE PROFORMAS, fase 5: correo diario al cliente (decision P16).
--
-- Se retiraron los avisos inmediatos por cambio de estado: todo sale en un
-- correo diario a la hora configurada (6:00 a. m. de Costa Rica por defecto).
-- `daily_digest_hour` null = vale el defecto. `daily_digest_last_run_at` (UTC) es
-- a la vez el candado de "ya se envio hoy" y el inicio de la ventana de cambios
-- del proximo correo.
ALTER TABLE "app_settings" ADD COLUMN "daily_digest_hour" integer;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "daily_digest_set_by" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "daily_digest_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "daily_digest_last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_daily_digest_set_by_users_id_fk" FOREIGN KEY ("daily_digest_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_daily_digest_hour_range" CHECK ("app_settings"."daily_digest_hour" IS NULL OR ("app_settings"."daily_digest_hour" >= 0 AND "app_settings"."daily_digest_hour" <= 23));