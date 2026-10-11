import { Decimal } from "decimal.js";

export interface ShadowBandCapitalEntry {
  id: string; bandId: string; portfolioId: string; entryType: string; createdAt: string;
  allocatedDelta: string; availableDelta: string; deployedDelta: string; reservedDelta: string;
  externalFeeDelta: string; executionId: string | null; metadata: unknown;
}
export interface ShadowBandCapitalEvidence {
  version: "band-ledger-v1"; scope: "all_band_entries_through_state"; bandId: string; portfolioId: string;
  stateAt: string; extractedAt: string; rows: ShadowBandCapitalEntry[];
}
export interface ShadowBandCapitalReconciliation {
  bandId: string; status: "exact" | "ledger_external_fee_match" | "unreconciled"; reason: string | null;
  initialExternalFeeBookUsd: number; evidenceSource: "reconstructed_after_capture" | null; entryCount: number;
}
type Quantity = number | string;

/** Explains initial book differences only. Never credits cash, fees, equity, or policy capital. */
export function reconcileShadowBandCapital(input: {
  band: { id: string; createdAt: string | Date; updatedAt: string | Date; allocatedQuoteAmount: Quantity;
    availableQuoteAmount: Quantity; deployedCostQuote: Quantity; realizedLossQuote: Quantity; reservedQuoteAmount: Quantity };
  portfolioId: string; evidence?: ShadowBandCapitalEvidence;
}): ShadowBandCapitalReconciliation {
  const result: ShadowBandCapitalReconciliation = { bandId: input.band.id, status: "unreconciled", reason: null,
    initialExternalFeeBookUsd: 0, evidenceSource: null, entryCount: 0 };
  try {
    const band = input.band, budget = positive(band.allocatedQuoteAmount), cash = positive(band.availableQuoteAmount),
      cost = positive(band.deployedCostQuote), losses = positive(band.realizedLossQuote), reserved = positive(band.reservedQuoteAmount);
    if (close(cash.plus(cost).plus(losses), budget)) { result.status = "exact"; return result; }
    const evidence = input.evidence;
    check(evidence, "MISSING_BAND_LEDGER");
    check(evidence.version === "band-ledger-v1" && evidence.scope === "all_band_entries_through_state", "INVALID_BAND_LEDGER_SCOPE");
    check(evidence.bandId === band.id && evidence.portfolioId === input.portfolioId, "BAND_LEDGER_IDENTITY_MISMATCH");
    const genesis = time(band.createdAt), updated = time(band.updatedAt), cutoff = time(evidence.stateAt);
    check(genesis <= updated && updated <= cutoff && cutoff <= time(evidence.extractedAt), "BAND_LEDGER_BOUNDARY_MISMATCH");
    check(Array.isArray(evidence.rows) && evidence.rows.length > 0, "MISSING_BAND_LEDGER");
    let alloc = new Decimal(0), available = new Decimal(0), deployed = new Decimal(0), reserve = new Decimal(0),
      loss = new Decimal(0), feeBook = new Decimal(0), previous = -Infinity, allocations = 0;
    const ids = new Set<string>(), executions = new Set<string>();
    for (const row of evidence.rows) {
      check(row.bandId === band.id && row.portfolioId === input.portfolioId, "BAND_LEDGER_IDENTITY_MISMATCH");
      check(typeof row.id === "string" && row.id.length > 0 && !ids.has(row.id), "DUPLICATE_BAND_LEDGER_ENTRY"); ids.add(row.id);
      const at = time(row.createdAt);
      check(at >= genesis && at <= cutoff && at >= previous, "BAND_LEDGER_OUTSIDE_STATE_OR_UNORDERED"); previous = at;
      const a = decimal(row.allocatedDelta), c = decimal(row.availableDelta), d = decimal(row.deployedDelta),
        r = decimal(row.reservedDelta), fee = positive(row.externalFeeDelta);
      const meta = row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown> : {};
      let entryLoss = new Decimal(0), contribution = new Decimal(0);
      switch (row.entryType) {
        case "BAND_ALLOCATION": {
          check(a.gt(0) && c.gte(0) && d.gte(0) && r.isZero() && fee.isZero() && row.executionId === null, "INVALID_BAND_ALLOCATION");
          if (meta.source === "explicit_existing_bot_adoption") {
            check(allocations === 0 && close(positive(meta.attributedCapitalQuote), a) && c.plus(d).lte(a), "INVALID_ADOPTED_BAND_ANCHOR");
            entryLoss = a.minus(c).minus(d);
          } else check(d.isZero() && close(a, c), "UNPROVEN_INITIAL_BAND_CAPITAL");
          allocations++; break;
        }
        case "BUY_SETTLEMENT":
        case "SELL_SETTLEMENT": {
          check(allocations > 0 && typeof row.executionId === "string" && row.executionId.length > 0 &&
            !executions.has(row.executionId), "MISSING_OR_DUPLICATE_BAND_SETTLEMENT"); executions.add(row.executionId);
          check(a.isZero() && meta.applied === true, "INVALID_BAND_SETTLEMENT");
          const principal = metadataAmount(meta.principalReturnedQuote), profit = metadataAmount(meta.profitSweptQuote),
            credit = metadataAmount(meta.portfolioCreditQuote), retained = metadataAmount(meta.retainedBaseAmount);
          entryLoss = metadataAmount(meta.lossRealizedQuote);
          check(close(profit, credit), "INVALID_BAND_SETTLEMENT");
          if (row.entryType === "BUY_SETTLEMENT") {
            check(c.lt(0) && d.gt(0) && r.lt(0) && c.negated().lte(r.negated().plus("0.00000001")) &&
              principal.isZero() && profit.isZero() && entryLoss.isZero() && retained.isZero() &&
              close(d, new Decimal(Number((c.negated().plus(fee).toNumber()).toFixed(8)))), "INVALID_BUY_FEE_BOOK");
            contribution = c.plus(d);
          } else {
            const allowance = c.minus(principal);
            check(c.gte(0) && d.lt(0) && r.isZero() && close(principal.plus(entryLoss), d.negated()) &&
              allowance.gte(0) && allowance.lte(fee.plus("0.00000001")) &&
              (profit.isZero() || close(allowance, fee)) &&
              (entryLoss.isZero() || (profit.isZero() && allowance.isZero())), "INVALID_SELL_FEE_BOOK");
            contribution = c.plus(d).plus(entryLoss);
          }
          break;
        }
        case "RESERVATION":
        case "RESERVATION_RELEASE":
          check(allocations > 0 && a.isZero() && c.isZero() && d.isZero() && fee.isZero() &&
            (row.entryType === "RESERVATION" ? r.gt(0) : r.lt(0)), "INVALID_RESERVATION_LEDGER"); break;
        case "PROFIT_SWEEP":
        case "RETAINED_BASE":
          check(a.isZero() && c.isZero() && d.isZero() && r.isZero() && fee.isZero(), "INFORMATIONAL_LEDGER_MUTATES_CAPITAL"); break;
        case "RECONCILIATION":
          check(meta.transition === "RESERVED_TO_UNKNOWN" && typeof row.executionId === "string" && row.executionId.length > 0 &&
            a.isZero() && c.isZero() && d.isZero() && r.isZero() && fee.isZero(), "UNSUPPORTED_BAND_RECONCILIATION"); break;
        default: throw new Error("UNSUPPORTED_BAND_LEDGER_ENTRY");
      }
      alloc = alloc.plus(a); available = available.plus(c); deployed = deployed.plus(d); reserve = reserve.plus(r);
      loss = loss.plus(entryLoss); feeBook = feeBook.plus(contribution); result.entryCount++;
    }
    check(allocations > 0 && close(alloc, budget) && close(available, cash) && close(deployed, cost) &&
      close(reserve, reserved) && close(loss, losses), "BAND_LEDGER_BALANCE_MISMATCH");
    check(feeBook.gte(0) && close(cash.plus(cost).plus(losses), budget.plus(feeBook)), "BAND_FEE_BOOK_MISMATCH");
    result.status = "ledger_external_fee_match"; result.initialExternalFeeBookUsd = feeBook.toNumber();
    result.evidenceSource = "reconstructed_after_capture";
  } catch (error) { result.reason = error instanceof Error ? error.message : "INVALID_BAND_LEDGER"; }
  return result;
}

