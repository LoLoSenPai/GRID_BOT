import { getEnv } from "@grid-bot/common";
import type { AlertSink, MarketPricePort } from "@grid-bot/core";
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
  PrismaTradeRepository
} from "@grid-bot/db";

export function createBotEngine(options?: {
  marketPriceService?: MarketPricePort;
  alertSinks?: AlertSink[];
}) {
  const env = getEnv();

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

  const alertService = new AlertService(alertRepository, options?.alertSinks ?? []);

  return {
    botRepository,
    engine: new BotEngineService(
      botRepository,
      tradeRepository,
      priceSnapshotRepository,
      systemLogRepository,
      options?.marketPriceService ?? new MarketPriceService(),
      executionService,
      new GridStrategyService(),
      new RiskManagerService(),
      alertService
    )
  };
}
