ALTER TABLE "payments" ADD COLUMN "alerted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_index" ON "rate_limits" USING btree ("window_start");