CREATE TYPE "public"."delivery_outcome" AS ENUM('entregado', 'devuelto_bodega');--> statement-breakpoint
CREATE TYPE "public"."bank_account" AS ENUM('BAC', 'BCR');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('tarjeta', 'deposito_bancario');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pendiente', 'confirmado', 'rechazado');--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"outcome" "delivery_outcome" NOT NULL,
	"photo_file_key" text,
	"note" text,
	"courier_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pendiente' NOT NULL,
	"amount" double precision NOT NULL,
	"currency" "currency" NOT NULL,
	"exchange_rate" double precision NOT NULL,
	"bank_account" "bank_account",
	"receipt_number" text,
	"deposited_at" timestamp with time zone,
	"receipt_file_key" text,
	"gateway_reference" text,
	"note" text,
	"created_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_nonneg" CHECK ("payments"."amount" >= 0),
	CONSTRAINT "payments_rate_positive" CHECK ("payments"."exchange_rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "credit_limit" double precision;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "credit_limit_currency" "currency";--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_courier_id_users_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_shipment_idx" ON "delivery_attempts" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_shipment_idx" ON "payments" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" USING btree ("status");