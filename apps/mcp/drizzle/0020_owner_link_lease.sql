ALTER TABLE "owner_calls" ADD COLUMN "session_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "swaps" ADD COLUMN "session_until" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "swaps_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reopen boolean;
  finals CONSTANT text[] := ARRAY['quote_failed', 'quote_rejected', 'abandoned', 'owner_declined', 'completed', 'refunded', 'failed'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'swap % is never deleted', OLD.id;
  END IF;
  reopen := OLD.state = 'awaiting_owner' AND NEW.state = 'awaiting_owner'
    AND OLD.code IS DISTINCT FROM 'send_started'
    AND (OLD.session_until IS NULL OR OLD.session_until <= statement_timestamp());
  IF OLD.state = ANY (finals) THEN
    RAISE EXCEPTION 'swap % is % and final', OLD.id, OLD.state;
  END IF;
  IF OLD.state <> NEW.state AND (OLD.state, NEW.state) NOT IN (
    ('quoting', 'quote_failed'), ('quoting', 'quote_rejected'), ('quoting', 'abandoned'), ('quoting', 'awaiting_owner'),
    ('awaiting_owner', 'owner_declined'), ('awaiting_owner', 'expired'), ('awaiting_owner', 'deposit_sent'),
    ('awaiting_owner', 'submitted'), ('awaiting_owner', 'completed'), ('awaiting_owner', 'refunded'), ('awaiting_owner', 'failed'),
    ('expired', 'deposit_sent'), ('expired', 'submitted'), ('expired', 'completed'), ('expired', 'refunded'), ('expired', 'failed'),
    ('deposit_sent', 'submitted'),
    ('submitted', 'completed'), ('submitted', 'refunded'), ('submitted', 'failed')
  ) THEN
    RAISE EXCEPTION 'swap %: % to % is not a transition', OLD.id, OLD.state, NEW.state;
  END IF;
  IF NEW.state = 'deposit_sent' AND NEW.calls_id IS NULL THEN
    RAISE EXCEPTION 'swap %: deposit_sent only with a calls id', OLD.id;
  END IF;
  IF (NEW.id, NEW.connection_id, NEW.idempotency_key, NEW.request_hash, NEW.depositor, NEW.recipient,
      NEW.origin_chain_id, NEW.origin_token, NEW.destination_chain_id, NEW.destination_token, NEW.amount)
     IS DISTINCT FROM (OLD.id, OLD.connection_id, OLD.idempotency_key, OLD.request_hash, OLD.depositor, OLD.recipient,
      OLD.origin_chain_id, OLD.origin_token, OLD.destination_chain_id, OLD.destination_token, OLD.amount) THEN
    RAISE EXCEPTION 'swap %: the request is immutable', OLD.id;
  END IF;
  IF (NEW.quote_id, NEW.deposit_address, NEW.quote, NEW.call, NEW.quote_fenced, NEW.paid_at,
      NEW.wallet_url, NEW.approve_by, NEW.calls_id)
     IS DISTINCT FROM (coalesce(OLD.quote_id, NEW.quote_id), coalesce(OLD.deposit_address, NEW.deposit_address),
      coalesce(OLD.quote, NEW.quote), coalesce(OLD.call, NEW.call), coalesce(OLD.quote_fenced, NEW.quote_fenced),
      coalesce(OLD.paid_at, NEW.paid_at),
      CASE WHEN reopen THEN NEW.wallet_url ELSE coalesce(OLD.wallet_url, NEW.wallet_url) END,
      coalesce(OLD.approve_by, NEW.approve_by), coalesce(OLD.calls_id, NEW.calls_id)) THEN
    RAISE EXCEPTION 'swap %: the quote, its link and the calls id are written once', OLD.id;
  END IF;
  IF NEW.payment_attempt <> OLD.payment_attempt AND NOT (NEW.payment_attempt = OLD.payment_attempt + 1
     AND OLD.state = 'quoting' AND OLD.quote_id IS NULL AND NEW.quote_id IS NULL) THEN
    RAISE EXCEPTION 'swap %: the payment attempt grows by one, and only while quoting with no quote', OLD.id;
  END IF;
  NEW.updated_at := statement_timestamp();
  IF NEW.state = ANY (finals) THEN
    NEW.finished_at := statement_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "owner_calls_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reopen boolean;
  finals CONSTANT text[] := ARRAY['owner_declined', 'landed', 'reverted'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner call % is never deleted', OLD.id;
  END IF;
  reopen := OLD.state = 'awaiting_owner' AND NEW.state = 'awaiting_owner'
    AND OLD.code IS DISTINCT FROM 'send_started'
    AND (OLD.session_until IS NULL OR OLD.session_until <= statement_timestamp());
  IF OLD.state = ANY (finals) THEN
    RAISE EXCEPTION 'owner call % is % and final', OLD.id, OLD.state;
  END IF;
  IF OLD.state <> NEW.state AND (OLD.state, NEW.state) NOT IN (
    ('awaiting_owner', 'owner_declined'), ('awaiting_owner', 'expired'), ('awaiting_owner', 'sent'),
    ('expired', 'sent'),
    ('sent', 'landed'), ('sent', 'reverted')
  ) THEN
    RAISE EXCEPTION 'owner call %: % to % is not a transition', OLD.id, OLD.state, NEW.state;
  END IF;
  IF (NEW.id, NEW.connection_id, NEW.idempotency_key, NEW.request_hash, NEW.chain_id, NEW.account, NEW.calls, NEW.approve_by)
     IS DISTINCT FROM (OLD.id, OLD.connection_id, OLD.idempotency_key, OLD.request_hash, OLD.chain_id, OLD.account, OLD.calls, OLD.approve_by) THEN
    RAISE EXCEPTION 'owner call %: the request is immutable', OLD.id;
  END IF;
  IF (NEW.calls_id, NEW.tx_hash, NEW.wallet_url)
     IS DISTINCT FROM (coalesce(OLD.calls_id, NEW.calls_id), coalesce(OLD.tx_hash, NEW.tx_hash),
      CASE WHEN reopen THEN NEW.wallet_url ELSE OLD.wallet_url END) THEN
    RAISE EXCEPTION 'owner call %: the link and the calls id are written once', OLD.id;
  END IF;
  NEW.updated_at := statement_timestamp();
  IF NEW.state = ANY (finals) THEN
    NEW.finished_at := statement_timestamp();
  END IF;
  RETURN NEW;
END $$;
