CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"oauth_client_id" text,
	"oauth_client_secret_encrypted" text,
	"app_id" text,
	"provider_customer_id" integer,
	"consolidated_client_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"last_import_at" timestamp with time zone,
	"last_import_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "provider_account_code" text;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_consolidated_client_id_clients_id_fk" FOREIGN KEY ("consolidated_client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_code_idx" ON "provider_accounts" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_client_idx" ON "provider_accounts" USING btree ("consolidated_client_id");