ALTER TABLE "owner_calls" ADD COLUMN "lease_holder" text;--> statement-breakpoint
ALTER TABLE "owner_calls" ADD COLUMN "relay" text;--> statement-breakpoint
ALTER TABLE "owner_calls" ADD COLUMN "resume_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD COLUMN "resume_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "lease_holder" text;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "relay" text;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "resume_failures" integer DEFAULT 0 NOT NULL;