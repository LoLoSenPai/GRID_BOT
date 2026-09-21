import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { username: "operator" } as { username: string } | null,
  createPaperPortfolio: vi.fn(), listPortfolios: vi.fn(), listBandContexts: vi.fn(), getPortfolio: vi.fn(),
  loadHistory: vi.fn(), initialEnvelope: vi.fn(), groupPositionLots: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ readSession: async () => mocks.session }));
vi.mock("../history", () => ({ loadPortfolioHistory: mocks.loadHistory }));
vi.mock("@grid-bot/core", () => ({ initialPortfolioEnvelope: mocks.initialEnvelope }));
vi.mock("@grid-bot/db", () => ({
  createPaperPortfolio: mocks.createPaperPortfolio,
  prisma: { positionLot: { groupBy: mocks.groupPositionLots } },
  PrismaPortfolioRepository: class {
    listPortfolios = mocks.listPortfolios;
    listBandContexts = mocks.listBandContexts;
    getPortfolio = mocks.getPortfolio;
  },
}));

import { GET, POST } from "../route";

beforeEach(() => {
  mocks.session = { username: "operator" };
  for (const mock of [mocks.createPaperPortfolio, mocks.listPortfolios, mocks.listBandContexts,
    mocks.getPortfolio, mocks.loadHistory, mocks.initialEnvelope, mocks.groupPositionLots]) mock.mockReset();
  mocks.loadHistory.mockImplementation(async (symbol: string, _from: Date, to: Date) => history(symbol, to, 82));
  mocks.initialEnvelope.mockReturnValue({ lowPrice: 90, highPrice: 110, levelCount: 5 });
  mocks.createPaperPortfolio.mockResolvedValue("portfolio-paper");
  mocks.getPortfolio.mockResolvedValue({ id: "portfolio-paper", mode: "paper", autoLive: false,
    freeQuoteAmount: 2000, version: 1 });
  mocks.listBandContexts.mockResolvedValue([context("portfolio-paper", "BTC")]);
  mocks.groupPositionLots.mockResolvedValue([]);
});

describe("portfolio collection route", () => {
  it("requires an authenticated session", async () => {
    mocks.session = null;
    expect((await GET()).status).toBe(401);
    expect((await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000 }))).status).toBe(401);
  });

  it("maps only paper portfolios to the portfolio console contract", async () => {
    mocks.listPortfolios.mockResolvedValue([
      { id: "portfolio-paper", mode: "paper", autoLive: false, freeQuoteAmount: 2000, version: 2 },
      { id: "portfolio-live", mode: "live", autoLive: false, freeQuoteAmount: 10, version: 1 },
    ]);
    mocks.listBandContexts.mockResolvedValue([context("portfolio-paper", "BTC"), context("portfolio-live", "SOL")]);
    const response = await GET();
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.portfolios).toHaveLength(1);
    expect(payload.portfolios[0]).toMatchObject({ id: "portfolio-paper", mode: "paper",
      bands: [{ baseSymbol: "BTC", lowPrice: 90, highPrice: 110, levelCount: 5 }] });
  });

  it("reports retained base per band from that bot's retained lots", async () => {
    mocks.listPortfolios.mockResolvedValue([
      { id: "portfolio-paper", mode: "paper", autoLive: false, freeQuoteAmount: 2000, version: 2 },
    ]);
    mocks.listBandContexts.mockResolvedValue([
      context("portfolio-paper", "BTC", "bot-btc-lower"),
      context("portfolio-paper", "BTC", "bot-btc-upper"),
    ]);
    mocks.groupPositionLots.mockResolvedValue([
      { botId: "bot-btc-lower", _sum: { remainingBaseAmount: 0.25 } },
      { botId: "bot-btc-upper", _sum: { remainingBaseAmount: 0.1 } },
    ]);

    const payload = await (await GET()).json();
    expect(payload.portfolios[0].bands.map((band: { retainedBaseAmount: number }) => band.retainedBaseAmount))
      .toEqual([0.25, 0.1]);
  });

  it("builds BTC and SOL envelopes from 80 closed candles and creates paper only", async () => {
    const response = await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000, requestId: "request-123" }));
    const payload = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.loadHistory).toHaveBeenCalledTimes(2);
    expect(mocks.initialEnvelope).toHaveBeenCalledTimes(2);
    expect(mocks.initialEnvelope.mock.calls.every((call) => call[0].length === 80)).toBe(true);
    expect(mocks.createPaperPortfolio).toHaveBeenCalledWith(expect.objectContaining({ totalCapitalUsd: 4000,
      baseAllocationUsd: 1000, requestId: "request-123", envelopes: {
        BTC: { lowPrice: 90, highPrice: 110, levelCount: 5 },
        SOL: { lowPrice: 90, highPrice: 110, levelCount: 5 },
      } }));
    expect(payload.portfolio.mode).toBe("paper");
    expect(payload.portfolio.autoLive).toBe(false);
    expect(payload.inputs.sources.BTC.candles).toHaveLength(80);
  });

  it("rejects capital that cannot equally fund both base allocations", async () => {
    const response = await POST(request({ totalCapitalUsd: 1500, baseAllocationUsd: 1000 }));
    expect(response.status).toBe(400);
    expect(mocks.loadHistory).not.toHaveBeenCalled();
    expect(mocks.createPaperPortfolio).not.toHaveBeenCalled();
  });

  it("rejects stale cached history before creating a portfolio", async () => {
    mocks.loadHistory.mockImplementation(async (symbol: string, _from: Date, to: Date) => ({
      ...history(symbol, to, 82), meta: { ...history(symbol, to, 82).meta, stale: symbol === "BTC" },
    }));
    const response = await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000 }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("stale");
    expect(mocks.createPaperPortfolio).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request("http://localhost/api/portfolios", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

function history(symbol: string, to: Date, count: number) {
  const end = to.getTime();
  return { candles: Array.from({ length: count }, (_, index) => {
    const openTime = new Date(end - (count - index) * 3_600_000);
    return { provider: "public-test", symbol, quoteSymbol: "USDC", resolution: "1h", sourceMarket: `pool:${symbol}`,
      openTime, closeTime: new Date(+openTime + 3_600_000), open: 100, high: 101, low: 99, close: 100,
      volume: null, fetchedAt: to };
  }), meta: { provider: "public-test", sourceMarket: `pool:${symbol}`, fetchedAt: to } };
}

function context(portfolioId: string, baseSymbol: string, botId = `bot-${baseSymbol}`) {
  return { portfolio: { id: portfolioId }, strategy: { baseSymbol, retainedBaseAmount: 0 }, capitalBlockedReason: null,
    band: { id: `band-${botId}`, botId, status: "ACTIVE", allocatedQuoteAmount: 1000,
      availableQuoteAmount: 1000, reservedQuoteAmount: 0, activeRevision: { id: `revision-${baseSymbol}`,
        lowPrice: 90, highPrice: 110, levelCount: 5 } } };
}
