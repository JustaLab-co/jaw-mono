ALTER TABLE "owner_calls" DROP CONSTRAINT "owner_call_shape";--> statement-breakpoint
ALTER TABLE "owner_calls" ADD CONSTRAINT "owner_call_shape" CHECK (jsonb_array_length("owner_calls"."calls") between 1 and 100
        and ("owner_calls"."state" <> 'sent' or "owner_calls"."calls_id" is not null)
        and ("owner_calls"."state" not in ('landed', 'reverted') or ("owner_calls"."calls_id" is not null and "owner_calls"."tx_hash" is not null)));