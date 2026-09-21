import type { BotMode, GridType } from "./enums";

export type GridBandStatus = "ACTIVE" | "PARKED_BELOW" | "CLOSED";
export type ExitTargetStatus = "KNOWN" | "UNKNOWN";
export type CapitalReservationStatus = "RESERVED" | "UNKNOWN" | "SETTLED" | "RELEASED";
export type CapitalLedgerEntryType =
  | "PORTFOLIO_FUNDING"
  | "BAND_ALLOCATION"
  | "RESERVATION"
  | "RESERVATION_RELEASE"
  | "BUY_SETTLEMENT"
  | "SELL_SETTLEMENT"
  | "PROFIT_SWEEP"
  | "RETAINED_BASE"
  | "RECONCILIATION";

export interface PortfolioRecord {
  id: string;
  mode: BotMode;
  walletIdentity: string;
  quoteMint: string;
  freeQuoteAmount: number;
  version: number;
  autoLive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetStrategyRecord {
  id: string;
  portfolioId: string;
  baseMint: string;
  baseSymbol: string;
  objective: "accumulate_base" | "accumulate_usdc";
  allocationPolicy: "equal";
  allocatedQuoteAmount: number;
  retainedBaseAmount: number;
}

export interface GridRevisionRecord {
  id: string;
  bandId: string;
  sequence: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  reason: string;
  observedAt: Date;
  snapshotId: string | null;
  createdAt: Date;
}

export interface LotExitCommitmentRecord {
  id: string;
  bandId: string;
  lotId: string;
  targetStatus: ExitTargetStatus;
  buyLevelIndex: number | null;
  sellLevelIndex: number | null;
  buyTargetPrice: number | null;
  sellTargetPrice: number | null;
  economicRule: "accumulate_base" | "accumulate_usdc";
  originRevisionId: string;
  maxAdverseDriftBps: number;
  fulfilledAt: Date | null;
  createdAt: Date;
}

export interface GridBandExecutionContext {
  lastPolicyObservedAt?: Date | null;
  id: string;
  botId: string;
  status: GridBandStatus;
  allocatedQuoteAmount: number;
  availableQuoteAmount: number;
  reservedQuoteAmount: number;
  deployedCostQuote: number;
  realizedLossQuote: number;
  activeRevision: GridRevisionRecord;
}

export interface BandExecutionContext {
  portfolio: PortfolioRecord;
  strategy: AssetStrategyRecord;
  band: GridBandExecutionContext;
  exitCommitments: LotExitCommitmentRecord[];
  capitalBlockedReason: string | null;
}

export interface CreatePortfolioInput {
  id?: string;
  mode: BotMode;
  walletIdentity: string;
  quoteMint: string;
  initialFreeQuoteAmount: number;
  /** Live portfolios are deliberately created with automation disabled. */
  autoLive?: false;
  idempotencyKey: string;
}

export interface ReservePortfolioCapitalInput {
  portfolioId: string;
  bandId: string;
  quoteAmount: number;
  idempotencyKey: string;
  reason: string;
}

export interface AllocatePortfolioCapitalInput {
  portfolioId: string;
  bandId: string;
  quoteAmount: number;
  idempotencyKey: string;
  reason: string;
}

export interface CapitalReservationRecord {
  id: string;
  portfolioId: string;
  bandId: string;
  quoteAmount: number;
  status: CapitalReservationStatus;
  idempotencyKey: string;
  executionId: string | null;
  unknownReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleasePortfolioReservationInput {
  portfolioId: string;
  reservationId: string;
  idempotencyKey: string;
  reason: string;
}

export interface ReconcilePortfolioReservationInput {
  portfolioId: string;
  reservationId: string;
  idempotencyKey: string;
  resolution: "RELEASE" | "RESTORE_RESERVED";
  reason: string;
}

export interface ExitCommitmentInput {
  lotId: string;
  targetStatus: ExitTargetStatus;
  buyLevelIndex: number | null;
  sellLevelIndex: number | null;
  buyTargetPrice: number | null;
  sellTargetPrice: number | null;
  economicRule: "accumulate_base" | "accumulate_usdc";
  originRevisionId: string;
  maxAdverseDriftBps: number;
}

export type PortfolioFillSettlementInput = {
  portfolioId: string;
  bandId: string;
  executionId: string;
  idempotencyKey: string;
  side: "buy";
  reservationId: string;
  /** Quote tokens actually debited from the band wallet balance. */
  cashQuoteDebited: number;
  /** Durable lot cost, including externally funded native fees. */
  acquiredCostQuote: number;
  externalFeeQuote?: number;
  baseReceived: number;
  exitCommitment: ExitCommitmentInput;
  reconcilesUnknown?: boolean;
} | {
  portfolioId: string;
  bandId: string;
  executionId: string;
  idempotencyKey: string;
  side: "sell";
  lotId: string;
  costBasisReleased: number;
  netQuoteReceived: number;
  externalFeeQuote?: number;
  retainedBaseAmount: number;
  /** False for a partial sell: the immutable target remains open for the same lot. */
  lotClosed?: boolean;
};

export interface PortfolioFillSettlementResult {
  applied: boolean;
  principalReturnedQuote: number;
  profitSweptQuote: number;
  portfolioCreditQuote: number;
  lossRealizedQuote: number;
  retainedBaseAmount: number;
}

export interface ReviseGridBandInput {
  portfolioId: string;
  bandId: string;
  expectedRevisionId: string;
  expectedSnapshotId: string | null;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  reason: string;
  observedAt: Date;
}

export interface AdoptExistingBotInput {
  portfolioId: string;
  botId: string;
  attributedCapitalQuote: number;
  availableQuoteAmount: number;
  reason: string;
  observedAt: Date;
  idempotencyKey: string;
}

export interface PortfolioRepository {
  createPortfolio(input: CreatePortfolioInput): Promise<PortfolioRecord>;
  listPortfolios(): Promise<PortfolioRecord[]>;
  getPortfolio(portfolioId: string): Promise<PortfolioRecord | null>;
  listBandContexts(portfolioId?: string): Promise<BandExecutionContext[]>;
  getBandContext(botId: string): Promise<BandExecutionContext | null>;
  setBandStatus(portfolioId: string, bandId: string, expectedStatus: GridBandStatus, status: GridBandStatus): Promise<void>;
  allocateCapital(input: AllocatePortfolioCapitalInput): Promise<void>;
  reserveCapital(input: ReservePortfolioCapitalInput): Promise<CapitalReservationRecord>;
  releaseReservation(input: ReleasePortfolioReservationInput): Promise<CapitalReservationRecord>;
  markReservationUnknown(portfolioId: string, reservationId: string, reason: string): Promise<CapitalReservationRecord>;
  reconcileReservation(input: ReconcilePortfolioReservationInput): Promise<CapitalReservationRecord>;
  settleFill(input: PortfolioFillSettlementInput): Promise<PortfolioFillSettlementResult>;
  reviseBand(input: ReviseGridBandInput): Promise<GridRevisionRecord>;
  adoptExistingBot(input: AdoptExistingBotInput): Promise<BandExecutionContext>;
}
