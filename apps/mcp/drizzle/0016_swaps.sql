CREATE TABLE "swaps" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'quoting' NOT NULL,
	"code" text,
	"lease_token" text,
	"lease_until" timestamp with time zone NOT NULL,
	"origin_chain_id" integer NOT NULL,
	"origin_token" text NOT NULL,
	"destination_chain_id" integer NOT NULL,
	"destination_token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"depositor" text NOT NULL,
	"recipient" text NOT NULL,
	"payment_attempt" integer DEFAULT 1 NOT NULL,
	"payment_key" text NOT NULL,
	"payment_id" text,
	"paid_at" timestamp with time zone,
	"quote_id" text,
	"deposit_address" text,
	"quote" jsonb,
	"quote_fenced" text,
	"call" jsonb,
	"wallet_url" text,
	"approve_by" timestamp with time zone,
	"calls_id" text,
	"tx_hash" text,
	"backend_state" text,
	"backend_raw_state" text,
	"submit_attempts" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "swaps_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "swap_payment_key" CHECK ("swaps"."payment_key" = 'swap:' || "swaps"."id" || ':' || "swaps"."payment_attempt"),
	CONSTRAINT "swap_shape" CHECK ("swaps"."state" in ('quoting', 'quote_failed', 'quote_rejected', 'abandoned')
        or ("swaps"."quote_id" is not null and "swaps"."call" is not null and "swaps"."wallet_url" is not null and "swaps"."approve_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "swaps" ADD CONSTRAINT "swaps_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swaps_connection_id_idempotency_key_index" ON "swaps" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "swaps_deposit_address_index" ON "swaps" USING btree (lower("deposit_address"));--> statement-breakpoint
CREATE INDEX "swaps_connection_id_created_at_id_index" ON "swaps" USING btree ("connection_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "swaps_open_index" ON "swaps" USING btree ("connection_id") WHERE "swaps"."state" in ('quoting', 'awaiting_owner');--> statement-breakpoint
CREATE FUNCTION "swaps_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  finals CONSTANT text[] := ARRAY['quote_failed', 'quote_rejected', 'abandoned', 'owner_declined', 'completed', 'refunded', 'failed'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'swap % is never deleted', OLD.id;
  END IF;
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
      coalesce(OLD.paid_at, NEW.paid_at), coalesce(OLD.wallet_url, NEW.wallet_url),
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
CREATE TRIGGER "swaps_guard" BEFORE UPDATE OR DELETE ON "swaps" FOR EACH ROW EXECUTE FUNCTION "swaps_guard"();