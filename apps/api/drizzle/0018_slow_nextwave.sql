CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"exchange_rate" double precision,
	"exchange_rate_set_by" uuid,
	"exchange_rate_set_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_singleton" CHECK ("app_settings"."id" = 'global'),
	CONSTRAINT "app_settings_rate_positive" CHECK ("app_settings"."exchange_rate" IS NULL OR "app_settings"."exchange_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "exchange_rate_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rate" double precision NOT NULL,
	"previous_rate" double precision,
	"note" text,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rate_history_rate_positive" CHECK ("exchange_rate_history"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_exchange_rate_set_by_users_id_fk" FOREIGN KEY ("exchange_rate_set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rate_history" ADD CONSTRAINT "exchange_rate_history_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exchange_rate_history_set_at_idx" ON "exchange_rate_history" USING btree ("set_at");