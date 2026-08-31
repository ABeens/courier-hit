CREATE TYPE "public"."client_rate_kind" AS ENUM('estandar', 'consolidada');--> statement-breakpoint
CREATE TABLE "payment_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"client_rate_id" uuid,
	"method" "payment_method" NOT NULL,
	"amount" double precision NOT NULL,
	"currency" "currency" NOT NULL,
	"exchange_rate" double precision NOT NULL,
	"gateway_reference" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_groups_amount_nonneg" CHECK ("payment_groups"."amount" >= 0),
	CONSTRAINT "payment_groups_rate_positive" CHECK ("payment_groups"."exchange_rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "weight_kg" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "client_rates" ADD COLUMN "kind" "client_rate_kind" DEFAULT 'estandar' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_groups" ADD CONSTRAINT "payment_groups_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_groups" ADD CONSTRAINT "payment_groups_client_rate_id_client_rates_id_fk" FOREIGN KEY ("client_rate_id") REFERENCES "public"."client_rates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_groups" ADD CONSTRAINT "payment_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_groups_client_idx" ON "payment_groups" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_groups_gateway_reference_idx" ON "payment_groups" USING btree ("gateway_reference") WHERE "payment_groups"."gateway_reference" is not null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_group_id_payment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."payment_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_group_idx" ON "payments" USING btree ("group_id");