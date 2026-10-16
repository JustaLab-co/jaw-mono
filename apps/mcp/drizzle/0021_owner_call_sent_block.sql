ALTER TABLE "owner_calls" ADD COLUMN "sent_block" bigint;--> statement-breakpoint
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
  IF (NEW.calls_id, NEW.tx_hash, NEW.sent_block, NEW.wallet_url)
     IS DISTINCT FROM (coalesce(OLD.calls_id, NEW.calls_id), coalesce(OLD.tx_hash, NEW.tx_hash),
      coalesce(OLD.sent_block, NEW.sent_block),
      CASE WHEN reopen THEN NEW.wallet_url ELSE OLD.wallet_url END) THEN
    RAISE EXCEPTION 'owner call %: the link, the calls id and the sent block are written once', OLD.id;
  END IF;
  NEW.updated_at := statement_timestamp();
  IF NEW.state = ANY (finals) THEN
    NEW.finished_at := statement_timestamp();
  END IF;
  RETURN NEW;
END $$;
