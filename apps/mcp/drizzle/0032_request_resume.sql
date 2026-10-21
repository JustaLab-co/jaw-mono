ALTER TABLE "permission_requests" ADD COLUMN "lease_holder" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "payload" text;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "relay" text;