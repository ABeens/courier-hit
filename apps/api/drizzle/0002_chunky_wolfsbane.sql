CREATE TYPE "public"."service_value_type" AS ENUM('percentage', 'fixed', 'manual');--> statement-breakpoint
CREATE TABLE "cost_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value_type" "service_value_type" NOT NULL,
	"default_value" double precision,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_services_name_unique" UNIQUE("name")
);
