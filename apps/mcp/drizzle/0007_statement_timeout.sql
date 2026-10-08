-- Bound every statement through the role rather than a startup parameter, which
-- a transaction-mode pooler refuses; the server applies it to each new session.
DO $$ BEGIN EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', current_user, '10s'); END $$;
