CREATE TABLE "portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "mode" "BotMode" NOT NULL,
    "bot_count" INTEGER NOT NULL,
    "active_bot_count" INTEGER NOT NULL,
    "total_budget_usd" DECIMAL(30,10) NOT NULL,
    "capital_deployed_usd" DECIMAL(30,10) NOT NULL,
    "realized_pnl_usd" DECIMAL(30,10) NOT NULL,
    "unrealized_pnl_usd" DECIMAL(30,10) NOT NULL,
    "total_pnl_usd" DECIMAL(30,10) NOT NULL,
    "total_equity_usd" DECIMAL(30,10) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "portfolio_snapshots_mode_created_at_idx" ON "portfolio_snapshots"("mode", "created_at" DESC);
