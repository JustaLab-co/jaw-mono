ALTER TABLE "payments" DROP CONSTRAINT "payment_source";--> statement-breakpoint
ALTER TABLE "grants" DROP CONSTRAINT "grants_approval_id_approval_requests_id_fk";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_approval_id_approval_requests_id_fk";--> statement-breakpoint
DROP INDEX "payments_approval_id_index";--> statement-breakpoint
ALTER TABLE "grants" DROP COLUMN "approval_id";--> statement-breakpoint
-- The guard compared approval_id; redefined without it before the column goes.
CREATE OR REPLACE FUNCTION "payments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment % is never deleted', OLD.id;
  END IF;
  IF OLD.state IN ('settled', 'failed') THEN
    RAISE EXCEPTION 'payment % is % and final', OLD.id, OLD.state;
  END IF;
  IF (OLD.state, NEW.state) NOT IN (
    ('pending', 'pending'), ('pending', 'signed'), ('pending', 'failed'), ('pending', 'settled'),
    ('signed', 'signed'), ('signed', 'unknown'), ('signed', 'settled'), ('signed', 'failed'),
    ('unknown', 'unknown'), ('unknown', 'settled'), ('unknown', 'failed')
  ) THEN
    RAISE EXCEPTION 'payment %: % to % is not a transition', OLD.id, OLD.state, NEW.state;
  END IF;
  IF (NEW.connection_id, NEW.idempotency_key, NEW.request_hash, NEW.payer, NEW.url)
     IS DISTINCT FROM (OLD.connection_id, OLD.idempotency_key, OLD.request_hash, OLD.payer, OLD.url) THEN
    RAISE EXCEPTION 'payment %: the request is immutable', OLD.id;
  END IF;
  IF OLD.state <> 'pending' AND (NEW.nonce, NEW.authorization, NEW.authorized, NEW.deadline)
     IS DISTINCT FROM (OLD.nonce, OLD.authorization, OLD.authorized, OLD.deadline) THEN
    RAISE EXCEPTION 'payment %: the signed authorization is immutable', OLD.id;
  END IF;
  IF OLD.state IN ('signed', 'unknown') AND NEW.state = 'failed' AND NOT (OLD.deadline < now()) THEN
    RAISE EXCEPTION 'payment %: a live authorization cannot fail', OLD.id;
  END IF;
  IF OLD.fenced IS NOT NULL AND NEW.fenced IS DISTINCT FROM OLD.fenced THEN
    RAISE EXCEPTION 'payment %: the fenced text is written once', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "approval_id";--> statement-breakpoint
DROP TABLE "approval_requests";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "sealed_key" text;
