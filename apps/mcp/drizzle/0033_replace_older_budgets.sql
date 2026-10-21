-- A connection that held several budgets before a new one replaced the older: keep only its newest in force.
UPDATE "grants" AS g SET "replaced_at" = now()
WHERE g."kind" = 'x402-budget' AND g."replaced_at" IS NULL AND g."revoked_at" IS NULL
  AND EXISTS (
    SELECT 1 FROM "grants" AS n
    WHERE n."connection_id" = g."connection_id" AND n."kind" = 'x402-budget'
      AND n."replaced_at" IS NULL AND n."revoked_at" IS NULL AND n."created_at" > g."created_at"
  );
