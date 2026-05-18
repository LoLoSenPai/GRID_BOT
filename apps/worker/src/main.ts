import { getEnv, logger } from "@grid-bot/common";
import {
  AlertService,
  BotEngineService,
  DflowAdapter,
  ExecutionProvider,
  ExecutionService,
  GridStrategyService,
  JupiterExecutionAdapter,
  MarketPriceService,
  PaperExecutionAdapter,
  RiskManagerService
} from "@grid-bot/core";
import {
  PrismaAlertRepository,
  PrismaBotStateRepository,
  PrismaPriceSnapshotRepository,
  PrismaSystemLogRepository,
  PrismaTradeRepository,
  prisma
} from "@grid-bot/db";

import { DiscordWebhookSink } from "./discord-webhook-sink";
import { getPortfolioSnapshotIntervalMs, safeBackfillPortfolioSnapshots, safeCreatePortfolioSnapshots } from "./portfolio-snapshots";
import { PythPriceStreamService } from "./pyth-price-stream";
import { getRuntimeMaintenanceIntervalMs, runRuntimeMaintenance } from "./runtime-maintenance";
import { SymbolRunScheduler } from "./symbol-run-scheduler";

const env = getEnv();

async function main() {
  const botRepository = new PrismaBotStateRepository();
  const tradeRepository = new PrismaTradeRepository();
  const priceSnapshotRepository = new PrismaPriceSnapshotRepository();
  const systemLogRepository = new PrismaSystemLogRepository();
  const alertRepository = new PrismaAlertRepository();

  const marketPriceService = new MarketPriceService();
  const executionService = new ExecutionService(
    {
      [ExecutionProvider.Jupiter]: new JupiterExecutionAdapter(),
      [ExecutionProvider.Paper]: new PaperExecutionAdapter(),
      [ExecutionProvider.Dflow]: new DflowAdapter()
    },
    env.LIVE_TRADING_ENABLED
  );

  const alertService = new AlertService(alertRepository, [new DiscordWebhookSink()]);
  const engine = new BotEngineService(
    botRepository,
    tradeRepository,
    priceSnapshotRepository,
    systemLogRepository,
    marketPriceService,
    executionService,
    new GridStrategyService(),
    new RiskManagerService(),
    alertService
  );
  const symbolRunScheduler = new SymbolRunScheduler(async (symbol) => {
    await engine.runBotsForSymbol(symbol);
  }, {
    minIntervalMs: env.SYMBOL_RUN_MIN_INTERVAL_MS
  });
  const priceStream = new PythPriceStreamService(async (marketPrice) => {
    marketPriceService.setLatestPrice(marketPrice);
    symbolRunScheduler.schedule(marketPrice.symbol);
  });
  let fullCycleRunning = false;
  let fullCycleQueued = false;
  const runFullCycle = async (reason: string) => {
    if (fullCycleRunning) {
      fullCycleQueued = true;
      return;
    }

    fullCycleRunning = true;
    try {
      do {
        fullCycleQueued = false;
        try {
          await engine.runCycle();
        } catch (error) {
          logger.error({ error, reason }, "Worker cycle failed");
        }
      } while (fullCycleQueued);
    } finally {
      fullCycleRunning = false;
    }
  };

  logger.info(
    { tickIntervalMs: env.BOT_TICK_INTERVAL_MS, symbolRunMinIntervalMs: env.SYMBOL_RUN_MIN_INTERVAL_MS },
    "Worker started"
  );
  priceStream.start();
  await safeBackfillPortfolioSnapshots();
  await safeCreatePortfolioSnapshots();
  await runRuntimeMaintenance();
  await runFullCycle("startup");
  const interval = setInterval(async () => {
    await runFullCycle("interval");
  }, env.BOT_TICK_INTERVAL_MS);
  const portfolioSnapshotInterval = setInterval(async () => {
    await safeCreatePortfolioSnapshots();
  }, getPortfolioSnapshotIntervalMs());
  const maintenanceInterval = setInterval(async () => {
    await runRuntimeMaintenance();
  }, getRuntimeMaintenanceIntervalMs());

  const shutdown = async () => {
    clearInterval(interval);
    clearInterval(portfolioSnapshotInterval);
    clearInterval(maintenanceInterval);
    await priceStream.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (error) => {
  logger.error({ error }, "Worker fatal error");
  await prisma.$disconnect();
  process.exit(1);
});
