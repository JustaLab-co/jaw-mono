CREATE TABLE "grants" (
	"permission_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"spender" text NOT NULL,
	"token" text NOT NULL,
	"allowance" text NOT NULL,
	"period" text NOT NULL,
	"permission" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_evidence";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "permission_id" text;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_connection_id_created_at_index" ON "grants" USING btree ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_proof" CHECK (("approval_requests"."status" = 'pending' and "approval_requests"."signature" is null and "approval_requests"."assertion_ref" is null and "approval_requests"."permission_id" is null)
        or ("approval_requests"."status" <> 'pending' and ("approval_requests"."signature" is null) = ("approval_requests"."assertion_ref" is null) and ("approval_requests"."signature" is null) <> ("approval_requests"."permission_id" is null)));--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_evidence" CHECK (("approval_requests"."status" = 'pending') = ("approval_requests"."decided_at" is null and "approval_requests"."preview_hash" is null and "approval_requests"."payload_hash" is null));