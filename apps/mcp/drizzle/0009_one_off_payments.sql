ALTER TABLE "payments" ALTER COLUMN "permission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "seller_request" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_approval_id_index" ON "payments" USING btree ("approval_id") WHERE "payments"."approval_id" is not null;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_seller_request" CHECK ("approval_requests"."kind" = 'payment' or "approval_requests"."seller_request" is null);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payment_source" CHECK (("payments"."permission_id" is null) <> ("payments"."approval_id" is null));--> statement-breakpoint
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
  IF (NEW.connection_id, NEW.idempotency_key, NEW.request_hash, NEW.payer, NEW.url, NEW.approval_id)
     IS DISTINCT FROM (OLD.connection_id, OLD.idempotency_key, OLD.request_hash, OLD.payer, OLD.url, OLD.approval_id) THEN
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
END $$;
