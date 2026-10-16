CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"account" text NOT NULL,
	"chain_id" integer NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"session_address" text NOT NULL,
	"sealed_key" text NOT NULL,
	"interaction_uid" text NOT NULL,
	"ticket_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"grant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "connections_interaction_uid_unique" UNIQUE("interaction_uid"),
	CONSTRAINT "connections_grant_id_unique" UNIQUE("grant_id"),
	CONSTRAINT "connection_status_shape" CHECK (("connections"."status" = 'pending' and "connections"."ticket_hash" is not null and "connections"."grant_id" is null)
        or ("connections"."status" = 'active' and "connections"."ticket_hash" is null and "connections"."grant_id" is not null and "connections"."activated_at" is not null)
        or ("connections"."status" = 'revoked' and "connections"."ticket_hash" is null and "connections"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "oauth_payloads" (
	"key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "oauth_payloads_grant_id_index" ON "oauth_payloads" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_payloads_uid_index" ON "oauth_payloads" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "oauth_payloads_expires_at_index" ON "oauth_payloads" USING btree ("expires_at");