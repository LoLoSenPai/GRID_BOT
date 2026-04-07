import type {
  AlertType,
  BotMode,
  BotStatus,
  ExecutionProvider,
  ExecutionStatus,
  GridType,
  LogLevel,
  OrderStatus,
  RecenterMode,
  StrategyMode,
  TradeSide
} from "./enums";

export interface BotConfig {
  id: string;
  botId: string;
  totalBudgetUsd: number;
  maxDeployableUsd: number;
  reserveQuoteAmount: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  minOrderQuoteAmount: number;
  maxSlippageBps: number;
  cooldownMs: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  maxConsecutiveFailures: number;
  levelLockMs: number;
  priceConfirmationWindowMs: number;
  recenterMode: RecenterMode;
  autoRecenterMinIntervalMs: number;
  autoRecenterMaxPerDay: number;
  outOfRangePause: boolean;
}

export interface PendingSignal {
  levelIndex: number;
  side: TradeSide;
  firstObservedAt: string;
  lastObservedPrice: number;
}

export interface GridCycle {
  buyLevelIndex: number;
  sellLevelIndex: number | null;
  lotId: string;
  openedAt: string;
}

export interface BotRuntimeMetadata {
  levelLocks: Record<string, string>;
  pendingSignal?: PendingSignal | null;
  gridCycles?: Record<string, GridCycle>;
  recenterHistory: string[];
  recentExecutions: string[];
}

export interface BotStateSnapshot {
  id: string;
  botId: string;
  status: BotStatus;
  currentPrice: number | null;
  availableQuoteAmount: number;
  availableBaseAmount: number;
  deployedQuoteAmount: number;
  averageEntryPrice: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalEquityUsd: number;
  consecutiveFailures: number;
  lastExecutionAt: Date | null;
  lastProcessedAt: Date;
  lastRecenterAt: Date | null;
  metadata: BotRuntimeMetadata;
}

export interface Position {
  id: string;
  botId: string;
  baseAmount: number;
  quoteSpent: number;
  averageEntryPrice: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesQuote: number;
}

export interface PositionLot {
  id: string;
  botId: string;
  originalBaseAmount: number;
  remainingBaseAmount: number;
  entryPrice: number;
  costQuote: number;
  openedByExecutionId: string;
  closedByExecutionId: string | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface Bot {
  id: string;
  key: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  strategyMode: StrategyMode;
  mode: BotMode;
  status: BotStatus;
  executionProvider: ExecutionProvider;
  currentPrice: number | null;
}

export interface BotAggregate {
  bot: Bot;
  config: BotConfig;
  latestState: BotStateSnapshot | null;
  position: Position | null;
  openLots: PositionLot[];
}

export interface GridLevel {
  index: number;
  price: number;
}

export interface MarketPrice {
  symbol: string;
  pair: string;
  price: number;
  confidence: number;
  source: string;
  timestamp: Date;
  feedId: string;
}

export interface TriggerSignal {
  levelIndex: number;
  side: TradeSide;
  levelPrice: number;
  observedPrice: number;
  idempotencyKey: string;
  triggeredAt: Date;
}

export interface OrderIntent {
  botId: string;
  orderKey: string;
  side: TradeSide;
  levelIndex: number;
  targetPrice: number;
  requestedBaseAmount: number;
  requestedQuoteAmount: number;
  status: OrderStatus;
  reason: string;
  matchedLotIds?: string[];
}

export interface ExecutionQuote {
  provider: ExecutionProvider;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutputAmount: number;
  estimatedFeeAmount: number;
  priceImpactPct: number;
  requestId?: string;
  expiresAt?: string | null;
  route?: string | null;
  rawQuote?: unknown;
}

export interface ExecutionEstimate extends ExecutionQuote {
  expectedPrice: number;
}

export interface ExecuteSwapParams {
  botId: string;
  inputMint: string;
  outputMint: string;
  amount: number;
  tradeSide?: TradeSide;
  inputDecimals: number;
  outputDecimals: number;
  slippageBps: number;
  clientOrderId: string;
  walletPublicKey?: string;
  referencePrice?: number;
}

export interface ExecutionReport {
  provider: ExecutionProvider;
  status: ExecutionStatus;
  executionId: string;
  txId?: string | null;
  inputAmount: number;
  outputAmount: number;
  effectivePrice: number;
  feeAmount: number;
  rawReport?: unknown;
}

export interface ExecutionRecord {
  id: string;
  orderId: string;
  botId: string;
  provider: ExecutionProvider;
  mode: BotMode;
  status: ExecutionStatus;
  executionRef: string;
  txId: string | null;
  quotePrice: number | null;
  expectedOutputAmount: number | null;
  expectedFeeAmount: number | null;
  executedInputAmount: number | null;
  executedOutputAmount: number | null;
  executedFeeAmount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  rawReport: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AlertRecord {
  id: string;
  botId?: string | null;
  type: AlertType;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface SystemLogInput {
  botId?: string | null;
  level: LogLevel;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
}
