import { describe, expect, it } from "vitest";
import { evaluateLivePreflight } from "./portfolio-live-preflight";

const input = { totalCapital: 1000, baseAllocation: 400, feeSol: 0.02,
  walletUsdc: 1500, walletSol: 2, quoteClaims: 500, solClaims: 1.9,
  observedAt: 100000, now: 100001, blockers: [] as string[] };
describe("live capital preparation", () => {
  it("keeps equal allocations and surplus distinct without allowing execution", () => {
    expect(evaluateLivePreflight(input)).toMatchObject({ capitalReady: true, activationAllowed: false,
      freeUsdc: 1000, allocation: { BTC: 400, SOL: 400, sharedPool: 200 } });
  });
  it("does not spend existing cash claims or owned SOL as fees", () => {
    const result = evaluateLivePreflight({ ...input, quoteClaims: 501, solClaims: 2 });
    expect(result.capitalReady).toBe(false);
    expect(result.blockers).toContain("Insufficient unallocated USDC.");
    expect(result.blockers).toContain("Insufficient unallocated native SOL for the fee envelope.");
  });
  it.each([NaN, Infinity, -1])("rejects invalid balances %s", walletUsdc => {
    expect(evaluateLivePreflight({ ...input, walletUsdc }).capitalReady).toBe(false);
  });
  it.each([0, 100002, NaN])("rejects stale/future/invalid observation %s", observedAt => {
    expect(evaluateLivePreflight({ ...input, observedAt }).capitalReady).toBe(false);
  });
  it("preserves pending/reconciliation blockers despite sufficient funds", () => {
    expect(evaluateLivePreflight({ ...input, blockers: ["Pending execution"] })).toMatchObject({
      capitalReady: false, blockers: ["Pending execution"], activationAllowed: false });
  });
  it("requires explicit fee capital and funded equal allocations", () => {
    expect(evaluateLivePreflight({ ...input, feeSol: 0 }).capitalReady).toBe(false);
    expect(evaluateLivePreflight({ ...input, baseAllocation: 600 }).capitalReady).toBe(false);
  });
});
