CREATE TABLE "client_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"price_per_kg" double precision NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"allows_card" boolean DEFAULT true NOT NULL,
	"allows_bank_deposit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_rates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "client_rates_one_default" ON "client_rates" USING btree ("is_default") WHERE "client_rates"."is_default";