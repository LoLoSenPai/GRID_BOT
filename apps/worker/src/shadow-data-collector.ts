import { GECKOTERMINAL_POOLS, MINTS } from "@grid-bot/common";
import { GeckoTerminalHistoryProvider, type NormalizedCandle } from "@grid-bot/core";
import type { ShadowQuoteComparison } from "./shadow-execution-quote-client";

export interface ShadowCollectionTarget { portfolioId: string; botId: string; symbol: "BTC" | "SOL";
  baseMint: string; quoteMint: string; orderQuoteUsd: number; publicTaker?: string }
export interface ShadowDataStore {
  targets(): Promise<ShadowCollectionTarget[]>;
  candles(rows: NormalizedCandle[]): Promise<void>;
  quote(target: ShadowCollectionTarget, payload: ShadowQuoteComparison): Promise<void>;
}
export interface ShadowCollectorDependencies {
  history: Pick<GeckoTerminalHistoryProvider, "getHistory">;
  verifyPool(target: ShadowCollectionTarget): Promise<void>;
  compare(target: ShadowCollectionTarget, quoteUsd: number): Promise<ShadowQuoteComparison>;
  onError(error: unknown, task: string): void;
}

/** Separate process, bounded reads. No trading services, signing, or portfolio mutations. */
export class ShadowDataCollector {
  private lastQuotes = new Map<string, number>();
  constructor(private readonly store: ShadowDataStore, private readonly deps: ShadowCollectorDependencies) {}
  async collect(now = new Date()): Promise<void> {
    let targets: ShadowCollectionTarget[];
    try { targets = await this.store.targets(); }
    catch (error) { this.deps.onError(error, "targets"); return; }
    const markets = new Set<string>();
    for (const target of targets) {
      if (target.baseMint !== MINTS[target.symbol] || target.quoteMint !== MINTS.USDC) {
        this.deps.onError(new Error("Configured mint differs from the collection market."), "market_identity"); continue;
      }
      if (!markets.has(target.symbol)) {
        markets.add(target.symbol);
        try {
          await this.deps.verifyPool(target);
          // Collect both assets even when only one receives a policy observation this hour.
          for (const resolution of ["5m", "1h"] as const) {
            try {
              const result = await this.deps.history.getHistory({ symbol: target.symbol, quoteSymbol: "USDC", resolution,
                from: new Date(+now - (resolution === "5m" ? 26 : 80) * 3_600_000), to: now });
              await this.store.candles(result.candles.filter(c => c.closeTime && c.closeTime <= now));
              const lastClose = result.candles.at(-1)?.closeTime;
              const interval = resolution === "5m" ? 300_000 : 3_600_000;
              if (!lastClose || +lastClose < Math.floor(+now / interval) * interval) {
                this.deps.onError(new Error(`Pool history closed through ${lastClose?.toISOString() ?? "unknown"}; no missing candles are fabricated.`),
                  `stale_${target.symbol}_${resolution}`);
              }
            } catch (error) { this.deps.onError(error, `candles_${target.symbol}_${resolution}`); }
          }
        } catch (error) { this.deps.onError(error, `pool_${target.symbol}`); }
      }
      if (+now - (this.lastQuotes.get(target.botId) ?? 0) < 30 * 60_000) continue;
      this.lastQuotes.set(target.botId, +now);
      const sizes = [...new Set([25, Math.min(250, Math.max(25, Math.round(target.orderQuoteUsd * 100) / 100))])];
      for (const size of sizes) {
        try { await this.store.quote(target, await this.deps.compare(target, size)); }
        catch (error) { this.deps.onError(error, `quote_${target.symbol}`); }
      }
    }
  }
}

export async function verifyShadowPool(target: ShadowCollectionTarget, fetchFn: typeof fetch = fetch): Promise<void> {
  const pool = target.symbol === "BTC" ? GECKOTERMINAL_POOLS.BTC_USDC : GECKOTERMINAL_POOLS.SOL_USDC;
  const response = await fetchFn(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}`,
    { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Pool identity lookup HTTP ${response.status}.`);
  const payload = await response.json() as { data?: { relationships?: { base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } } } } };
  const r = payload.data?.relationships;
  if (r?.base_token?.data?.id !== `solana_${target.baseMint}` || r?.quote_token?.data?.id !== `solana_${target.quoteMint}`) {
    throw new Error("Pool token identity does not match the bot mints.");
  }
}
