CREATE TABLE "permission_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"method" text NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"permission_id" text,
	"state" text DEFAULT 'awaiting_owner' NOT NULL,
	"code" text,
	"wallet_url" text NOT NULL,
	"approve_by" timestamp with time zone NOT NULL,
	"session_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_request_shape" CHECK (("permission_requests"."method" = 'revoke' and "permission_requests"."permission_id" is not null)
        or ("permission_requests"."method" = 'grant' and ("permission_requests"."state" <> 'approved' or "permission_requests"."permission_id" is not null)))
);
--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_requests_connection_id_created_at_index" ON "permission_requests" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "permission_requests_open_account_index" ON "permission_requests" USING btree (lower("account")) WHERE "permission_requests"."state" = 'awaiting_owner';--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_open_grant_index" ON "permission_requests" USING btree ("connection_id") WHERE "permission_requests"."method" = 'grant' and "permission_requests"."state" = 'awaiting_owner';--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_open_revoke_index" ON "permission_requests" USING btree (lower("permission_id")) WHERE "permission_requests"."method" = 'revoke' and "permission_requests"."state" = 'awaiting_owner';