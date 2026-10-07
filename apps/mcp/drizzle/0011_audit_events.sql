CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"tool" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_connection_id_created_at_index" ON "audit_events" USING btree ("connection_id","created_at");