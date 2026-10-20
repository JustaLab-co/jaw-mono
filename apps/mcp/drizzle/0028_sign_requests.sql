ALTER TABLE "permission_requests" DROP CONSTRAINT "permission_request_shape";--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "request_hash" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "sign_kind" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "names_lost" text;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_open_sign_index" ON "permission_requests" USING btree ("connection_id") WHERE "permission_requests"."method" = 'sign' and "permission_requests"."state" = 'awaiting_owner';--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_names_lost_index" ON "permission_requests" USING btree ("names_lost");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_requests_sign_key_index" ON "permission_requests" USING btree ("connection_id","idempotency_key") WHERE "permission_requests"."method" = 'sign';--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_request_shape" CHECK (("permission_requests"."method" = 'revoke' and "permission_requests"."permission_id" is not null)
        or ("permission_requests"."method" = 'grant' and ("permission_requests"."state" <> 'approved' or "permission_requests"."permission_id" is not null))
        or ("permission_requests"."method" = 'sign' and "permission_requests"."idempotency_key" is not null and "permission_requests"."request_hash" is not null
          and "permission_requests"."sign_kind" is not null and ("permission_requests"."state" <> 'approved' or "permission_requests"."signature" is not null)));