function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function close(a: Decimal, b: Decimal) { return a.minus(b).abs().lte("0.00000001"); }
function decimal(value: unknown) {
  check((typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)), "INVALID_BAND_LEDGER_AMOUNT");
  const d = new Decimal(value as string | number);
  check(d.isFinite() && d.decimalPlaces() <= 10 && d.abs().mul(1e10).lte(Number.MAX_SAFE_INTEGER), "INVALID_BAND_LEDGER_AMOUNT");
  return d;
}
function positive(value: unknown) { const d = decimal(value); check(d.gte(0), "INVALID_BAND_LEDGER_AMOUNT"); return d; }
// Settlement metadata stores JS arithmetic; project its sub-quantum noise to the DB scale.
function metadataAmount(value: unknown) {
  check(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1e10,
    "INVALID_BAND_LEDGER_METADATA");
  return new Decimal(value).toDecimalPlaces(10);
}
function time(value: string | Date) {
  const s = value instanceof Date ? value.toISOString() : value;
  check(typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(s), "INVALID_BAND_LEDGER_TIME");
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  check(m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]! && Number(s.slice(11, 13)) <= 23 &&
    Number(s.slice(14, 16)) <= 59 && Number(s.slice(17, 19)) <= 59 && Number.isFinite(Date.parse(s)), "INVALID_BAND_LEDGER_TIME");
  return Date.parse(s);
}
