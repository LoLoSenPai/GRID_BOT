ALTER TYPE "ShadowEngineOutcomeStatus" ADD VALUE 'observed_only';

ALTER TABLE "portfolios"
  ADD COLUMN "shadow_jev_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Enable only portfolios that already contain an actively running BTC or SOL
-- live band at migration time. The column default deliberately remains false.
UPDATE "portfolios" AS p
SET "shadow_jev_enabled" = true
WHERE p."mode" = 'live'
  AND EXISTS (
    SELECT 1
    FROM "asset_strategies" AS ast
    INNER JOIN "grid_bands" AS gb
      ON gb."asset_strategy_id" = ast."id"
    INNER JOIN "bots" AS b
      ON b."id" = gb."bot_id"
    WHERE ast."portfolio_id" = p."id"
      AND ast."base_symbol" IN ('BTC', 'SOL')
      AND gb."status" = 'ACTIVE'
      AND b."mode" = 'live'
      AND b."status" = 'running'
      AND b."archived_at" IS NULL
  );
