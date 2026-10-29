CREATE SEQUENCE "public"."provider_app_versions" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "provider_app_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"last_ready_at" timestamp with time zone,
	"last_close_code" integer,
	"last_signed_ok_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_apps" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ct" text NOT NULL,
	"signing_secret_ct" text,
	"previous_signing_secret_ct" text,
	"previous_expires_at" timestamp with time zone,
	"bot_token_ct" text,
	"allowed_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT nextval('provider_app_versions') NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_apps_provider" CHECK ("provider_apps"."provider" in ('slack', 'discord')),
	CONSTRAINT "provider_apps_slack_signing_secret" CHECK ("provider_apps"."provider" <> 'slack' or "provider_apps"."signing_secret_ct" is not null),
	CONSTRAINT "provider_apps_discord_bot_token" CHECK ("provider_apps"."provider" <> 'discord' or "provider_apps"."bot_token_ct" is not null)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;