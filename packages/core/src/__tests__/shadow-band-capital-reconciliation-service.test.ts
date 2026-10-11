import { describe, expect, it } from "vitest";
import { reconcileShadowBandCapital, type ShadowBandCapitalEntry, type ShadowBandCapitalEvidence } from "../services/shadow-band-capital-reconciliation-service";

const zero = { allocatedDelta: "0", availableDelta: "0", deployedDelta: "0", reservedDelta: "0", externalFeeDelta: "0" };
function fixture() {
  function entry(id: string, entryType: string, values: Partial<ShadowBandCapitalEntry>): ShadowBandCapitalEntry {
    return { ...zero, id, bandId: "band", portfolioId: "portfolio", entryType,
      createdAt: "2026-09-23T00:26:49.872Z", executionId: null, metadata: null, ...values };
  }
  const evidence: ShadowBandCapitalEvidence = { version: "band-ledger-v1", scope: "all_band_entries_through_state",
    bandId: "band", portfolioId: "portfolio", stateAt: "2026-09-23T01:00:00Z", extractedAt: "2026-10-06T00:00:00Z",
    rows: [entry("allocation", "BAND_ALLOCATION", { allocatedDelta: "400", availableDelta: "400" }),
      entry("reserve", "RESERVATION", { reservedDelta: "133.33" }),
      // Values from the first BTC settlement in capital-ledger.jsonl.
      entry("buy", "BUY_SETTLEMENT", { availableDelta: "-133.33", deployedDelta: "133.33060821",
        reservedDelta: "-133.33", externalFeeDelta: "0.00060821", executionId: "execution-buy",
        metadata: { applied: true, principalReturnedQuote: 0, profitSweptQuote: 0, portfolioCreditQuote: 0,
          lossRealizedQuote: 0, retainedBaseAmount: 0 } })] };
  return { portfolioId: "portfolio", band: { id: "band", createdAt: "2026-09-22T20:47:25Z",
    updatedAt: "2026-09-23T00:26:49.860Z", allocatedQuoteAmount: "400", availableQuoteAmount: "266.67",
    deployedCostQuote: "133.33060821", realizedLossQuote: "0", reservedQuoteAmount: "0" }, evidence };
}

