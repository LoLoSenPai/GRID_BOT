ALTER TYPE "ExecutionStatus" ADD VALUE IF NOT EXISTS 'unknown';
ALTER TABLE "position_lots" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'trading';
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_kind_check" CHECK ("kind" IN ('trading', 'retained'));
CREATE TABLE "execution_attempts" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE RESTRICT,
  "executionId" TEXT NOT NULL UNIQUE REFERENCES "executions"("id") ON DELETE RESTRICT,
  "orderId" TEXT NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "payload" JSONB NOT NULL,
  "result" JSONB,
  "uncertain" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
