import { describe, expect, it } from "vitest";
import { reconcileShadowInventory, type ShadowInventoryEvidence } from "../services/shadow-inventory-reconciliation-service";

function fixture() {
  const evidence: ShadowInventoryEvidence = { version: "ordered-receipts-v1", botId: "bot", mode: "live",
    baseMint: "SOL", quoteMint: "USDC", botCreatedAt: "2026-09-01T00:00:00Z",
    stateAt: "2026-09-01T00:00:05Z", extractedAt: "2026-10-06T00:00:00Z",
    scope: "all_bot_executions_through_position_state", rows: Array.from({ length: 5 }, (_, i) => ({
      id: `receipt-${i}`, botId: "bot", mode: "live", side: "buy", status: "filled",
      createdAt: `2026-09-01T00:00:0${i}Z`, completedAt: `2026-09-01T00:00:0${i + 1}Z`,
      executedInputAmount: "10", executedOutputAmount: "0.100000004" })) };
  return { bot: { id: "bot", mode: "live", baseMint: "SOL", quoteMint: "USDC", createdAt: evidence.botCreatedAt },
    position: { baseAmount: "0.5000000000", updatedAt: evidence.stateAt },
    lots: [{ remainingBaseAmount: "0.5000000200" }], evidence };
}

describe("shadow inventory receipt reconciliation", () => {
  it("retains the strict existing gate without requiring receipts", () => {
    const input = fixture(); input.lots[0]!.remainingBaseAmount = "0.5000000001";
    expect(reconcileShadowInventory({ ...input, evidence: undefined }).status).toBe("exact");
  });
  it("explains cumulative rounding with two independent reconstructions at the exact cutoff", () => {
    expect(reconcileShadowInventory(fixture())).toMatchObject({ status: "ordered_receipts_match", reason: null,
      receiptCount: 5, aggregateBaseAmount: "0.5000000000", receiptNetBaseAmount: "0.5000000200",
      evidenceSource: "reconstructed_after_capture" });
  });
  it("preserves missing-evidence censure", () => {
    expect(reconcileShadowInventory({ ...fixture(), evidence: undefined }).reason).toBe("MISSING_ORDERED_RECEIPTS");
  });
  const invalid: Array<[string, (input: ReturnType<typeof fixture>) => void, string]> = [
    ["missing receipt", x => { x.evidence.rows.pop(); }, "RECEIPT_RECONSTRUCTION_MISMATCH"],
    ["unordered", x => { x.evidence.rows.reverse(); }, "AMBIGUOUS_OR_UNORDERED_RECEIPTS"],
    ["duplicate", x => { x.evidence.rows[1]!.id = x.evidence.rows[0]!.id; }, "DUPLICATE_OR_INVALID_RECEIPT"],
    ["same completion", x => { x.evidence.rows[1]!.completedAt = x.evidence.rows[0]!.completedAt; }, "AMBIGUOUS_OR_UNORDERED_RECEIPTS"],
    ["wrong mode", x => { x.evidence.rows[1]!.mode = "paper"; }, "RECEIPT_IDENTITY_MISMATCH"],
    ["wrong mint", x => { x.evidence.baseMint = "BTC"; }, "RECEIPT_IDENTITY_MISMATCH"],
    ["negative prefix", x => { x.evidence.rows[0]!.side = "sell"; }, "NEGATIVE_RECEIPT_PREFIX"],
    ["future receipt", x => { x.evidence.rows[4]!.completedAt = "2026-09-01T00:00:06Z"; }, "RECEIPT_OUTSIDE_STATE_BOUNDARY"],
    ["before genesis", x => { x.evidence.rows[0]!.createdAt = "2026-08-31T00:00:00Z"; }, "RECEIPT_OUTSIDE_STATE_BOUNDARY"],
    ["unbound cutoff", x => { x.evidence.stateAt = "2026-09-01T00:00:06Z"; }, "RECEIPT_BOUNDARY_MISMATCH"],
    ["unbound genesis", x => { x.evidence.botCreatedAt = "2026-08-31T00:00:00Z"; }, "RECEIPT_BOUNDARY_MISMATCH"],
    ["unobserved state", x => { x.evidence.extractedAt = "2026-08-31T00:00:00Z"; }, "RECEIPT_BOUNDARY_MISMATCH"],
    ["unzoned date", x => { x.evidence.rows[0]!.completedAt = "2026-09-01T00:00:01"; }, "INVALID_OR_UNZONED_RECEIPT_TIME"],
    ["invalid calendar date", x => { x.evidence.rows[0]!.completedAt = "2026-02-30T00:00:01Z"; }, "INVALID_OR_UNZONED_RECEIPT_TIME"],
    ["pending", x => { x.evidence.rows[0]!.status = "pending"; }, "UNSUPPORTED_RECEIPT_STATUS"],
    ["unknown", x => { x.evidence.rows[0]!.status = "unknown"; }, "UNSUPPORTED_RECEIPT_STATUS"],
    ["partial", x => { x.evidence.rows[0]!.status = "partial"; }, "UNSUPPORTED_RECEIPT_STATUS"],
    ["uncompleted fill", x => { x.evidence.rows[0]!.completedAt = null; }, "UNSUPPORTED_RECEIPT_STATUS"],
    ["nonzero failed", x => { x.evidence.rows[0]!.status = "failed"; }, "FAILED_RECEIPT_HAS_QUANTITIES"],
    ["negative amount", x => { x.evidence.rows[0]!.executedOutputAmount = "-1"; }, "INVALID_INVENTORY_AMOUNT"],
    ["infinite amount", x => { x.evidence.rows[0]!.executedOutputAmount = "Infinity"; }, "INVALID_INVENTORY_AMOUNT"],
    ["too precise", x => { x.evidence.rows[0]!.executedOutputAmount = "0.10000000001"; }, "INVALID_INVENTORY_AMOUNT"],
    ["too large", x => { x.evidence.rows[0]!.executedOutputAmount = "999999999999999"; }, "INVALID_INVENTORY_AMOUNT"],
    ["repaired aggregate", x => { x.position.baseAmount = "0.49999998"; }, "RECEIPT_RECONSTRUCTION_MISMATCH"],
    ["altered lots", x => { x.lots[0]!.remainingBaseAmount = "0.5000000201"; }, "RECEIPT_RECONSTRUCTION_MISMATCH"],
  ];
  it.each(invalid)("rejects %s", (_, mutate, reason) => {
    const input = fixture(); mutate(input);
    expect(reconcileShadowInventory(input)).toMatchObject({ status: "unreconciled", reason, evidenceSource: null });
  });
  it("ignores failed attempts with no amounts and accepts explicit equivalent timezone offsets", () => {
    const input = fixture(); input.evidence.rows.unshift({ ...input.evidence.rows[0]!, id: "failed",
      status: "failed", completedAt: null, executedInputAmount: null, executedOutputAmount: "0" });
    input.evidence.stateAt = "2026-09-01T02:00:05+02:00";
    expect(reconcileShadowInventory(input)).toMatchObject({ status: "ordered_receipts_match", receiptCount: 5 });
  });
  it("handles a completed sell without mutating inputs", () => {
    const input = fixture(); input.evidence.rows[4]!.side = "sell";
    input.evidence.rows[4]!.executedInputAmount = "0.1";
    input.position.baseAmount = "0.3000000000"; input.lots[0]!.remainingBaseAmount = "0.3000000160";
    const before = JSON.stringify(input);
    expect(reconcileShadowInventory(input)).toMatchObject({ status: "ordered_receipts_match", receiptCount: 5 });
    expect(JSON.stringify(input)).toBe(before);
  });
});
