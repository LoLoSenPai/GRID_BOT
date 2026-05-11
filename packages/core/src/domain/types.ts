import type {
  AlertType,
  BotMode,
  BotStatus,
  EntryMode,
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
  entryMode?: EntryMode;
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

export type RecenterPolicyMode = "none" | "soft" | "hybrid" | "hard";
export type RecenterBreakoutSide = "inside" | "above" | "below";
export type RecenterPolicyRisk = "low" | "medium" | "high";

export interface RecenterPolicyInput {
  currentPrice: number;
  lowPrice: number;
  highPrice: number;
  openCycleCount: number;
  maxOccupancyPct: number;
  consecutiveOutsideBars: number;
  marketRegime?: MarketRegimeAssessment | null;
}

export interface RecenterPolicyDecision {
  mode: RecenterPolicyMode;
  side: RecenterBreakoutSide;
  allowNewBuys: boolean;
  allowRecoverySells: boolean;
  suggestedLowPrice: number | null;
  suggestedHighPrice: number | null;
  risk: RecenterPolicyRisk;
  operatorAction: string;
  reasons: string[];
}

export type RangePlanRisk = "low" | "medium" | "high";
export type RangePlanBasis = "atr" | "donchian" | "bollinger" | "current_range";
export type RangePlanMidBasis = "current_price" | "donchian_mid" | "ema_cluster" | "current_range_mid";

export interface RangePlanInput {
  currentPrice: number;
  currentLowPrice: number;
  currentHighPrice: number;
  currentLevelCount: number;
  budgetUsd: number;
  minOrderQuoteAmount: number;
  indicators?: IndicatorSnapshot | null;
  marketRegime?: MarketRegimeAssessment | null;
}

export interface RangePlanDecision {
  recommendedLowPrice: number;
  recommendedHighPrice: number;
  recommendedLevelCount: number;
  recommendedGridType: GridType;
  midPrice: number;
  midBasis: RangePlanMidBasis;
  widthPct: number;
  stepPct: number;
  basis: RangePlanBasis;
  confidence: number;
  risk: RangePlanRisk;
  operatorAction: string;
  reasons: string[];
}

export type StrategyFamily = "range_grid" | "trend_following" | "capital_defense";
export type StrategyPosture = "active" | "caution" | "pause" | "watch";
export type StrategyReadiness = "live_ready" | "paper_only" | "advisory_only" | "planned";
export type StrategyLiveAction = "keep_running" | "watch_only" | "pause_new_exposure" | "stop_or_recreate" | "paper_only";

export interface StrategyDescriptor {
  family: StrategyFamily;
  label: string;
  readiness: StrategyReadiness;
  liveEnabled: boolean;
  intendedRegimes: MarketRegime[];
  summary: string;
  operatorUse: string;
  limitations: string[];
}

export interface StrategyCandidateScore {
  family: StrategyFamily;
  score: number;
  reason: string;
  readiness: StrategyReadiness;
  liveEnabled: boolean;
}

export interface StrategySelectionInput {
  marketRegime: MarketRegimeAssessment;
  rangePlan: RangePlanDecision;
  validationMetrics?: Pick<BacktestMetrics, "timeInRangePct" | "timeOutOfRangePct" | "maxOccupancyPct" | "maxDrawdownPct" | "closedCycleCount"> | null;
}

export interface StrategySelectionDecision {
  recommendedFamily: StrategyFamily;
  activeLiveFamily: StrategyFamily;
  posture: StrategyPosture;
  liveAction: StrategyLiveAction;
  confidence: number;
  operatorAction: string;
  reasons: string[];
  candidates: StrategyCandidateScore[];
  registry: StrategyDescriptor[];
}

export interface BacktestConfig {
  budgetUsd: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  strategyMode: StrategyMode;
  rangeControlMode?: "static" | "adaptive";
  minOrderMode: MinOrderMode;
  minOrderQuoteAmount: number;
  maxSlippageBps: number;
  executionFeeBps?: number;
  executionCostSource?: BacktestExecutionCostSource;
  cooldownMs: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  maxConsecutiveFailures: number;
  levelLockMs: number;
  priceConfirmationWindowMs: number;
  recenterMode: RecenterMode;
  outOfRangePause: boolean;
}

export type BacktestExecutionCostSource = "fixed_pessimistic" | "calibrated_live_fills";

export interface ExecutionCostModelInput {
  side: TradeSide;
  levelPrice: number;
  requestedQuoteAmount?: number;
  requestedBaseAmount?: number;
  maxSlippageBps: number;
  executionFeeBps?: number;
}

export interface ExecutionCostModelReport {
  side: TradeSide;
  fillPrice: number;
  inputAmount: number;
  outputAmount: number;
  feeAmount: number;
  maxSlippageBps: number;
  executionFeeBps: number;
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

export interface BacktestRecenterEvent {
  id: string;
  phase: "train" | "validation";
  timestamp: Date;
  mode: RecenterPolicyMode;
  side: RecenterBreakoutSide;
  previousLowPrice: number;
  previousHighPrice: number;
  nextLowPrice: number;
  nextHighPrice: number;
  allowNewBuys: boolean;
  allowRecoverySells: boolean;
  applied: boolean;
  risk: RecenterPolicyRisk;
  reason: string;
}

export interface BacktestRangeAdjustmentEvent {
  id: string;
  phase: "train" | "validation";
  timestamp: Date;
  previousLowPrice: number;
  previousHighPrice: number;
  previousLevelCount: number;
  previousGridType: GridType;
  nextLowPrice: number;
  nextHighPrice: number;
  nextLevelCount: number;
  nextGridType: GridType;
  risk: RangePlanRisk;
  basis: RangePlanBasis;
  confidence: number;
  reason: string;
}

export interface BacktestReplayPoint {
  timestamp: Date;
  price: number;
  phase: "train" | "validation";
  status: BotStatus;
  activeLowPrice: number;
  activeHighPrice: number;
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
  simulatedOrderCount: number;
  recenterCount: number;
  rangeAdjustmentCount: number;
  totalFeesUsd: number;
  averageSlippageBps: number;
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

export interface BacktestAssumptions {
  candleTraversal: "bullish_open_low_high_close_bearish_open_high_low_close";
  fillPolicy: "immediate_on_confirmed_level_cross" | "immediate_on_confirmed_level_cross_or_boundary_recovery";
  executionCostModel: "pessimistic_slippage_plus_fee";
  executionCostSource: BacktestExecutionCostSource;
  maxSlippageBps: number;
  executionFeeBps: number;
  trainValidationSplit: number;
  recenterMode: RecenterMode;
  recenterScope: "advisory_only" | "simulated_when_auto_recenter";
  rangeControlMode: "static" | "adaptive_lab_only";
  outOfRangeModel: "pause_new_entries_allow_recovery_sells" | "pause_new_entries_allow_recovery_sells_and_single_l01_boundary_buy";
  excludedCosts: string[];
  notes: string[];
}

export interface BacktestRunResult {
  series: BacktestMarketSeries;
  config: BacktestConfig;
  replayPoints: BacktestReplayPoint[];
  executions: BacktestReplayExecution[];
  recenterEvents: BacktestRecenterEvent[];
  rangeAdjustmentEvents: BacktestRangeAdjustmentEvent[];
  recenterAdvice: RecenterPolicyDecision;
  trainMetrics: BacktestMetrics;
  validationMetrics: BacktestMetrics;
  overallMetrics: BacktestMetrics;
  assumptions: BacktestAssumptions;
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
  recenterAction: string;
  timeInRangePct: number;
  maxOccupancyPct: number;
}

export interface BacktestRecommendation {
  bestConfig: BacktestConfig;
  leaderboard: BacktestLeaderboardEntry[];
  bestReplay: BacktestRunResult;
  recenterAdvice: RecenterPolicyDecision;
  trainMetrics: BacktestMetrics;
  validationMetrics: BacktestMetrics;
  operatorGuidance: BacktestOperatorGuidance;
  assumptions: BacktestAssumptions;
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
  nativeFeeAmount?: number;
  nativeFeeSymbol?: string;
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
  nativeFeeAmount?: number;
  nativeFeeSymbol?: string;
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
