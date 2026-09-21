-- CreateEnum
CREATE TYPE "GridBandStatus" AS ENUM ('ACTIVE', 'PARKED_BELOW', 'CLOSED');

-- CreateEnum
CREATE TYPE "ExitTargetStatus" AS ENUM ('KNOWN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CapitalReservationStatus" AS ENUM ('RESERVED', 'UNKNOWN', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "CapitalLedgerEntryType" AS ENUM ('PORTFOLIO_FUNDING', 'BAND_ALLOCATION', 'RESERVATION', 'RESERVATION_RELEASE', 'BUY_SETTLEMENT', 'SELL_SETTLEMENT', 'PROFIT_SWEEP', 'RETAINED_BASE', 'RECONCILIATION');

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "mode" "BotMode" NOT NULL,
    "wallet_identity" TEXT NOT NULL,
    "quote_mint" TEXT NOT NULL,
    "free_quote_amount" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "auto_live" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_strategies" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "base_mint" TEXT NOT NULL,
    "base_symbol" TEXT NOT NULL,
    "objective" "StrategyMode" NOT NULL,
    "allocation_policy" TEXT NOT NULL DEFAULT 'equal',
    "allocated_quote_amount" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "retained_base_amount" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grid_bands" (
    "id" TEXT NOT NULL,
    "asset_strategy_id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "status" "GridBandStatus" NOT NULL DEFAULT 'ACTIVE',
    "allocated_quote_amount" DECIMAL(30,10) NOT NULL,
    "available_quote_amount" DECIMAL(30,10) NOT NULL,
    "reserved_quote_amount" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "deployed_cost_quote" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "realized_loss_quote" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grid_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grid_revisions" (
    "id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "low_price" DECIMAL(30,10) NOT NULL,
    "high_price" DECIMAL(30,10) NOT NULL,
    "level_count" INTEGER NOT NULL,
    "grid_type" "GridType" NOT NULL,
    "reason" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "snapshot_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grid_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_exit_commitments" (
    "id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "target_status" "ExitTargetStatus" NOT NULL,
    "buy_level_index" INTEGER,
    "sell_level_index" INTEGER,
    "buy_target_price" DECIMAL(30,10),
    "sell_target_price" DECIMAL(30,10),
    "economic_rule" "StrategyMode" NOT NULL,
    "origin_revision_id" TEXT NOT NULL,
    "max_adverse_drift_bps" INTEGER NOT NULL,
    "fulfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_exit_commitments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_reservations" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "band_id" TEXT NOT NULL,
    "quote_amount" DECIMAL(30,10) NOT NULL,
    "status" "CapitalReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "idempotency_key" TEXT NOT NULL,
    "execution_id" TEXT,
    "unknown_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "capital_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capital_ledger_entries" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "asset_strategy_id" TEXT,
    "band_id" TEXT,
    "reservation_id" TEXT,
    "entry_type" "CapitalLedgerEntryType" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "execution_id" TEXT,
    "portfolio_free_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "strategy_allocated_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "band_allocated_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "band_available_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "band_reserved_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "band_deployed_cost_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "strategy_retained_base_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "external_fee_quote_delta" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capital_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_mode_wallet_identity_quote_mint_key" ON "portfolios"("mode", "wallet_identity", "quote_mint");

-- CreateIndex
CREATE INDEX "asset_strategies_portfolio_id_idx" ON "asset_strategies"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "asset_strategies_portfolio_id_base_mint_key" ON "asset_strategies"("portfolio_id", "base_mint");

-- CreateIndex
CREATE UNIQUE INDEX "grid_bands_bot_id_key" ON "grid_bands"("bot_id");

-- CreateIndex
CREATE INDEX "grid_bands_asset_strategy_id_idx" ON "grid_bands"("asset_strategy_id");

-- CreateIndex
CREATE INDEX "grid_revisions_band_id_created_at_idx" ON "grid_revisions"("band_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "grid_revisions_band_id_sequence_key" ON "grid_revisions"("band_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "lot_exit_commitments_lot_id_key" ON "lot_exit_commitments"("lot_id");

-- CreateIndex
CREATE INDEX "lot_exit_commitments_band_id_fulfilled_at_idx" ON "lot_exit_commitments"("band_id", "fulfilled_at");

-- CreateIndex
CREATE UNIQUE INDEX "capital_reservations_execution_id_key" ON "capital_reservations"("execution_id");

-- CreateIndex
CREATE INDEX "capital_reservations_portfolio_id_status_idx" ON "capital_reservations"("portfolio_id", "status");

-- CreateIndex
CREATE INDEX "capital_reservations_band_id_status_idx" ON "capital_reservations"("band_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "capital_reservations_portfolio_id_idempotency_key_key" ON "capital_reservations"("portfolio_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "capital_ledger_entries_portfolio_id_created_at_idx" ON "capital_ledger_entries"("portfolio_id", "created_at");

-- CreateIndex
CREATE INDEX "capital_ledger_entries_band_id_created_at_idx" ON "capital_ledger_entries"("band_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "capital_ledger_entries_portfolio_id_idempotency_key_key" ON "capital_ledger_entries"("portfolio_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "asset_strategies" ADD CONSTRAINT "asset_strategies_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grid_bands" ADD CONSTRAINT "grid_bands_asset_strategy_id_fkey" FOREIGN KEY ("asset_strategy_id") REFERENCES "asset_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grid_bands" ADD CONSTRAINT "grid_bands_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grid_revisions" ADD CONSTRAINT "grid_revisions_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "grid_bands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_exit_commitments" ADD CONSTRAINT "lot_exit_commitments_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "grid_bands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_exit_commitments" ADD CONSTRAINT "lot_exit_commitments_origin_revision_id_fkey" FOREIGN KEY ("origin_revision_id") REFERENCES "grid_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_reservations" ADD CONSTRAINT "capital_reservations_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_reservations" ADD CONSTRAINT "capital_reservations_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "grid_bands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_ledger_entries" ADD CONSTRAINT "capital_ledger_entries_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_ledger_entries" ADD CONSTRAINT "capital_ledger_entries_asset_strategy_id_fkey" FOREIGN KEY ("asset_strategy_id") REFERENCES "asset_strategies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_ledger_entries" ADD CONSTRAINT "capital_ledger_entries_band_id_fkey" FOREIGN KEY ("band_id") REFERENCES "grid_bands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capital_ledger_entries" ADD CONSTRAINT "capital_ledger_entries_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "capital_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_free_quote_nonnegative" CHECK ("free_quote_amount" >= 0);
ALTER TABLE "asset_strategies" ADD CONSTRAINT "asset_strategies_objective_check" CHECK ("objective" IN ('accumulate_base', 'accumulate_usdc'));
ALTER TABLE "asset_strategies" ADD CONSTRAINT "asset_strategies_allocation_policy_check" CHECK ("allocation_policy" = 'equal');
ALTER TABLE "asset_strategies" ADD CONSTRAINT "asset_strategies_amounts_nonnegative" CHECK ("allocated_quote_amount" >= 0 AND "retained_base_amount" >= 0);
ALTER TABLE "grid_bands" ADD CONSTRAINT "grid_bands_amounts_nonnegative" CHECK (
  "allocated_quote_amount" >= 0 AND "available_quote_amount" >= 0 AND "reserved_quote_amount" >= 0 AND
  "deployed_cost_quote" >= 0 AND "realized_loss_quote" >= 0
);
ALTER TABLE "grid_revisions" ADD CONSTRAINT "grid_revisions_range_check" CHECK ("low_price" > 0 AND "high_price" > "low_price" AND "level_count" >= 2);
ALTER TABLE "lot_exit_commitments" ADD CONSTRAINT "lot_exit_commitments_rule_check" CHECK ("economic_rule" IN ('accumulate_base', 'accumulate_usdc'));
ALTER TABLE "lot_exit_commitments" ADD CONSTRAINT "lot_exit_commitments_known_target_check" CHECK (
  ("target_status" = 'UNKNOWN') OR
  ("buy_level_index" IS NOT NULL AND "sell_level_index" IS NOT NULL AND "buy_target_price" > 0 AND "sell_target_price" > 0)
);
ALTER TABLE "capital_reservations" ADD CONSTRAINT "capital_reservations_positive_amount" CHECK ("quote_amount" > 0);

CREATE FUNCTION reject_immutable_v2_row_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "grid_revisions_immutable" BEFORE UPDATE OR DELETE ON "grid_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_v2_row_change();
CREATE TRIGGER "capital_ledger_entries_immutable" BEFORE UPDATE OR DELETE ON "capital_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_v2_row_change();

CREATE FUNCTION protect_lot_exit_commitment_terms() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."band_id", NEW."lot_id", NEW."target_status", NEW."buy_level_index", NEW."sell_level_index",
    NEW."buy_target_price", NEW."sell_target_price", NEW."economic_rule", NEW."origin_revision_id", NEW."max_adverse_drift_bps")
    IS DISTINCT FROM
    ROW(OLD."band_id", OLD."lot_id", OLD."target_status", OLD."buy_level_index", OLD."sell_level_index",
    OLD."buy_target_price", OLD."sell_target_price", OLD."economic_rule", OLD."origin_revision_id", OLD."max_adverse_drift_bps") THEN
    RAISE EXCEPTION 'lot exit commitment economic terms are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "lot_exit_commitment_terms_immutable" BEFORE UPDATE ON "lot_exit_commitments"
FOR EACH ROW EXECUTE FUNCTION protect_lot_exit_commitment_terms();
