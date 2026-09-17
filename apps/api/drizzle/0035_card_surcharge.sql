ALTER TABLE "payment_groups" ADD COLUMN "surcharge_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "surcharge_amount" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_groups" ADD CONSTRAINT "payment_groups_surcharge_nonneg" CHECK ("payment_groups"."surcharge_amount" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_surcharge_nonneg" CHECK ("payments"."surcharge_amount" >= 0);