describe("shadow band capital ledger", () => {
  it("requires no evidence for an already reconciled band", () => {
    const input = fixture(); input.band.deployedCostQuote = "133.33";
    expect(reconcileShadowBandCapital({ ...input, evidence: undefined }).status).toBe("exact");
  });
  it("proves the real first BTC fee book despite ledger creation after band update", () => {
    expect(reconcileShadowBandCapital(fixture())).toMatchObject({ status: "ledger_external_fee_match", reason: null,
      initialExternalFeeBookUsd: 0.00060821, entryCount: 3, evidenceSource: "reconstructed_after_capture" });
  });
  it("rejects unsupported adjustments without evidence", () => {
    expect(reconcileShadowBandCapital({ ...fixture(), evidence: undefined }).reason).toBe("MISSING_BAND_LEDGER");
  });
  const cases: Array<[string, (x: ReturnType<typeof fixture>) => void]> = [
    ["missing row", x => { x.evidence.rows.splice(1, 1); }],
    ["cash mismatch", x => { x.band.availableQuoteAmount = "266.68"; }],
    ["cost mismatch", x => { x.band.deployedCostQuote = "133.34"; }],
    ["loss mismatch", x => { x.band.realizedLossQuote = "0.01"; }],
    ["allocation mismatch", x => { x.band.allocatedQuoteAmount = "399"; }],
    ["reserve mismatch", x => { x.band.reservedQuoteAmount = "0.01"; }],
    ["duplicate id", x => { x.evidence.rows.push(x.evidence.rows[2]!); }],
    ["duplicate settlement", x => { x.evidence.rows.push({ ...x.evidence.rows[2]!, id: "different" }); }],
    ["wrong portfolio", x => { x.evidence.rows[0]!.portfolioId = "other"; }],
    ["wrong band", x => { x.evidence.bandId = "other"; }],
    ["unknown mutation", x => { x.evidence.rows[2]!.entryType = "RECONCILIATION"; }],
    ["future row", x => { x.evidence.rows[2]!.createdAt = "2026-09-24T00:00:00Z"; }],
    ["future band", x => { x.band.updatedAt = "2026-09-24T00:00:00Z"; }],
    ["unzoned", x => { x.evidence.rows[2]!.createdAt = "2026-09-23T00:26:49.872"; }],
    ["missing fee", x => { x.evidence.rows[2]!.externalFeeDelta = "0"; }],
    ["unproven allocation", x => { x.evidence.rows[0]!.deployedDelta = "1"; }],
    ["double counted profit sweep", x => { x.evidence.rows.push({ ...x.evidence.rows[2]!, id: "sweep", entryType: "PROFIT_SWEEP" }); }],
  ];
  it.each(cases)("censors %s", (_, mutate) => {
    const input = fixture(); mutate(input);
    expect(reconcileShadowBandCapital(input)).toMatchObject({ status: "unreconciled", initialExternalFeeBookUsd: 0 });
  });
  it.each(["profit", "small-margin", "loss"])("checks sell fee allowance with %s", kind => {
    const input = fixture(); const principal = kind === "loss" ? 130 : 133.33060821;
    const allowance = kind === "loss" ? 0 : kind === "profit" ? 0.001 : 0.0005;
    const loss = kind === "loss" ? 3.33060821 : 0;
    input.evidence.rows.push({ ...zero, id: "sell", bandId: "band", portfolioId: "portfolio", entryType: "SELL_SETTLEMENT",
      createdAt: "2026-09-23T00:27:00Z", executionId: "execution-sell", availableDelta: (principal + allowance).toFixed(10),
      deployedDelta: "-133.33060821", externalFeeDelta: "0.001",
      metadata: { applied: true, principalReturnedQuote: principal, profitSweptQuote: kind === "profit" ? 1.4225442600000051 : 0,
        portfolioCreditQuote: kind === "profit" ? 1.4225442600000051 : 0, retainedBaseAmount: 0, lossRealizedQuote: loss } });
    input.band.availableQuoteAmount = (266.67 + principal + allowance).toFixed(10);
    input.band.deployedCostQuote = "0"; input.band.realizedLossQuote = loss.toFixed(10);
    expect(reconcileShadowBandCapital(input).status).toBe("ledger_external_fee_match");
    (input.evidence.rows[3]!.metadata as Record<string, unknown>).principalReturnedQuote = principal + 0.01;
    expect(reconcileShadowBandCapital(input).status).toBe("unreconciled");
  });
  it("derives initial losses only from an explicit adopted-band anchor", () => {
    const input = fixture(), allocation = input.evidence.rows[0]!;
    allocation.availableDelta = "390"; allocation.metadata = { source: "explicit_existing_bot_adoption", attributedCapitalQuote: 400 };
    input.band.availableQuoteAmount = "256.67"; input.band.realizedLossQuote = "10";
    expect(reconcileShadowBandCapital(input).status).toBe("ledger_external_fee_match");
    allocation.metadata = null;
    expect(reconcileShadowBandCapital(input).status).toBe("unreconciled");
  });
  it("accepts only a known reservation-to-unknown transition with no capital mutation", () => {
    const input = fixture();
    input.evidence.rows.splice(2, 0, { ...input.evidence.rows[2]!, ...zero, id: "unknown-transition",
      entryType: "RECONCILIATION", metadata: { transition: "RESERVED_TO_UNKNOWN" } });
    expect(reconcileShadowBandCapital(input).status).toBe("ledger_external_fee_match");
    for (const column of Object.keys(zero) as Array<keyof typeof zero>) {
      input.evidence.rows[2]![column] = "0.01";
      expect(reconcileShadowBandCapital(input)).toMatchObject({ status: "unreconciled", reason: "UNSUPPORTED_BAND_RECONCILIATION" });
      input.evidence.rows[2]![column] = "0";
    }
    input.evidence.rows[2]!.metadata = { transition: "UNKNOWN_TO_RESERVED" };
    expect(reconcileShadowBandCapital(input).status).toBe("unreconciled");
  });
});
