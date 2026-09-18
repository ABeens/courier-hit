CREATE TABLE "card_surcharge_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"percent" double precision NOT NULL,
	"fixed_usd" double precision NOT NULL,
	"previous_percent" double precision,
	"previous_fixed_usd" double precision,
	"note" text,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_surcharge_history_percent_range" CHECK ("card_surcharge_history"."percent" >= 0 AND "card_surcharge_history"."percent" < 100),
	CONSTRAINT "card_surcharge_history_fixed_nonneg" CHECK ("card_surcharge_history"."fixed_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "card_surcharge_percent" double precision;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "card_surcharge_fixed_usd" double precision;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "card_surcharge_set_by" uuid;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "card_surcharge_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "card_surcharge_history" ADD CONSTRAINT "card_surcharge_history_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_surcharge_history_set_at_idx" ON "card_surcharge_history" USING btree ("set_at");--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_card_surcharge_set_by_users_id_fk" FOREIGN KEY ("card_surcharge_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_card_surcharge_percent_range" CHECK ("app_settings"."card_surcharge_percent" IS NULL OR ("app_settings"."card_surcharge_percent" >= 0 AND "app_settings"."card_surcharge_percent" < 100));--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_card_surcharge_fixed_nonneg" CHECK ("app_settings"."card_surcharge_fixed_usd" IS NULL OR "app_settings"."card_surcharge_fixed_usd" >= 0);