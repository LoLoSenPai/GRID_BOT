CREATE TABLE "market_candles" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "quote_symbol" TEXT NOT NULL,
  "resolution" TEXT NOT NULL,
  "source_market" TEXT,
  "open_time" TIMESTAMP(3) NOT NULL,
  "close_time" TIMESTAMP(3),
  "open" DECIMAL(30,10) NOT NULL,
  "high" DECIMAL(30,10) NOT NULL,
  "low" DECIMAL(30,10) NOT NULL,
  "close" DECIMAL(30,10) NOT NULL,
  "volume" DECIMAL(30,10),
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "market_candles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "market_candles_provider_symbol_quote_symbol_resolution_open_time_key"
  ON "market_candles"("provider", "symbol", "quote_symbol", "resolution", "open_time");

CREATE INDEX "market_candles_symbol_quote_symbol_resolution_open_time_idx"
  ON "market_candles"("symbol", "quote_symbol", "resolution", "open_time" DESC);

CREATE INDEX "market_candles_provider_symbol_quote_symbol_resolution_fetched_at_idx"
  ON "market_candles"("provider", "symbol", "quote_symbol", "resolution", "fetched_at");
