export interface ShadowExecutionQuoteClientOptions {
  /** Separate shadow key; never fall back to the execution key. */
  apiKey?: string; quotaIsolated?: boolean; buildTakerPublicKey?: string;
  timeoutMs?: number; maxComparisonSkewMs?: number; fetchFn?: typeof fetch; now?: () => Date;
}
export interface ShadowQuoteComparisonRequest {
  baseMint: string; quoteMint: string; rawQuoteAmount: string; slippageBps?: number;
}
export interface CompactShadowQuote {
  endpoint: "order" | "build"; inputMint: string; outputMint: string;
  inAmount: string; outAmount: string; minimumOutAmount: string | null;
  feeBps: number | null; feeMint: string | null; router: string | null;
  estimatedNativeFeeLamports: number | null;
  startedAt: string; completedAt: string; elapsedMs: number;
}
export interface ShadowQuotePath {
  endpoint: "order" | "build"; status: "completed" | "partial" | "failed" | "skipped";
  buy: CompactShadowQuote | null; reverse: CompactShadowQuote | null;
  netRoundTripLossBps: number | null; warnings: string[];
}
export interface ShadowQuoteComparison {
  version: "shadow-quote-comparison-v1"; capturedAt: string; completedAt: string;
  baseMint: string; quoteMint: string; rawQuoteAmount: string;
  status: "completed" | "partial" | "failed" | "skipped"; paths: ShadowQuotePath[];
  comparisonSkewMs: number | null; economicallyComparable: false; warnings: string[];
}

/** Dedicated serial quote reader. Cannot sign, submit, execute, or access a wallet. */
export class ShadowExecutionQuoteClient {
  private active = false;
  constructor(private readonly options: ShadowExecutionQuoteClientOptions = {}) {}

  async compare(request: ShadowQuoteComparisonRequest): Promise<ShadowQuoteComparison> {
    const start = this.now();
    const summary: ShadowQuoteComparison = { version: "shadow-quote-comparison-v1", capturedAt: start.toISOString(), completedAt: start.toISOString(),
      baseMint: request.baseMint, quoteMint: request.quoteMint, rawQuoteAmount: request.rawQuoteAmount,
      status: "skipped", paths: [], comparisonSkewMs: null, economicallyComparable: false,
      warnings: ["prospective_quotes_are_not_fills", "build_network_cost_unknown_no_economic_winner", "amm_spread_impact_not_separately_identifiable"] };
    if (!this.options.apiKey || !this.options.quotaIsolated) {
      summary.warnings.push(!this.options.apiKey ? "shadow_api_key_missing" : "independent_quota_not_confirmed");
      return summary;
    }
    if (this.active) { summary.warnings.push("shadow_quote_reader_busy"); return summary; }
    if (!mint(request.baseMint) || !mint(request.quoteMint) || request.baseMint === request.quoteMint || !rawAmount(request.rawQuoteAmount) ||
      (request.slippageBps !== undefined && (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000))) {
      return { ...summary, status: "failed", warnings: [...summary.warnings, "invalid_shadow_quote_request"] };
    }
    this.active = true;
    try {
      // Four requests at most, one outstanding at a time. Reverse input is the net first-leg output.
      for (const endpoint of ["order", "build"] as const) summary.paths.push(await this.path(endpoint, request));
      const buyTimes = summary.paths.flatMap(path => path.buy ? [new Date(path.buy.startedAt).getTime()] : []);
      summary.comparisonSkewMs = buyTimes.length === 2 ? Math.abs(buyTimes[1]! - buyTimes[0]!) : null;
      if (summary.comparisonSkewMs !== null && summary.comparisonSkewMs > (this.options.maxComparisonSkewMs ?? 15_000))
        summary.warnings.push("comparison_quotes_time_skew_exceeded");
      const completed = summary.paths.filter(path => path.status === "completed").length;
      summary.status = completed === 2 ? "completed" : summary.paths.some(path => path.buy !== null) ? "partial" : "failed";
      summary.completedAt = this.now().toISOString();
      return summary;
    } finally { this.active = false; }
  }

