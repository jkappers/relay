CREATE TYPE "public"."classifier_fallback" AS ENUM('drop', 'deliver');--> statement-breakpoint
CREATE TYPE "public"."classifier_mode" AS ENUM('off', 'shadow', 'enforce');--> statement-breakpoint
CREATE TYPE "public"."route_decision_status" AS ENUM('ok', 'fallback', 'budget_exceeded');--> statement-breakpoint
CREATE TYPE "public"."route_selection" AS ENUM('always', 'classifier');--> statement-breakpoint
CREATE TABLE "route_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"mode" "classifier_mode" NOT NULL,
	"model" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"selected" uuid[] NOT NULL,
	"status" "route_decision_status" NOT NULL,
	"error" text,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_decisions_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "classifier_mode" "classifier_mode" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "classifier_daily_limit" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "selection" "route_selection" DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "intent" text;--> statement-breakpoint
ALTER TABLE "routes" ADD COLUMN "classifier_fallback" "classifier_fallback" DEFAULT 'drop' NOT NULL;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_decisions_connection_created_idx" ON "route_decisions" USING btree ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_intent_length" CHECK ("routes"."intent" is null or char_length("routes"."intent") <= 500);--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_classifier_needs_intent" CHECK ("routes"."selection" <> 'classifier' or "routes"."intent" is not null);