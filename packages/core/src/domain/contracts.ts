import type {
  AlertRecord,
  BotAggregate,
  BotStateSnapshot,
  CandleHistoryRequest,
  CandleHistoryResult,
  ExecutionRecord,
  ExecutionReport,
  ExecutionEstimate,
  ExecuteSwapParams,
  TriggerSignal,
  MarketPrice,
  NormalizedCandle,
  OrderIntent,
  Position,
  PositionLot,
  SystemLogInput
} from "./types";
import type { BotStatus } from "./enums";

export interface BotStateRepository {
  listRunnableBots(): Promise<BotAggregate[]>;
  getBotAggregate(botId: string): Promise<BotAggregate | null>;
  updateBotStatus(botId: string, status: BotStatus): Promise<void>;
  setBotHeartbeat(botId: string, currentPrice: number | null): Promise<void>;
  createStateSnapshot(snapshot: Omit<BotStateSnapshot, "id">): Promise<void>;
  withBotLock<T>(botId: string, callback: () => Promise<T>): Promise<T | null>;
  updateRange?(botId: string, range: { lowPrice: number; highPrice: number }, snapshot: Omit<BotStateSnapshot, "id">): Promise<void>;
}

export interface PendingExecutionAttempt {
  expectedSnapshotId?: string | null;
  executionId: string;
  orderId: string;
  botId: string;
  signal: TriggerSignal;
  orderIntent: OrderIntent;
  executionParams: ExecuteSwapParams;
  preparedExecution?: ExecutionEstimate;
  result?: ExecutionReport | null;
  wasUncertain?: boolean;
}

export interface ExecutionCommit {
  executionId: string;
  orderId: string;
  botId: string;
  report: ExecutionReport;
  lots: PositionLot[];
  position: Omit<Position, "id">;
  snapshot: Omit<BotStateSnapshot, "id">;
}

export interface TradeRepository {
  getPendingExecution?(botId: string): Promise<PendingExecutionAttempt | null>;
  prepareExecutionAttempt?(input: Omit<PendingExecutionAttempt, "executionId" | "orderId">): Promise<PendingExecutionAttempt>;
  saveExecutionResult?(attempt: PendingExecutionAttempt, report: ExecutionReport, uncertain: boolean): Promise<void>;
  commitExecution?(input: ExecutionCommit): Promise<boolean>;
  createOrder(order: OrderIntent): Promise<{ id: string }>;
  markOrderStatus(orderId: string, status: string, reason?: string | null): Promise<void>;
  createExecution(record: Omit<ExecutionRecord, "id" | "createdAt">): Promise<{ id: string }>;
  finalizeExecution(executionId: string, report: ExecutionReport, error?: { code?: string; message: string } | null): Promise<void>;
  upsertPosition(position: Omit<Position, "id">): Promise<void>;
  replaceLots(botId: string, lots: PositionLot[]): Promise<void>;
  createInventorySnapshot(input: {
    botId: string;
    baseAmount: number;
    quoteAmount: number;
    reservedBaseAmount: number;
    reservedQuoteAmount: number;
    averageCost: number | null;
  }): Promise<void>;
  createPnlSnapshot(input: {
    botId: string;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    totalPnlUsd: number;
    equityUsd: number;
    price: number;
  }): Promise<void>;
}

export interface PriceSnapshotRepository {
  createPriceSnapshot(input: {
    botId?: string | null;
    symbol: string;
    source: string;
    price: number;
    confidence: number;
    feedId: string;
    status: string;
    capturedAt: Date;
  }): Promise<void>;
}

export interface AlertRepository {
  createAlert(alert: Omit<AlertRecord, "id" | "createdAt">): Promise<AlertRecord>;
}

export interface SystemLogRepository {
  writeLog(entry: SystemLogInput): Promise<void>;
}

export interface MarketPricePort {
  getLatestPrice(bot: BotAggregate["bot"]): Promise<MarketPrice>;
}

export interface LivePriceProvider {
  getLatestPrice(symbol: string, quoteSymbol: string): Promise<MarketPrice>;
}

export interface ReferencePriceProvider {
  getReferencePrice(symbol: string, quoteSymbol: string): Promise<MarketPrice>;
}

export interface CandleHistoryProvider {
  readonly provider: string;
  getHistory(request: CandleHistoryRequest): Promise<CandleHistoryResult>;
}

export interface MarketCandleRepository {
  findCandles(request: CandleHistoryRequest & { provider: string }): Promise<NormalizedCandle[]>;
  upsertCandles(candles: NormalizedCandle[]): Promise<void>;
}

export interface AlertSink {
  notify(alert: AlertRecord): Promise<void>;
}
