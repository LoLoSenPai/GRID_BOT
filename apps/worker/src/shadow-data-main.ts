import { logger } from "@grid-bot/common";
import { GeckoTerminalHistoryProvider } from "@grid-bot/core";
import { createShadowObservationClient, PrismaShadowCostRepository, type ShadowObservationClientHandle } from "@grid-bot/db";
import { ShadowDataCollector, verifyShadowPool, type ShadowCollectionTarget } from "./shadow-data-collector";
import { createPacedShadowFetch, ShadowExecutionQuoteClient } from "./shadow-execution-quote-client";

export function createShadowDataCollector(handle: ShadowObservationClientHandle) {
  const client = handle.client, costs = new PrismaShadowCostRepository(client);
  const shadowFetch = createPacedShadowFetch();
  const verified = new Map<string, number>();
  return new ShadowDataCollector({
    targets: async () => {
      const rows = await client.gridBand.findMany({ where: { status: { not: "CLOSED" },
        assetStrategy: { portfolio: { shadowJevEnabled: true } }, bot: { archivedAt: null } },
        select: { botId: true, assetStrategy: { select: { portfolioId: true } },
          bot: { select: { baseSymbol: true, baseMint: true, quoteMint: true,
            config: { select: { maxDeployableUsd: true, levelCount: true } } } } } });
      const targets: ShadowCollectionTarget[] = [];
      for (const row of rows) {
        if ((row.bot.baseSymbol !== "BTC" && row.bot.baseSymbol !== "SOL") || !row.bot.config) continue;
        // Public taker from an existing public report. Never read execution wallet files or authorization payloads.
        const report = await client.execution.findFirst({ where: { botId: row.botId, provider: "jupiter", status: "filled" },
          orderBy: { completedAt: "desc" }, select: { rawReport: true } });
        const raw = report?.rawReport as { order?: { taker?: string } } | null;
        targets.push({ portfolioId: row.assetStrategy.portfolioId, botId: row.botId, symbol: row.bot.baseSymbol,
          baseMint: row.bot.baseMint, quoteMint: row.bot.quoteMint,
          orderQuoteUsd: Number(row.bot.config.maxDeployableUsd) / (row.bot.config.levelCount - 1),
          publicTaker: process.env.JUPITER_SHADOW_BUILD_TAKER || raw?.order?.taker });
      }
      return targets;
    },
    candles: async rows => {
      // Immutable closed-cache rows; previously stored data is not retroactively refreshed by this collector.
      if (rows.length) await client.marketCandle.createMany({ skipDuplicates: true, data: rows.map(c => ({
        provider: c.provider, symbol: c.symbol, quoteSymbol: c.quoteSymbol, resolution: c.resolution,
        sourceMarket: c.sourceMarket, openTime: c.openTime, closeTime: c.closeTime,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, fetchedAt: c.fetchedAt,
      })) });
    },
    quote: async (target, payload) => { await costs.captureQuoteComparison({ portfolioId: target.portfolioId,
      botId: target.botId, capturedAt: new Date(payload.completedAt), payload }); },
  }, {
    history: new GeckoTerminalHistoryProvider({ maxPages: 1, retryDelaysMs: [] }),
    verifyPool: async target => {
      if (Date.now() - (verified.get(target.symbol) ?? 0) < 86_400_000) return;
      await verifyShadowPool(target); verified.set(target.symbol, Date.now());
    },
    compare: (target, size) => new ShadowExecutionQuoteClient({ apiKey: process.env.JUPITER_SHADOW_API_KEY,
      quotaIsolated: process.env.SHADOW_JUPITER_QUOTA_ISOLATED === "true", buildTakerPublicKey: target.publicTaker,
      fetchFn: shadowFetch,
    }).compare({ baseMint: target.baseMint, quoteMint: target.quoteMint, rawQuoteAmount: String(Math.round(size * 1_000_000)) }),
    onError: (error, task) => logger.warn({ task,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : "Unknown collection failure" },
      "Independent shadow data collection failed"),
  });
}

async function main() {
  const handle = createShadowObservationClient(), collector = createShadowDataCollector(handle);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const poll = async () => {
    try { await collector.collect(); } catch (error) { logger.warn({ error }, "Shadow collector cycle failed"); }
    finally {
      running = undefined;
      if (!stopped) timer = setTimeout(() => { running = poll(); }, 300_000 - Date.now() % 300_000 + 15_000);
    }
  };
  const stop = async () => { stopped = true; if (timer) clearTimeout(timer); if (running) await running;
    await handle.close(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  logger.info({ quotesConfigured: Boolean(process.env.JUPITER_SHADOW_API_KEY) && process.env.SHADOW_JUPITER_QUOTA_ISOLATED === "true" },
    "Independent shadow market and quote collector started");
  running = poll();
}

// This entrypoint is not imported by the normal trading worker.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/shadow-data-main.ts")) {
  main().catch(error => { logger.error({ error }, "Shadow collector could not start"); process.exitCode = 1; });
}
