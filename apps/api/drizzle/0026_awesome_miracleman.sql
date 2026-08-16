DROP INDEX "shipments_client_created_idx";--> statement-breakpoint
DROP INDEX "shipments_created_at_idx";--> statement-breakpoint
DROP INDEX "shipments_unassigned_idx";--> statement-breakpoint
CREATE INDEX "shipments_client_created_idx" ON "shipments" USING btree ("client_id","created_at","id");--> statement-breakpoint
CREATE INDEX "shipments_created_at_idx" ON "shipments" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "shipments_unassigned_idx" ON "shipments" USING btree ("created_at","id") WHERE "shipments"."client_id" is null and "shipments"."discarded_at" is null;