import type { CandleHistoryProvider } from "../domain/contracts";
import type { BotAggregate } from "../domain/types";
import type { BandExecutionContext } from "../domain/portfolio-types";
import { BotMode, BotStatus } from "../domain/enums";
import { evaluatePortfolioPolicy, type PortfolioPolicyDecision, type PortfolioPolicyInput,
  type PortfolioPolicyParameters } from "./portfolio-policy-service";

/** Repository mutations recheck revision, cash, operator status and pending execution under locks. */
export interface PortfolioManagerStore {
  listBandContexts(): Promise<BandExecutionContext[]>;
  getBot(botId: string): Promise<BotAggregate | null>;
  getContext(botId: string): Promise<BandExecutionContext | null>;
  applyDecision(context: BandExecutionContext, bot: BotAggregate, decision: PortfolioPolicyDecision, now: Date): Promise<void>;
  recordDecision(botId: string, decision: PortfolioPolicyDecision, now: Date, completeObservation?: boolean): Promise<void>;
}

export interface PortfolioPolicyInputFactory {
  (context: BandExecutionContext, bot: BotAggregate, peers: BandExecutionContext[], now: Date,
    candles: PortfolioPolicyInput["candles"], parameters: PortfolioPolicyParameters, peerBots?: BotAggregate[]): PortfolioPolicyInput;
}

/** Same pure policy is used in historical replay. This orchestrator only acquires observations and persists decisions. */
export class PortfolioManagerService {
  private running = false;
  private observed = new Map<string, number>();
  constructor(private readonly store: PortfolioManagerStore, private readonly history: CandleHistoryProvider,
    private readonly parameters: PortfolioPolicyParameters, private readonly inputFactory: PortfolioPolicyInputFactory) {}

  async runCycle(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const contexts = await this.store.listBandContexts();
      // Less-funded assets get first access to surplus; marked token prices never affect this ordering.
      contexts.sort((a, b) => a.strategy.allocatedQuoteAmount - b.strategy.allocatedQuoteAmount ||
        a.strategy.baseSymbol.localeCompare(b.strategy.baseSymbol) || a.band.id.localeCompare(b.band.id));
      for (const initial of contexts) {
        const context = await this.store.getContext(initial.band.botId);
        if (!context || context.band.status === "CLOSED" || context.capitalBlockedReason ||
          (context.portfolio.mode === BotMode.Live && !context.portfolio.autoLive)) continue;
        const observedAt = new Date(Math.floor(+now / 3_600_000) * 3_600_000);
        if (Math.max(this.observed.get(context.band.id) ?? 0, +(context.band.lastPolicyObservedAt ?? 0)) >= +observedAt) continue;
        const bot = await this.store.getBot(context.band.botId);
        if (!bot || [BotStatus.Paused, BotStatus.Stopped].includes(bot.bot.status)) continue;
        try {
          if (!bot.latestState || +now - +bot.latestState.lastProcessedAt > 120_000) throw new Error("Runtime observation is stale.");
          const result = await this.history.getHistory({ symbol: bot.bot.baseSymbol, quoteSymbol: bot.bot.quoteSymbol,
            resolution: "1h", from: new Date(+observedAt - 80 * 3_600_000), to: observedAt });
          if (result.meta.stale) throw new Error("Closed candle history is stale.");
          const candles = result.candles.filter(c => c.closeTime && c.closeTime <= observedAt).map(c => ({
            openedAt: c.openTime, closedAt: c.closeTime!, open: c.open, high: c.high, low: c.low, close: c.close,
          }));
          const latestClosed = candles.at(-1);
          if (!latestClosed || +latestClosed.closedAt !== +observedAt) throw new Error("Latest closed hour is not yet available.");
          const peers = await this.store.listBandContexts();
          const peerBots = (await Promise.all(peers.filter(p => p.portfolio.id === context.portfolio.id && p.strategy.id === context.strategy.id)
            .map(p => this.store.getBot(p.band.botId)))).filter((b): b is BotAggregate => b !== null);
          const decision = evaluatePortfolioPolicy(this.inputFactory(context, bot, peers, observedAt, candles, this.parameters, peerBots));
          if (decision.action !== "wait") await this.store.applyDecision(context, bot, decision, observedAt);
          await this.store.recordDecision(bot.bot.id, decision, observedAt);
          this.observed.set(context.band.id, +observedAt);
        } catch {
          // A failed observation or optimistic-lock conflict must not move bands or stop existing exits.
          await this.store.recordDecision(bot.bot.id, { action: "wait", reason: "Observation unavailable or state changed; adaptation deferred.",
            nextLowPrice: null, nextHighPrice: null, nextLevelCount: null, nextSpacing: null,
            protectedLowPrice: null, protectedHighPrice: null }, observedAt, false);
        }
      }
    } finally { this.running = false; }
  }
}

export const buildPortfolioPolicyInput: PortfolioPolicyInputFactory = (context, bot, peers, now, candles, parameters, peerBots = [bot]) => {
  const own = peers.filter(p => p.portfolio.id === context.portfolio.id && p.band.status !== "CLOSED");
  const r = context.band.activeRevision;
  return { now, price: candles.at(-1)?.close ?? Number.NaN,
    assetSymbol: context.strategy.baseSymbol,
    band: { id: context.band.id, lowPrice: r.lowPrice, highPrice: r.highPrice, levelCount: r.levelCount,
      spacing: (r.highPrice - r.lowPrice) / (r.levelCount - 1), status: context.band.status === "PARKED_BELOW" ? "parked" : "active",
      allocatedCapitalUsd: context.band.allocatedQuoteAmount, idleQuoteUsd: context.band.availableQuoteAmount - context.band.reservedQuoteAmount,
      openTradingLots: peerBots.flatMap(b => b.openLots.filter(l => !l.closedAt)), lastRevisionAt: r.observedAt ?? r.createdAt,
      revisionsToday: (bot.latestState?.metadata.recenterHistory ?? []).filter(t => t.slice(0, 10) === now.toISOString().slice(0, 10)).length },
    bandCount: own.filter(p => p.strategy.id === context.strategy.id).length,
    assetAttributedCapitalUsd: context.strategy.allocatedQuoteAmount,
    availableCashUsd: context.portfolio.freeQuoteAmount,
    totalPortfolioCapitalUsd: context.portfolio.freeQuoteAmount + own.reduce((sum, p) => sum + p.band.allocatedQuoteAmount, 0),
    candles, candleIntervalMs: 3_600_000, maxCandleAgeMs: 2 * 3_600_000,
    parameters: { ...parameters, minUsefulOrderUsd: Math.max(parameters.minUsefulOrderUsd, bot.config.minOrderQuoteAmount) } };
};
