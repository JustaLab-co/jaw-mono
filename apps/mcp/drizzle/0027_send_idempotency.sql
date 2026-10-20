ALTER TABLE "sends" DROP CONSTRAINT "send_shape";--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "request_hash" text;--> statement-breakpoint
CREATE INDEX "sends_connection_id_idempotency_key_index" ON "sends" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "send_shape" CHECK ("sends"."amount" >= 0 and ("sends"."idempotency_key" is null) = ("sends"."request_hash" is null) and (
        ("sends"."state" = 'open' and "sends"."finished_at" is null)
        or ("sends"."state" = 'landed' and "sends"."tx_hash" is not null and "sends"."finished_at" is not null)
        or ("sends"."state" = 'released' and "sends"."finished_at" is not null)));