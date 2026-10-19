ALTER TABLE "grants" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "allowance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "period" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grant_budget_spend" CHECK ("grants"."kind" <> 'x402-budget' or ("grants"."token" is not null and "grants"."allowance" is not null and "grants"."period" = 'day'));