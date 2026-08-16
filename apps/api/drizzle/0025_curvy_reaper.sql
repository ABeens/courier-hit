DROP INDEX "shipments_client_idx";--> statement-breakpoint
DROP INDEX "email_verifications_user_idx";--> statement-breakpoint
CREATE INDEX "clients_unlinked_idx" ON "clients" USING btree ("created_at") WHERE "clients"."helga_sync_status" in ('pending', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_hash_idx" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_reference_idx" ON "payments" USING btree ("gateway_reference") WHERE "payments"."gateway_reference" is not null;--> statement-breakpoint
CREATE INDEX "shipments_client_created_idx" ON "shipments" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "shipments_hawb_upper_idx" ON "shipments" USING btree (upper("hawb")) WHERE "shipments"."hawb" is not null;--> statement-breakpoint
CREATE INDEX "shipments_prealert_pending_idx" ON "shipments" USING btree ("created_at") WHERE "shipments"."helga_prealert_status" in ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "email_verifications_user_idx" ON "email_verifications" USING btree ("user_id","created_at");