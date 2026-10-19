ALTER TABLE "grants" ADD COLUMN "kind" text DEFAULT 'x402-budget' NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "kind" DROP DEFAULT;
