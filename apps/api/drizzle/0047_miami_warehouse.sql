-- Direccion del casillero de HS Global en Miami, configurable en "Configuración".
-- `miami_warehouse` null = rige la de fabrica (MIAMI_WAREHOUSE en @courier/shared).
ALTER TABLE "app_settings" ADD COLUMN "miami_warehouse" jsonb;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "miami_warehouse_set_by" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "miami_warehouse_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_miami_warehouse_set_by_users_id_fk" FOREIGN KEY ("miami_warehouse_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;