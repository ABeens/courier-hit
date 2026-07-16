CREATE TABLE "district_routes" (
	"district_code" text PRIMARY KEY NOT NULL,
	"route_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
