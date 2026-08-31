CREATE TYPE "public"."api_key_environment" AS ENUM('live', 'test');--> statement-breakpoint
CREATE TYPE "public"."api_key_revoke_reason" AS ENUM('manual', 'rotated');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" "api_key_environment" NOT NULL,
	"token_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_four" text NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "api_key_revoke_reason",
	"rotated_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_token_id_idx" ON "api_keys" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "api_keys_client_idx" ON "api_keys" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_active_idx" ON "api_keys" USING btree ("client_id") WHERE "api_keys"."revoked_at" is null;