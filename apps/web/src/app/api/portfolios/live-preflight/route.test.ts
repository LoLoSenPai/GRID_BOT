import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), balances: vi.fn(), bots: vi.fn(), portfolios: vi.fn(), pending: vi.fn() }));
vi.mock("@/lib/auth", () => ({ readSession: mocks.session }));
vi.mock("@grid-bot/core", () => ({ WalletService: { fromEnv: () => ({ getBalances: mocks.balances, getPubkey: () => "wallet" }) } }));
vi.mock("@grid-bot/db", () => ({ prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({
  bot: { findMany: mocks.bots }, portfolio: { findMany: mocks.portfolios }, executionAttempt: { count: mocks.pending },
}) } }));
import { MINTS } from "@grid-bot/common";
import { POST } from "./route";
const request = () => new Request("http://localhost/api/portfolios/live-preflight", { method: "POST",
  body: JSON.stringify({ totalCapital: 1000, baseAllocation: 400, feeSol: 0.02 }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({});
  mocks.balances.mockResolvedValue({ pubkey: "wallet", usdc: 1500, sol: 2 });
  mocks.bots.mockResolvedValue([]); mocks.portfolios.mockResolvedValue([]); mocks.pending.mockResolvedValue(0);
});
describe("live preflight route", () => {
  it("requires authentication before wallet access", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401); expect(mocks.balances).not.toHaveBeenCalled();
  });
  it("counts stopped legacy cash including profits and protects owned SOL", async () => {
    mocks.bots.mockResolvedValue([{ archivedAt: null, status: "stopped", gridBand: null, baseMint: MINTS.SOL,
      stateSnapshots: [{ availableQuoteAmount: 600, realizedPnlUsd: 200, availableBaseAmount: 2 }], positionLots: [] }]);
    const body = await (await POST(request())).json();
    expect(body).toMatchObject({ quoteClaims: 600, solClaims: 2, freeUsdc: 900, capitalReady: false, activationAllowed: false });
  });
  it("counts portfolio cash once including reservations, never deployed base cost", async () => {
    mocks.portfolios.mockResolvedValue([{ walletIdentity: "wallet", quoteMint: MINTS.USDC, freeQuoteAmount: 200,
      assetStrategies: [{ bands: [{ status: "ACTIVE", availableQuoteAmount: 300, reservedQuoteAmount: 50, deployedCostQuote: 700 }] }] }]);
    mocks.bots.mockResolvedValue([{ archivedAt: null, gridBand: {}, baseMint: MINTS.BTC, positionLots: [],
      stateSnapshots: [{ availableQuoteAmount: 300, availableBaseAmount: 0.01 }] }]);
    expect(await (await POST(request())).json()).toMatchObject({ quoteClaims: 500, capitalReady: true, activationAllowed: false });
  });
  it("blocks pending transactions and unresolved archived inventory", async () => {
    mocks.pending.mockResolvedValue(1);
    mocks.bots.mockResolvedValue([{ archivedAt: new Date(), positionLots: [{}], stateSnapshots: [] }]);
    const body = await (await POST(request())).json();
    expect(body.capitalReady).toBe(false); expect(body.blockers).toHaveLength(2);
  });
  it("fails closed on RPC failure", async () => {
    mocks.balances.mockRejectedValue(new Error("private RPC details"));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("private RPC");
  });
});
