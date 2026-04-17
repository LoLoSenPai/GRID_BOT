import type {
  AlertType,
  BotMode,
  BotStatus,
  ExecutionProvider,
  ExecutionStatus,
  GridType,
  MinOrderMode,
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

export interface HistoricalCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

export interface BacktestMarketSeries {
  symbol: string;
  pair: string;
  resolution?: string;
  candles: HistoricalCandle[];
}

export interface NormalizedCandle {
  provider: string;
  symbol: string;
  quoteSymbol: string;
  resolution: string;
  sourceMarket: string | null;
  openTime: Date;
  closeTime: Date | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  fetchedAt: Date;
}

export interface CandleHistoryRequest {
  symbol: string;
  quoteSymbol: string;
  resolution: string;
  from: Date;
  to: Date;
}

export interface CandleHistoryMeta {
  provider: string;
  symbol: string;
  quoteSymbol: string;
  resolution: string;
  from: Date;
  to: Date;
  sourceMarket: string | null;
  cacheHit: boolean;
  stale?: boolean;
  fetchedAt: Date;
}

export interface CandleHistoryResult {
  candles: NormalizedCandle[];
  meta: CandleHistoryMeta;
}

export interface IndicatorSnapshot {
  timestamp: Date;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  atrPct14: number | null;
  adx14: number | null;
  bollingerWidth20: number | null;
  donchianHigh20: number | null;
  donchianLow20: number | null;
  donchianWidthPct20: number | null;
  realizedVol20: number | null;
  volumeSma20: number | null;
  volumeRatio20: number | null;
}

export interface IndicatorSummary {
  latest: IndicatorSnapshot | null;
  series: IndicatorSnapshot[];
  hasVolume: boolean;
}

export type MarketRegime = "RANGE" | "TREND_UP" | "TREND_DOWN" | "CHAOTIC_HIGH_VOL";

export interface MarketRegimeScores {
  range: number;
  trendUp: number;
  trendDown: number;
  chaoticHighVol: number;
}

export interface MarketRegimeAssessment {
  regime: MarketRegime;
  confidence: number;
  scores: MarketRegimeScores;
  reasons: string[];
  evaluatedAt: Date;
}

export interface BacktestConfig {
  budgetUsd: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  strategyMode: StrategyMode;
  minOrderMode: MinOrderMode;
  minOrderQuoteAmount: number;
  maxSlippageBps: number;
  executionFeeBps?: number;
  cooldownMs: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  maxConsecutiveFailures: number;
  levelLockMs: number;
  priceConfirmationWindowMs: number;
  recenterMode: RecenterMode;
  outOfRangePause: boolean;
}

export interface BacktestReplayExecution {
  id: string;
  orderKey: string;
  phase: "train" | "validation";
  side: TradeSide;
  levelIndex: number;
  targetPrice: number;
  fillPrice: number;
  inputAmount: number;
  outputAmount: number;
  feeAmount: number;
  realizedPnlDelta: number;
  status: OrderStatus;
  reason: string;
  blockedReasons?: string[];
  timestamp: Date;
  matchedLotIds?: string[];
}

export interface BacktestReplayPoint {
  timestamp: Date;
  price: number;
  phase: "train" | "validation";
  status: BotStatus;
  availableQuoteAmount: number;
  availableBaseAmount: number;
  deployedQuoteAmount: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalEquityUsd: number;
  drawdownPct: number;
  occupancyPct: number;
}

export interface BacktestMetrics {
  sampleCount: number;
  startingBudgetUsd: number;
  endingEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxOccupancyPct: number;
  timeInRangePct: number;
  timeOutOfRangePct: number;
  closedCycleCount: number;
  openCycleCount: number;
  executedBuyCount: number;
  executedSellCount: number;
  blockedOrderCount: number;
}

export interface BacktestRunMeta {
  symbol: string;
  pair: string;
  resolution?: string;
  candleCount: number;
  trainCandleCount: number;
  validationCandleCount: number;
  splitRatio: number;
  startAt: Date;
  trainEndAt: Date;
  endAt: Date;
  estimatedIntervalMs: number;
}

export interface BacktestRunResult {
  series: BacktestMarketSeries;
  config: BacktestConfig;
  replayPoints: BacktestReplayPoint[];
  executions: BacktestReplayExecution[];
  trainMetrics: BacktestMetrics;
  validationMetrics: BacktestMetrics;
  overallMetrics: BacktestMetrics;
  meta: BacktestRunMeta;
}

export interface BacktestLeaderboardEntry {
  rank: number;
  config: BacktestConfig;
  trainMetrics: BacktestMetrics;
  validationMetrics: BacktestMetrics;
}

export interface BacktestOperatorGuidance {
  status: "Healthy" | "Caution" | "Fragile";
  summary: string;
  stopRule: string;
  timeInRangePct: number;
  maxOccupancyPct: number;
}

export interface BacktestRecommendation {
  bestConfig: BacktestConfig;
  leaderboard: BacktestLeaderboardEntry[];
  bestReplay: BacktestRunResult;
  trainMetrics: BacktestMetrics;
  validationMetrics: BacktestMetrics;
  operatorGuidance: BacktestOperatorGuidance;
  meta: BacktestRunMeta & {
    candidateCount: number;
    evaluatedCount: number;
  };
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
