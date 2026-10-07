CREATE UNIQUE INDEX "payments_payer_tx_hash_index" ON "payments" USING btree ("payer",lower("tx_hash")) WHERE "payments"."tx_hash" is not null;--> statement-breakpoint
-- Only the app database is bounded: a role-wide timeout also cut maintenance
-- sessions in other databases. Migrations lift it for their own session.
DO $$ BEGIN
  EXECUTE format('ALTER ROLE %I RESET statement_timeout', current_user);
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L', current_user, current_database(), '10s');
END $$;
