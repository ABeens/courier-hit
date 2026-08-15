DROP INDEX "shipments_active_tracking";--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "discarded_by" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "discard_reason" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_discarded_by_users_id_fk" FOREIGN KEY ("discarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_unassigned_idx" ON "shipments" USING btree ("created_at") WHERE "shipments"."client_id" is null and "shipments"."discarded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_active_tracking" ON "shipments" USING btree ("tracking") WHERE "shipments"."state" <> 'entregado' and "shipments"."discarded_at" is null;