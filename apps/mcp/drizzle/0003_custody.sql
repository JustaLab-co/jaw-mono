-- Keys sealed under the env key alone cannot move to a refresh token wrap
-- without a token, so every connection made before this reconnects.
UPDATE "connections" SET "status" = 'revoked', "revoked_at" = now(), "ticket_hash" = NULL WHERE "status" <> 'revoked';--> statement-breakpoint
DELETE FROM "oauth_payloads" WHERE "grant_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "session_address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_payloads" ADD COLUMN "key_wrap" text;--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "sealed_key";