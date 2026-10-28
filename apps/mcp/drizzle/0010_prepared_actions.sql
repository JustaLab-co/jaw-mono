ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_proof";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "calls_id" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "tx_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_calls_id_index" ON "approval_requests" USING btree ("calls_id") WHERE "approval_requests"."calls_id" is not null;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_proof" CHECK (("approval_requests"."status" = 'pending' and "approval_requests"."signature" is null and "approval_requests"."assertion_ref" is null and "approval_requests"."permission_id" is null and "approval_requests"."calls_id" is null and "approval_requests"."tx_hash" is null)
        or ("approval_requests"."status" <> 'pending' and ("approval_requests"."signature" is null) = ("approval_requests"."assertion_ref" is null) and ("approval_requests"."calls_id" is null) = ("approval_requests"."tx_hash" is null)
          and ("approval_requests"."signature" is not null)::int + ("approval_requests"."permission_id" is not null)::int + ("approval_requests"."calls_id" is not null)::int = 1));