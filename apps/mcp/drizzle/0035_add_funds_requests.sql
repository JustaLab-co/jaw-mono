ALTER TABLE "permission_requests" DROP CONSTRAINT "permission_request_shape";--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_open_add_funds_index" ON "permission_requests" USING btree ("connection_id") WHERE "permission_requests"."method" = 'add_funds' and "permission_requests"."state" = 'awaiting_owner';--> statement-breakpoint
CREATE INDEX "permission_requests_ended_add_funds_index" ON "permission_requests" USING btree ("updated_at") WHERE "permission_requests"."method" = 'add_funds' and "permission_requests"."state" <> 'awaiting_owner';--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_request_shape" CHECK (("permission_requests"."method" = 'revoke' and "permission_requests"."permission_id" is not null)
        or ("permission_requests"."method" = 'grant' and ("permission_requests"."state" <> 'approved' or "permission_requests"."permission_id" is not null))
        or ("permission_requests"."method" = 'sign' and "permission_requests"."idempotency_key" is not null and "permission_requests"."request_hash" is not null
          and "permission_requests"."sign_kind" is not null and ("permission_requests"."state" <> 'approved' or "permission_requests"."signature" is not null))
        or "permission_requests"."method" = 'add_funds');