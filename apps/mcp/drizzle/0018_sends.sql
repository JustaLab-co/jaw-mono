CREATE TABLE "sends" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"permission_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"sender" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"period_start" bigint NOT NULL,
	"from_block" bigint NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"calls_id" text,
	"tx_hash" text,
	"lease_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "send_shape" CHECK ("sends"."amount" > 0 and (
        ("sends"."state" = 'open' and "sends"."finished_at" is null)
        or ("sends"."state" = 'landed' and "sends"."tx_hash" is not null and "sends"."finished_at" is not null)
        or ("sends"."state" = 'released' and "sends"."finished_at" is not null)))
);
--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sends_permission_id_created_at_index" ON "sends" USING btree ("permission_id","created_at");--> statement-breakpoint
CREATE INDEX "sends_lease_until_index" ON "sends" USING btree ("lease_until") WHERE "sends"."state" = 'open';