CREATE TYPE "public"."connection_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('slack_user_token', 'webhook_secret');--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"team_id" text,
	"user_id" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"dedup_key" text NOT NULL,
	"raw" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_provider_team_user_uq" ON "connections" USING btree ("provider","team_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_connection_kind_uq" ON "credentials" USING btree ("connection_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "events_provider_dedup_key_uq" ON "events" USING btree ("provider","dedup_key");--> statement-breakpoint
CREATE INDEX "events_connection_received_idx" ON "events" USING btree ("connection_id","received_at");--> statement-breakpoint
CREATE INDEX "events_unenqueued_idx" ON "events" USING btree ("received_at") WHERE "events"."enqueued_at" is null;