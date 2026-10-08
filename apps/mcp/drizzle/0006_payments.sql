CREATE TABLE "grants" (
	"permission_id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"spender" text NOT NULL,
	"token" text NOT NULL,
	"allowance" text NOT NULL,
	"period" text NOT NULL,
	"permission" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"permission_id" text NOT NULL,
	"payer" text NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"kind" text,
	"code" text,
	"lease_token" text,
	"lease_until" timestamp with time zone NOT NULL,
	"reserved" numeric(78, 0),
	"scheme" text,
	"asset" text,
	"network" text,
	"pay_to" text,
	"nonce" text,
	"authorized" numeric(78, 0),
	"amount" numeric(78, 0),
	"deadline" timestamp with time zone,
	"authorization" jsonb,
	"tx_hash" text,
	"block_time" timestamp with time zone,
	"top_up_amount" numeric(78, 0),
	"top_up_batch_id" text,
	"approval_batch_id" text,
	"http_status" integer,
	"fenced" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"reconciling_until" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "payment_shape" CHECK (("payments"."state" = 'pending' and "payments"."nonce" is null and "payments"."authorization" is null and "payments"."fenced" is null)
        or ("payments"."state" in ('signed', 'unknown') and "payments"."nonce" is not null and "payments"."authorization" is not null
            and "payments"."authorized" is not null and "payments"."deadline" is not null and "payments"."signed_at" is not null)
        or ("payments"."state" = 'settled' and "payments"."kind" = 'free' and "payments"."nonce" is null)
        or ("payments"."state" = 'settled' and "payments"."kind" = 'paid' and "payments"."nonce" is not null and "payments"."amount" is not null)
        or ("payments"."state" = 'failed' and "payments"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_evidence";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "permission_id" text;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grants_connection_id_created_at_index" ON "grants" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_connection_id_idempotency_key_index" ON "payments" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payer_nonce_index" ON "payments" USING btree ("payer","nonce");--> statement-breakpoint
CREATE INDEX "payments_connection_id_created_at_id_index" ON "payments" USING btree ("connection_id","created_at","id");--> statement-breakpoint
CREATE INDEX "payments_permission_id_created_at_index" ON "payments" USING btree ("permission_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_signed_at_index" ON "payments" USING btree ("signed_at") WHERE "payments"."state" in ('signed', 'unknown');--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_index" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_proof" CHECK (("approval_requests"."status" = 'pending' and "approval_requests"."signature" is null and "approval_requests"."assertion_ref" is null and "approval_requests"."permission_id" is null)
        or ("approval_requests"."status" <> 'pending' and ("approval_requests"."signature" is null) = ("approval_requests"."assertion_ref" is null) and ("approval_requests"."signature" is null) <> ("approval_requests"."permission_id" is null)));--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_evidence" CHECK (("approval_requests"."status" = 'pending') = ("approval_requests"."decided_at" is null and "approval_requests"."preview_hash" is null and "approval_requests"."payload_hash" is null));
--> statement-breakpoint
CREATE FUNCTION "payments_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
END $$;
--> statement-breakpoint
CREATE TRIGGER "payments_guard" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION "payments_guard"();
