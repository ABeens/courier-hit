CREATE TYPE "public"."announcement_type" AS ENUM('informativo', 'advertencia', 'critico');--> statement-breakpoint
CREATE TYPE "public"."shipment_state" AS ENUM('prealertado', 'facturacion_en_proceso', 'en_bodega_pendiente_pago', 'en_ruta_entrega', 'entregado', 'recoleccion_en_proceso', 'proceso_exportacion', 'en_transito_destino', 'arribo_destino', 'proceso_aduanas', 'revision_documentos', 'examen_previo', 'inspeccion_dekra', 'preparando_borrador_dua', 'pendiente_adelanto_impuestos', 'recibido_bodega_miami', 'preparando_envio', 'en_transito_costa_rica', 'en_aduanas', 'devuelto_bodega');--> statement-breakpoint
CREATE TYPE "public"."shipment_type" AS ENUM('paqueteria', 'aereo', 'maritimo_fcl', 'maritimo_lcl', 'agenciamiento');--> statement-breakpoint
CREATE SEQUENCE "public"."hs_shipment_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1;--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" "announcement_type" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"state" "shipment_state" NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"client_id" uuid NOT NULL,
	"shipment_type" "shipment_type" NOT NULL,
	"state" "shipment_state" NOT NULL,
	"tracking" text NOT NULL,
	"description" text NOT NULL,
	"store" text,
	"carrier" text,
	"hawb" text,
	"weight_kg" integer,
	"warehouse" text,
	"dua" text,
	"billing_notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_live_idx" ON "announcements" USING btree ("enabled","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "shipment_events_shipment_idx" ON "shipment_events" USING btree ("shipment_id","created_at");--> statement-breakpoint
CREATE INDEX "shipments_client_idx" ON "shipments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "shipments_state_idx" ON "shipments" USING btree ("state");--> statement-breakpoint
CREATE INDEX "shipments_created_at_idx" ON "shipments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_tracking" ON "shipments" USING btree ("tracking") WHERE "shipments"."state" <> 'entregado';