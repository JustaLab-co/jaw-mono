CREATE TABLE "owner_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"calls" jsonb NOT NULL,
	"state" text DEFAULT 'awaiting_owner' NOT NULL,
	"code" text,
	"wallet_url" text NOT NULL,
	"approve_by" timestamp with time zone NOT NULL,
	"calls_id" text,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "owner_call_shape" CHECK (jsonb_array_length("owner_calls"."calls") between 1 and 10
        and ("owner_calls"."state" <> 'sent' or "owner_calls"."calls_id" is not null)
        and ("owner_calls"."state" not in ('landed', 'reverted') or ("owner_calls"."calls_id" is not null and "owner_calls"."tx_hash" is not null)))
);
--> statement-breakpoint
ALTER TABLE "owner_calls" ADD CONSTRAINT "owner_calls_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_calls_connection_id_idempotency_key_index" ON "owner_calls" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "owner_calls_connection_id_created_at_id_index" ON "owner_calls" USING btree ("connection_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_calls_open_index" ON "owner_calls" USING btree ("connection_id") WHERE "owner_calls"."state" = 'awaiting_owner';--> statement-breakpoint
CREATE FUNCTION "owner_calls_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reopen boolean;
  finals CONSTANT text[] := ARRAY['owner_declined', 'landed', 'reverted'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner call % is never deleted', OLD.id;
  END IF;
  reopen := OLD.state = 'awaiting_owner' AND NEW.state = 'awaiting_owner'
    AND OLD.code IS DISTINCT FROM 'send_started';
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
--> statement-breakpoint
CREATE TRIGGER "owner_calls_guard" BEFORE UPDATE OR DELETE ON "owner_calls" FOR EACH ROW EXECUTE FUNCTION "owner_calls_guard"();
