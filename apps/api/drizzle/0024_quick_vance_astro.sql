CREATE TABLE "canton_routes" (
	"canton_code" text PRIMARY KEY NOT NULL,
	"route_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
