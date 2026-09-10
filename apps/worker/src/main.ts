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
  prisma,
  botLockPool
} from "@grid-bot/db";

import { DiscordWebhookSink } from "./discord-webhook-sink";
import { JupiterPricePoller } from "./jupiter-price-poller";
import { getPortfolioSnapshotIntervalMs, safeBackfillPortfolioSnapshots, safeCreatePortfolioSnapshots } from "./portfolio-snapshots";
import { getRuntimeMaintenanceIntervalMs, runRuntimeMaintenance } from "./runtime-maintenance";
import { SymbolRunScheduler } from "./symbol-run-scheduler";
import { ExecutionRecoveryPoller } from "./execution-recovery-poller";

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
  const pricePoller = new JupiterPricePoller(
    marketPriceService,
    async (marketPrices) => {
      for (const marketPrice of marketPrices) {
        symbolRunScheduler.schedule(marketPrice.symbol);
      }
    },
    env.BOT_TICK_INTERVAL_MS
  );
  const recoveryPoller = new ExecutionRecoveryPoller(
    async () => (await prisma.executionAttempt.findMany({ select: { botId: true } })).map((attempt) => attempt.botId),
    (botId) => engine.runBot(botId, { recoveryOnly: true })
  );
  logger.info(
    { tickIntervalMs: env.BOT_TICK_INTERVAL_MS, symbolRunMinIntervalMs: env.SYMBOL_RUN_MIN_INTERVAL_MS },
    "Worker started"
  );
  await safeBackfillPortfolioSnapshots();
  await safeCreatePortfolioSnapshots();
  await runRuntimeMaintenance();
  pricePoller.start();
  recoveryPoller.start();
  const portfolioSnapshotInterval = setInterval(async () => {
    await safeCreatePortfolioSnapshots();
  }, getPortfolioSnapshotIntervalMs());
  const maintenanceInterval = setInterval(async () => {
    await runRuntimeMaintenance();
  }, getRuntimeMaintenanceIntervalMs());

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(portfolioSnapshotInterval);
    clearInterval(maintenanceInterval);
    pricePoller.stop();
    await Promise.all([symbolRunScheduler.stop(), recoveryPoller.stop()]);
    await prisma.$disconnect();
    await botLockPool.end();
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
