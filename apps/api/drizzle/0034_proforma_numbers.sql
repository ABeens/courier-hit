CREATE SEQUENCE "public"."hs_proforma_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1;--> statement-breakpoint
CREATE TABLE "proforma_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer NOT NULL,
	"shipment_id" uuid,
	"payment_group_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proforma_numbers_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "proforma_numbers_one_owner" CHECK (("proforma_numbers"."shipment_id" is not null)::int + ("proforma_numbers"."payment_group_id" is not null)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "proforma_numbers" ADD CONSTRAINT "proforma_numbers_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_numbers" ADD CONSTRAINT "proforma_numbers_payment_group_id_payment_groups_id_fk" FOREIGN KEY ("payment_group_id") REFERENCES "public"."payment_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proforma_numbers_shipment_idx" ON "proforma_numbers" USING btree ("shipment_id") WHERE "proforma_numbers"."shipment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "proforma_numbers_group_idx" ON "proforma_numbers" USING btree ("payment_group_id") WHERE "proforma_numbers"."payment_group_id" is not null;