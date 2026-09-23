import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateJev, HttpJevClient, ShadowJevResponseError, ShadowJevTimeoutError } from "./shadow-jev-client";
import {
  buildJevRequest,
  type ShadowJevInput,
  type ShadowJevRequest,
} from "./shadow-jev-questions";
import type { PortfolioPolicyInput, PortfolioPolicyParameters } from "@grid-bot/core";

const parameters = {
  persistenceClosedBars: 3,
  cooldownMs: 3_600_000,
  maxDailyRevisions: 2,
  atrMultiplier: 2,
  realizedVolMultiplier: 2,
  amplitudeMultiplier: 1,
  minWidthPct: 0.02,
  maxWidthPct: 0.3,
  minUsefulOrderUsd: 10,
  maxBands: 2,
  maxLevels: 20,
  maxExposurePct: 0.8,
  lowerBandOffsetPct: 0.05,
  lowerBandWidthPct: 0.1,
  minimumSpacingPct: 0.01,
} satisfies PortfolioPolicyParameters;

function request(price = 111): ShadowJevRequest {
  const policyInput: PortfolioPolicyInput = {
    now: new Date("2026-09-23T02:00:00.000Z"),
    price,
    assetSymbol: "SOL",
    band: {
      id: "sol-main",
      lowPrice: 90,
      highPrice: 110,
      levelCount: 5,
      spacing: 5,
      status: "active",
      allocatedCapitalUsd: 500,
      idleQuoteUsd: 200,
      openTradingLots: [],
    },
    bandCount: 1,
    assetAttributedCapitalUsd: 500,
    candles: [],
    candleIntervalMs: 3_600_000,
    maxCandleAgeMs: 7_200_000,
    availableCashUsd: 200,
    totalPortfolioCapitalUsd: 1_000,
    parameters,
  };
  const input: ShadowJevInput = { observedAt: policyInput.now, policyInput };
  return buildJevRequest(input);
}

function rawResponse() {
  return {
    model: "jev-1.13.0",
    answers: {
      market_regime: {
        type: "choice",
        choice: "range",
        probabilities: {
          range: 0.7,
          drift_up: 0.1,
          drift_down: 0.05,
          unstable_transition: 0.1,
          insufficient_evidence: 0.05,
        },
        confidence: 0.62,
      },
      current_band_suitable: { type: "noul", noul: 0.77 },
      temporary_outside_excursion: { type: "noul", noul: 0.61 },
    },
    usage: { input_tokens: 420, output_tokens: 31 },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("evaluateJev", () => {
  it("retains the raw response and exposes distributions, exact models, and nouls", async () => {
    const raw = rawResponse();
    const evaluate = vi.fn().mockResolvedValue(raw);

    const result = await evaluateJev(request(), { evaluate }, { timeoutMs: 500 });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ model: "jev-1.13.0" });
    expect(evaluate.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      questionSetVersion: "shadow-jev-v1",
      modelRequested: "jev-1.13.0",
      modelResolved: "jev-1.13.0",
      answers: {
        marketRegime: { choice: "range", confidence: 0.62, probabilities: { range: 0.7 } },
        currentBandSuitable: { noul: 0.77 },
        temporaryOutsideExcursion: { noul: 0.61 },
      },
      usage: { input_tokens: 420, output_tokens: 31 },
    });
    expect(result.rawResponse).toBe(raw);
  });

  it("returns no excursion answer when that conditional question was not sent", async () => {
    const { temporary_outside_excursion: _unused, ...answers } = rawResponse().answers;
    const raw = { ...rawResponse(), answers };

    const result = await evaluateJev(request(100), { evaluate: vi.fn().mockResolvedValue(raw) });

    expect(result.answers.temporaryOutsideExcursion).toBeNull();
  });

  it("aborts and rejects with a typed error at the configured timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = evaluateJev(
      request(),
      {
        evaluate: (_request, options) => {
          signal = options?.signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        },
      },
      { timeoutMs: 25 },
    );

    const expectation = expect(pending).rejects.toEqual(expect.objectContaining<Partial<ShadowJevTimeoutError>>({
      name: "ShadowJevTimeoutError",
      timeoutMs: 25,
    }));
    await vi.advanceTimersByTimeAsync(25);
    await expectation;
    expect(signal?.aborted).toBe(true);
  });

  it("rejects malformed response probabilities instead of silently coercing them", async () => {
    const raw = rawResponse();
    raw.answers.market_regime.probabilities.range = 2;

    const evaluation = evaluateJev(request(), { evaluate: vi.fn().mockResolvedValue(raw) });
    await expect(evaluation).rejects.toBeInstanceOf(ShadowJevResponseError);
    await expect(evaluation).rejects.toMatchObject({ rawResponse: raw });
  });
});

describe("HttpJevClient", () => {
  it("uses the documented endpoint contract through an injectable fetch implementation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rawResponse()), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const client = new HttpJevClient({ apiKey: "test-key", fetchImpl });
    const input = request();

    await client.evaluate(input);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  });

  it("surfaces non-success HTTP responses without making retry policy decisions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("overloaded", { status: 529 }));
    const client = new HttpJevClient({ apiKey: "test-key", fetchImpl });

    await expect(client.evaluate(request())).rejects.toThrow("HTTP 529: overloaded");
  });
});
