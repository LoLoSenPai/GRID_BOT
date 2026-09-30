-- Append-only prospective quote observations. This does not alter any execution table.
CREATE TABLE "shadow_quote_comparisons" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "content_hash" TEXT NOT NULL UNIQUE,
  "portfolio_id" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "captured_at" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "shadow_quote_comparisons_portfolio_id_bot_id_captured_at_idx"
  ON "shadow_quote_comparisons" ("portfolio_id", "bot_id", "captured_at" DESC);
CREATE TRIGGER shadow_quote_comparisons_immutable
  BEFORE UPDATE OR DELETE ON "shadow_quote_comparisons"
  FOR EACH ROW EXECUTE FUNCTION reject_shadow_immutable_change();
