import { describe, expect, it, vi } from "vitest";
import { MINTS } from "@grid-bot/common";
import { PrismaShadowCostRepository } from "../repositories/shadow-cost-repository";

const asOf = new Date("2026-09-30T12:00:00Z");
function client(baseMint: string = MINTS.SOL) {
  return { bot: { findFirst: vi.fn(async () => ({ id: "bot", baseSymbol: baseMint === MINTS.SOL ? "SOL" : "BTC",
    baseMint, quoteMint: MINTS.USDC, baseDecimals: 9, quoteDecimals: 6 })) },
    execution: { findMany: vi.fn(async () => [{ id: "execution", botId: "bot", provider: "jupiter", mode: "live", status: "filled",
      createdAt: new Date("2026-09-30T10:00:00Z"), completedAt: new Date("2026-09-30T10:00:02Z"),
      executedInputAmount: "100", executedOutputAmount: "1", rawReport: {}, order: { side: "buy" } }]) },
    priceSnapshot: { findFirst: vi.fn(async () => null) }, $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: "immutable", contentHash: "hash" }]) };
}

describe("isolated observed cost repository", () => {
  it("reads causal fills using completedAt, validates portfolio and avoids SOL snapshot history scans", async () => {
    const mock = client();
    const report = await new PrismaShadowCostRepository(mock as never).readAuditReport("portfolio", "bot", asOf);
    const query = mock.execution.findMany.mock.calls[0] as unknown as [{ where: { completedAt: { lte: Date } }; select: object }];
    expect(query[0].where.completedAt.lte).toEqual(asOf); expect(JSON.stringify(query[0].select)).not.toContain("attempt");
    expect(mock.bot.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "bot", gridBand: { assetStrategy: { portfolioId: "portfolio" } } } }));
    expect(mock.priceSnapshot.findFirst).not.toHaveBeenCalled(); expect(mock.$executeRaw).not.toHaveBeenCalled();
    expect(report.profile.usable).toBe(false); expect(report.executions[0]?.walletNativeCostUsd).toBeNull();
  });
  it("fetches only one indexed past SOL price per non-SOL fill", async () => {
    const mock = client(MINTS.BTC);
    await new PrismaShadowCostRepository(mock as never).readProfile("portfolio", "bot", asOf);
    expect(mock.priceSnapshot.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      symbol: "SOL", createdAt: { lte: asOf }, capturedAt: { gte: new Date("2026-09-30T09:00:02Z"), lte: new Date("2026-09-30T10:00:02Z") } },
      orderBy: { capturedAt: "desc" } }));
  });
  it("loads the native quote valuation frozen with completion and avoids a purged price cache", async () => {
    const mock = client(MINTS.BTC);
    const stored = (await mock.execution.findMany())[0]!;
    Object.assign(stored, { executedFeeAmount: "0.00060821", rawReport: {
      nativeFeeBasis: "confirmed-wallet-sol-delta", totalWalletNativeCostLamports: 5_111,
      order: { inputMint: MINTS.USDC, outputMint: MINTS.BTC, inAmount: "100000000", outAmount: "1000000000", feeMint: MINTS.BTC, feeBps: 0 },
      executeResponse: { totalInputAmount: "100000000", totalOutputAmount: "1000000000", inputAmountResult: "100000000", outputAmountResult: "1000000000" },
    } });
    mock.execution.findMany.mockResolvedValue([stored]);
    const report = await new PrismaShadowCostRepository(mock as never).readAuditReport("portfolio", "bot", asOf);
    expect(mock.execution.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ select: expect.objectContaining({ executedFeeAmount: true }) }));
    expect(mock.priceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(report.executions[0]).toMatchObject({ walletNativeCostUsd: 0.00060821,
      walletNativeCostUsdBasis: "persisted-executed-fee-quote", walletNativeCostUsdValuedAt: "2026-09-30T10:00:02.000Z" });
  });
  it("deduplicates immutable prospective observations without upsert or update", async () => {
    const mock = client(); const repo = new PrismaShadowCostRepository(mock as never);
    const capture = { portfolioId: "portfolio", botId: "bot", capturedAt: asOf, payload: { version: "v1", paths: [{ outAmount: "100" }] } };
    expect(await repo.captureQuoteComparison(capture)).toEqual({ id: "immutable", contentHash: "hash" });
    const query = mock.$executeRaw.mock.calls[0] as unknown as [{ strings: string[]; values: unknown[] }];
    expect(query[0].strings.join(" ")).toContain("ON CONFLICT"); expect(query[0].strings.join(" ")).toContain("DO NOTHING");
    const firstHash = query[0].values[1]; await repo.captureQuoteComparison({ ...capture, payload: { paths: [{ outAmount: "100" }], version: "v1" } });
    const second = mock.$executeRaw.mock.calls[1] as unknown as [{ values: unknown[] }];
    expect(second[0].values[1]).toBe(firstHash);
  });
  it("refuses authorizations, instructions or API keys before a database write", async () => {
    const mock = client(); const repo = new PrismaShadowCostRepository(mock as never);
    for (const payload of [{ transaction: "sensitive" }, { paths: [{ swapInstruction: "sensitive" }] }, { apiKey: "sensitive" }]) {
      await expect(repo.captureQuoteComparison({ portfolioId: "portfolio", botId: "bot", capturedAt: asOf, payload })).rejects.toThrow("public compact quote");
    }
    expect(mock.$executeRaw).not.toHaveBeenCalled();
  });
  it("refuses prospective quotes completed after their asserted capture timestamp", async () => {
    const mock = client();
    await expect(new PrismaShadowCostRepository(mock as never).captureQuoteComparison({ portfolioId: "portfolio", botId: "bot", capturedAt: asOf,
      payload: { completedAt: "2026-09-30T12:00:01Z" } })).rejects.toThrow("completed before capture");
    expect(mock.$executeRaw).not.toHaveBeenCalled();
  });
});
