CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"account" text NOT NULL,
	"chain_id" integer NOT NULL,
	"requester" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"preview_hash" text,
	"payload_hash" text,
	"signature" text,
	"assertion_ref" text,
	CONSTRAINT "approval_evidence" CHECK (("approval_requests"."status" = 'pending') = ("approval_requests"."decided_at" is null and "approval_requests"."preview_hash" is null and "approval_requests"."payload_hash" is null and "approval_requests"."signature" is null and "approval_requests"."assertion_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_connection_id_created_at_index" ON "approval_requests" USING btree ("connection_id","created_at");