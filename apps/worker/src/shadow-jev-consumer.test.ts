import { describe, expect, it, vi } from "vitest";
import type { ShadowJevClaim } from "@grid-bot/db";

import { ShadowJevConsumer } from "./shadow-jev-consumer";

const observedAt = new Date("2026-09-23T12:00:00.000Z");

function job(overrides: Partial<ShadowJevClaim> = {}): ShadowJevClaim {
  const candles = Array.from({ length: 24 }, (_, index) => {
    const closedAt = new Date(+observedAt - (23 - index) * 3_600_000);
    return { openedAt: new Date(+closedAt - 3_600_000).toISOString(), closedAt: closedAt.toISOString(),
      open: 100, high: 121, low: 99, close: index === 23 ? 120 : 100 };
  });
  return {
    jobId: "job-1", attemptCount: 1, leaseExpiresAt: new Date(+observedAt + 45_000),
    questionSetVersion: "shadow-jev-v1", modelRequested: "jev-1.13.0",
    observation: { id: "observation-1", portfolioId: "portfolio-1", strategyId: "strategy-1",
      bandId: "band-1", botId: "bot-1", observedAt,
      policyInput: { now: observedAt.toISOString(), price: 120, assetSymbol: "BTC",
        candleIntervalMs: 3_600_000, band: { lowPrice: 90, highPrice: 110, levelCount: 10,
          spacing: 20 / 9, status: "active" } },
      context: { strategy: { objective: "accumulate_base" } }, botState: {}, marketMeta: {},
      proposedDecision: { action: "revise" },
      marketSnapshot: { id: "market-1", contentHash: "hash", candleCount: 24, candles,
        provenance: {}, observedAt } },
    ...overrides,
  };
}

function response() {
  return { model: "jev-1.13.0", answers: {
    market_regime: { type: "choice", choice: "range", confidence: 0.6,
      probabilities: { range: 0.6, drift_up: 0.1, drift_down: 0.1,
        unstable_transition: 0.1, insufficient_evidence: 0.1 } },
    current_band_suitable: { type: "noul", noul: 0.7 },
    temporary_outside_excursion: { type: "noul", noul: 0.4 },
  }, usage: { input_tokens: 600, output_tokens: 30 } };
}

describe("ShadowJevConsumer", () => {
  it("persists a complete probability record without sending the engine decision to Jev", async () => {
    const claim = vi.fn().mockResolvedValueOnce([job()]).mockResolvedValueOnce([]);
    const outbox = { claim, complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const client = { evaluate: vi.fn(async (_request: unknown) => response()) };
    const consumer = new ShadowJevConsumer(outbox, client, "worker-1");

    expect(await consumer.processOne()).toBe(true);
    expect(await consumer.processOne()).toBe(false);
    const request = client.evaluate.mock.calls[0]![0] as { state: Record<string, unknown>; questions: Record<string, unknown> };
    expect(request.state).not.toHaveProperty("proposedDecision");
    expect(request.state).not.toHaveProperty("proposed_decision");
    expect(Object.keys(request.questions)).toEqual(["market_regime", "current_band_suitable", "temporary_outside_excursion"]);
    expect(outbox.complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1", workerId: "worker-1", modelVersion: "jev-1.13.0",
      rawRequest: request, rawResponse: response(),
      probabilities: expect.objectContaining({
        market_regime: expect.objectContaining({ probabilities: expect.objectContaining({ range: 0.6 }) }),
        current_band_suitable: { true: 0.7, false: 0.30000000000000004 },
        temporary_outside_excursion: { true: 0.4, false: 0.6 },
      }),
    }));
    expect(outbox.fail).not.toHaveBeenCalled();
  });

  it("keeps a Jev outage retryable in the outbox", async () => {
    const outbox = { claim: vi.fn(async () => [job()]), complete: vi.fn(async () => {}),
      fail: vi.fn(async () => {}) };
    const client = { evaluate: vi.fn(async (_request: unknown) => { throw new Error("remote service unavailable"); }) };
    await new ShadowJevConsumer(outbox, client, "worker-1").processOne();
    expect(outbox.complete).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", terminal: false,
      retryAt: expect.any(Date), rawRequest: expect.any(Object),
      error: { code: "Error", message: "remote service unavailable" } }));
  });

  it("does not reinterpret an old question version with current prompts", async () => {
    const outbox = { claim: vi.fn(async () => [job({ questionSetVersion: "shadow-jev-v0" })]),
      complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const client = { evaluate: vi.fn(async (_request: unknown) => response()) };
    await new ShadowJevConsumer(outbox, client, "worker-1").processOne();
    expect(client.evaluate).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(expect.objectContaining({ terminal: true, rawRequest: undefined }));
  });
});
