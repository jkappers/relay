CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."destination_kind" ADD VALUE 'agent';--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"mutated" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"turns" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"final_text" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "agent_runs_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_http_needs_url_and_secret" CHECK ("destinations"."kind" <> 'http' or ("destinations"."url" is not null and "destinations"."secret_ciphertext" is not null));