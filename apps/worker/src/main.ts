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
import { getRuntimeMaintenanceIntervalMs, runRuntimeMaintenance } from "./runtime-maintenance";

const env = getEnv();

async function main() {
  const botRepository = new PrismaBotStateRepository();
  const tradeRepository = new PrismaTradeRepository();
  const priceSnapshotRepository = new PrismaPriceSnapshotRepository();
  const systemLogRepository = new PrismaSystemLogRepository();
  const alertRepository = new PrismaAlertRepository();

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
    new MarketPriceService(),
    executionService,
    new GridStrategyService(),
    new RiskManagerService(),
    alertService
  );

  logger.info({ tickIntervalMs: env.BOT_TICK_INTERVAL_MS }, "Worker started");
  await runRuntimeMaintenance();
  await engine.runCycle();
  const interval = setInterval(async () => {
    await engine.runCycle();
  }, env.BOT_TICK_INTERVAL_MS);
  const maintenanceInterval = setInterval(async () => {
    await runRuntimeMaintenance();
  }, getRuntimeMaintenanceIntervalMs());

  const shutdown = async () => {
    clearInterval(interval);
    clearInterval(maintenanceInterval);
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
