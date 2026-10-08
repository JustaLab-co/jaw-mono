ALTER TABLE "grants" ADD COLUMN "replaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "revoked_at" timestamp with time zone;