  private async path(endpoint: "order" | "build", request: ShadowQuoteComparisonRequest): Promise<ShadowQuotePath> {
    const path: ShadowQuotePath = { endpoint, status: "failed", buy: null, reverse: null, netRoundTripLossBps: null,
      warnings: ["net_outputs_include_swap_fees_do_not_deduct_again", "round_trip_excludes_native_cost_and_future_price_movement"] };
    if (endpoint === "build" && !mint(this.options.buildTakerPublicKey))
      return { ...path, status: "skipped", warnings: [...path.warnings, "build_public_taker_missing"] };
    try {
      path.buy = await this.quote(endpoint, request.quoteMint, request.baseMint, request.rawQuoteAmount, request.slippageBps);
      path.reverse = await this.quote(endpoint, request.baseMint, request.quoteMint, path.buy.outAmount, request.slippageBps);
      // Compare raw quote-token units, exactly the same mint/decimals. No float conversion of u64 token amounts.
      const input = BigInt(request.rawQuoteAmount), finalOutput = BigInt(path.reverse.outAmount);
      path.netRoundTripLossBps = Number((input - finalOutput) * 1_000_000n / input) / 100;
      path.status = "completed";
      return path;
    } catch (error) {
      path.status = path.buy ? "partial" : "failed";
      path.warnings.push(error instanceof ShadowQuoteError ? error.code : "shadow_quote_request_failed");
      return path;
    }
  }

  private async quote(endpoint: "order" | "build", inputMint: string, outputMint: string, amount: string, slippageBps?: number): Promise<CompactShadowQuote> {
    const started = this.now();
    const query = new URLSearchParams({ inputMint, outputMint, amount });
    if (slippageBps !== undefined) query.set("slippageBps", String(slippageBps));
    // /order omits taker, so Jupiter returns a quote without a transaction. /build needs a public address.
    if (endpoint === "build") query.set("taker", this.options.buildTakerPublicKey!);
    const controller = new AbortController();
    const configuredTimeout = this.options.timeoutMs ?? 3_000;
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(10_000, Math.max(10, configuredTimeout)) : 3_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new ShadowQuoteError("shadow_quote_timeout"));
    }, timeoutMs); });
    try {
      const body: unknown = await Promise.race([timeout, (async () => {
        const response = await (this.options.fetchFn ?? fetch)(`https://api.jup.ag/swap/v2/${endpoint}?${query}`, {
          method: "GET", headers: { "x-api-key": this.options.apiKey! }, signal: controller.signal, redirect: "error" });
        if (!response.ok) throw new ShadowQuoteError(Number.isInteger(response.status)
          ? `shadow_quote_http_${response.status}` : "shadow_quote_http_error");
        return response.json();
      })()]);
      const row = object(body);
      if (row.error !== undefined || row.errorCode !== undefined || row.errorMessage !== undefined)
        throw new ShadowQuoteError("shadow_quote_provider_error");
      if (row.inputMint !== inputMint || row.outputMint !== outputMint || row.inAmount !== amount || !rawAmount(row.outAmount))
        throw new ShadowQuoteError("shadow_quote_provenance_mismatch");
      const minimum = row.otherAmountThreshold;
      if (minimum !== undefined && (!rawAmount(minimum) || BigInt(minimum) > BigInt(row.outAmount)))
        throw new ShadowQuoteError("shadow_quote_minimum_invalid");
      if (row.swapMode !== undefined && row.swapMode !== "ExactIn") throw new ShadowQuoteError("shadow_quote_swap_mode_invalid");
      const ended = this.now();
      const native = [row.signatureFeeLamports, row.prioritizationFeeLamports, row.rentFeeLamports];
      const nativeFee = native.every(nonnegativeInteger) ? native.reduce<number>((sum, n) => sum + (n as number), 0) : null;
      // Allowlist only. Transactions, instructions, response keys and arbitrary error text are discarded.
      return { endpoint, inputMint, outputMint, inAmount: amount, outAmount: row.outAmount,
        minimumOutAmount: typeof minimum === "string" ? minimum : null,
        feeBps: endpoint === "build" ? 0 : bps(row.feeBps) ?? bps(object(row.platformFee).feeBps),
        feeMint: mint(row.feeMint) ? row.feeMint : null, router: endpoint === "build" ? "metis" : label(row.router),
        estimatedNativeFeeLamports: endpoint === "build" ? null : nativeFee !== null && Number.isSafeInteger(nativeFee) ? nativeFee : null,
        startedAt: started.toISOString(), completedAt: ended.toISOString(), elapsedMs: Math.max(0, ended.getTime() - started.getTime()) };
    } finally { clearTimeout(timer); }
  }
  private now() { return (this.options.now ?? (() => new Date()))(); }
}
class ShadowQuoteError extends Error { constructor(readonly code: string) { super(code); } }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function rawAmount(value: unknown): value is string { return typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) > 0n && BigInt(value) <= 18_446_744_073_709_551_615n; }
function mint(value: unknown): value is string { return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value); }
function label(value: unknown): string | null { return typeof value === "string" && /^[a-zA-Z0-9 _.-]{1,50}$/.test(value) ? value : null; }
function nonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function bps(value: unknown): number | null { return nonnegativeInteger(value) && value <= 10_000 ? value : null; }
