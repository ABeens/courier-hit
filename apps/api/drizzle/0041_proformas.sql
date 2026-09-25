-- MODULO DE PROFORMAS, fase 1 (docs/proformas-cambios.html, areas 1 a 3).
--
-- La proforma pasa a ser un registro: el grupo de tramites de un cliente que se
-- revisa, se aprueba, se cobra y se entrega como una unidad. Cuatro tablas nuevas
-- (proformas, proforma_shipments, proforma_costs, proforma_counter).
--
-- El numero de proforma sale de un CONTADOR en tabla, no de una secuencia: una
-- secuencia deja huecos (nextval no se deshace) y la serie tiene que ser
-- continua. La tabla vieja `proforma_numbers` y su secuencia se retiran en la
-- fase 2, junto con el documento que las usa.
--
-- Se elimina `client_rates.requires_billing_review`: la facturacion automatica
-- que leia esa marca se retiro. Toda proforma la aprueba una persona.
--
-- No mueve datos: los tramites que ya estaban en facturacion antes de esta
-- migracion no entran a ningun borrador solos (no hay produccion).
CREATE TYPE "public"."proforma_status" AS ENUM('borrador', 'aprobada', 'pagada');--> statement-breakpoint
CREATE TYPE "public"."shipment_flow" AS ENUM('paqueteria', 'transporte', 'agenciamiento');--> statement-breakpoint
CREATE TABLE "proforma_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proforma_id" uuid NOT NULL,
	"cost_service_id" uuid,
	"label" text NOT NULL,
	"category" "cost_category" DEFAULT 'otros' NOT NULL,
	"electronic_invoice_code" text,
	"source" "cost_line_source" NOT NULL,
	"percentage" double precision,
	"amount" double precision NOT NULL,
	"currency" "currency" NOT NULL,
	"exchange_rate" double precision NOT NULL,
	"payment_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proforma_costs_amount_nonneg" CHECK ("proforma_costs"."amount" >= 0),
	CONSTRAINT "proforma_costs_rate_positive" CHECK ("proforma_costs"."exchange_rate" > 0),
	CONSTRAINT "proforma_costs_percentage_range" CHECK ("proforma_costs"."percentage" is null or ("proforma_costs"."percentage" >= 0 and "proforma_costs"."percentage" <= 100))
);
--> statement-breakpoint
CREATE TABLE "proforma_counter" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proforma_counter_singleton" CHECK ("proforma_counter"."id" = 'global'),
	CONSTRAINT "proforma_counter_positive" CHECK ("proforma_counter"."next_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "proforma_shipments" (
	"shipment_id" uuid PRIMARY KEY NOT NULL,
	"proforma_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proformas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"flow" "shipment_flow" NOT NULL,
	"currency" "currency" NOT NULL,
	"status" "proforma_status" DEFAULT 'borrador' NOT NULL,
	"accumulates" boolean DEFAULT false NOT NULL,
	"number" integer,
	"exchange_rate" double precision,
	"total_usd" double precision,
	"total_crc" double precision,
	"electronic_invoice_number" text,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proformas_approved_frozen" CHECK ("proformas"."status" = 'borrador' or ("proformas"."number" is not null and "proformas"."exchange_rate" is not null and "proformas"."total_usd" is not null and "proformas"."total_crc" is not null and "proformas"."approved_at" is not null)),
	CONSTRAINT "proformas_accumulates_draft" CHECK (not "proformas"."accumulates" or "proformas"."status" = 'borrador'),
	CONSTRAINT "proformas_rate_positive" CHECK ("proformas"."exchange_rate" is null or "proformas"."exchange_rate" > 0),
	CONSTRAINT "proformas_totals_nonneg" CHECK (("proformas"."total_usd" is null or "proformas"."total_usd" >= 0) and ("proformas"."total_crc" is null or "proformas"."total_crc" >= 0)),
	CONSTRAINT "proformas_number_positive" CHECK ("proformas"."number" is null or "proformas"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_proforma_id_proformas_id_fk" FOREIGN KEY ("proforma_id") REFERENCES "public"."proformas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_cost_service_id_cost_services_id_fk" FOREIGN KEY ("cost_service_id") REFERENCES "public"."cost_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_costs" ADD CONSTRAINT "proforma_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_shipments" ADD CONSTRAINT "proforma_shipments_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_shipments" ADD CONSTRAINT "proforma_shipments_proforma_id_proformas_id_fk" FOREIGN KEY ("proforma_id") REFERENCES "public"."proformas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_shipments" ADD CONSTRAINT "proforma_shipments_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proformas" ADD CONSTRAINT "proformas_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proforma_costs_proforma_idx" ON "proforma_costs" USING btree ("proforma_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proforma_costs_payment_idx" ON "proforma_costs" USING btree ("proforma_id","payment_id") WHERE "proforma_costs"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "proforma_shipments_proforma_idx" ON "proforma_shipments" USING btree ("proforma_id");--> statement-breakpoint
CREATE INDEX "proformas_client_idx" ON "proformas" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "proformas_status_idx" ON "proformas" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proformas_number_idx" ON "proformas" USING btree ("number") WHERE "proformas"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "proformas_one_accumulating_idx" ON "proformas" USING btree ("client_id","flow","currency") WHERE "proformas"."accumulates" and "proformas"."status" = 'borrador';--> statement-breakpoint
ALTER TABLE "client_rates" DROP COLUMN "requires_billing_review";