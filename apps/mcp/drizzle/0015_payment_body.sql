ALTER TABLE "payments" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payment_body" CHECK ("payments"."body" is null or ("payments"."state" <> 'pending' and octet_length("payments"."body") <= 16384));--> statement-breakpoint
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
  IF OLD.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'payment %: the body is written once', OLD.id;
  END IF;
  RETURN NEW;
END $$;
