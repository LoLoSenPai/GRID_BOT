-- CreateEnum
CREATE TYPE "BotStatus" AS ENUM ('running', 'paused', 'stopped', 'out_of_range', 'cooldown', 'error');

-- CreateEnum
CREATE TYPE "BotMode" AS ENUM ('paper', 'live');

-- CreateEnum
CREATE TYPE "StrategyMode" AS ENUM ('accumulate_base', 'accumulate_usdc', 'balanced');

-- CreateEnum
CREATE TYPE "GridType" AS ENUM ('arithmetic', 'geometric');

-- CreateEnum
CREATE TYPE "RecenterMode" AS ENUM ('manual_recenter', 'auto_recenter');

-- CreateEnum
CREATE TYPE "ExecutionProvider" AS ENUM ('jupiter', 'paper', 'dflow');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('pending', 'submitted', 'filled', 'failed', 'simulated');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('bot_paused', 'bot_out_of_range', 'execution_failed', 'consecutive_failures', 'recenter_performed', 'budget_max_reached', 'drawdown_threshold', 'infrastructure_degraded');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('created', 'blocked', 'submitted', 'filled', 'failed', 'cancelled', 'simulated');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('debug', 'info', 'warn', 'error');

-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseMint" TEXT NOT NULL,
    "quoteMint" TEXT NOT NULL,
    "baseSymbol" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL,
    "baseDecimals" INTEGER NOT NULL,
    "quoteDecimals" INTEGER NOT NULL,
    "strategyMode" "StrategyMode" NOT NULL,
    "mode" "BotMode" NOT NULL,
    "status" "BotStatus" NOT NULL,
    "executionProvider" "ExecutionProvider" NOT NULL,
    "currentPrice" DECIMAL(30,10),
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_configs" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "totalBudgetUsd" DECIMAL(30,10) NOT NULL,
    "maxDeployableUsd" DECIMAL(30,10) NOT NULL,
    "reserveQuoteAmount" DECIMAL(30,10) NOT NULL,
    "lowPrice" DECIMAL(30,10) NOT NULL,
    "highPrice" DECIMAL(30,10) NOT NULL,
    "levelCount" INTEGER NOT NULL,
    "gridType" "GridType" NOT NULL,
    "minOrderQuoteAmount" DECIMAL(30,10) NOT NULL,
    "maxSlippageBps" INTEGER NOT NULL,
    "cooldownMs" INTEGER NOT NULL,
    "maxOrdersPerHour" INTEGER NOT NULL,
    "maxDrawdownPct" DECIMAL(10,4) NOT NULL,
    "maxConsecutiveFailures" INTEGER NOT NULL,
    "levelLockMs" INTEGER NOT NULL,
    "priceConfirmationWindowMs" INTEGER NOT NULL,
    "recenterMode" "RecenterMode" NOT NULL,
    "autoRecenterMinIntervalMs" INTEGER NOT NULL,
    "autoRecenterMaxPerDay" INTEGER NOT NULL,
    "outOfRangePause" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_state_snapshots" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "status" "BotStatus" NOT NULL,
    "currentPrice" DECIMAL(30,10),
    "availableQuoteAmount" DECIMAL(30,10) NOT NULL,
    "availableBaseAmount" DECIMAL(30,10) NOT NULL,
    "deployedQuoteAmount" DECIMAL(30,10) NOT NULL,
    "averageEntryPrice" DECIMAL(30,10),
    "realizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "unrealizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "totalEquityUsd" DECIMAL(30,10) NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastExecutionAt" TIMESTAMP(3),
    "lastProcessedAt" TIMESTAMP(3) NOT NULL,
    "lastRecenterAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_state_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL,
    "side" "TradeSide" NOT NULL,
    "levelIndex" INTEGER NOT NULL,
    "targetPrice" DECIMAL(30,10) NOT NULL,
    "requestedBaseAmount" DECIMAL(30,10) NOT NULL,
    "requestedQuoteAmount" DECIMAL(30,10) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "provider" "ExecutionProvider" NOT NULL,
    "mode" "BotMode" NOT NULL,
    "status" "ExecutionStatus" NOT NULL,
    "executionRef" TEXT NOT NULL,
    "txId" TEXT,
    "quotePrice" DECIMAL(30,10),
    "expectedOutputAmount" DECIMAL(30,10),
    "expectedFeeAmount" DECIMAL(30,10),
    "executedInputAmount" DECIMAL(30,10),
    "executedOutputAmount" DECIMAL(30,10),
    "executedFeeAmount" DECIMAL(30,10),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rawReport" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "baseAmount" DECIMAL(30,10) NOT NULL,
    "quoteSpent" DECIMAL(30,10) NOT NULL,
    "averageEntryPrice" DECIMAL(30,10) NOT NULL,
    "realizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "unrealizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "totalFeesQuote" DECIMAL(30,10) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_lots" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "originalBaseAmount" DECIMAL(30,10) NOT NULL,
    "remainingBaseAmount" DECIMAL(30,10) NOT NULL,
    "entryPrice" DECIMAL(30,10) NOT NULL,
    "costQuote" DECIMAL(30,10) NOT NULL,
    "openedByExecutionId" TEXT NOT NULL,
    "closedByExecutionId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "position_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshots" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "baseAmount" DECIMAL(30,10) NOT NULL,
    "quoteAmount" DECIMAL(30,10) NOT NULL,
    "reservedBaseAmount" DECIMAL(30,10) NOT NULL,
    "reservedQuoteAmount" DECIMAL(30,10) NOT NULL,
    "averageCost" DECIMAL(30,10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pnl_snapshots" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "realizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "unrealizedPnlUsd" DECIMAL(30,10) NOT NULL,
    "totalPnlUsd" DECIMAL(30,10) NOT NULL,
    "equityUsd" DECIMAL(30,10) NOT NULL,
    "price" DECIMAL(30,10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pnl_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "type" "AlertType" NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "sentToDiscordAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "level" "LogLevel" NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_snapshots" (
    "id" TEXT NOT NULL,
    "botId" TEXT,
    "symbol" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "price" DECIMAL(30,10) NOT NULL,
    "confidence" DECIMAL(30,10) NOT NULL,
    "feedId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bots_key_key" ON "bots"("key");

-- CreateIndex
CREATE UNIQUE INDEX "bot_configs_botId_key" ON "bot_configs"("botId");

-- CreateIndex
CREATE INDEX "bot_state_snapshots_botId_createdAt_idx" ON "bot_state_snapshots"("botId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderKey_key" ON "orders"("orderKey");

-- CreateIndex
CREATE INDEX "orders_botId_createdAt_idx" ON "orders"("botId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "executions_botId_createdAt_idx" ON "executions"("botId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "positions_botId_key" ON "positions"("botId");

-- CreateIndex
CREATE INDEX "position_lots_botId_openedAt_idx" ON "position_lots"("botId", "openedAt" ASC);

-- CreateIndex
CREATE INDEX "inventory_snapshots_botId_createdAt_idx" ON "inventory_snapshots"("botId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "pnl_snapshots_botId_createdAt_idx" ON "pnl_snapshots"("botId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "alerts_createdAt_idx" ON "alerts"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "system_logs_createdAt_idx" ON "system_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "price_snapshots_symbol_capturedAt_idx" ON "price_snapshots"("symbol", "capturedAt" DESC);

-- AddForeignKey
ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_state_snapshots" ADD CONSTRAINT "bot_state_snapshots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pnl_snapshots" ADD CONSTRAINT "pnl_snapshots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_logs" ADD CONSTRAINT "system_logs_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
