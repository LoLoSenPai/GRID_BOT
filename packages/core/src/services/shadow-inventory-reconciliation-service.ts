import { Decimal } from "decimal.js";

export interface ShadowInventoryReceipt {
  id: string; botId: string; mode: "live" | "paper"; side: "buy" | "sell"; status: string;
  createdAt: string; completedAt: string | null;
  executedInputAmount: string | null; executedOutputAmount: string | null;
}
export interface ShadowInventoryEvidence {
  version: "ordered-receipts-v1"; botId: string; mode: "live" | "paper";
  baseMint: string; quoteMint: string; botCreatedAt: string; stateAt: string; extractedAt: string;
  scope: "all_bot_executions_through_position_state"; rows: ShadowInventoryReceipt[];
}
export interface ShadowInventoryReconciliation {
  botId: string;
  status: "exact" | "ordered_receipts_match" | "unreconciled"; reason: string | null;
  receiptCount: number; aggregateBaseAmount: string | null; receiptNetBaseAmount: string | null;
  lotBaseAmount: string; positionBaseAmount: string;
  evidenceSource: "reconstructed_after_capture" | null;
}

/** Reconstructs only shadow input. Completeness of the extraction is a loader obligation;
 * matching receipts demonstrate compatibility, not the absence of historical repairs. */
export function reconcileShadowInventory(input: {
  bot: { id: string; mode: string; baseMint: string; quoteMint: string; createdAt: string | Date };
  position: { baseAmount: string | number; updatedAt: string | Date };
  lots: Array<{ remainingBaseAmount: string | number }>;
  evidence?: ShadowInventoryEvidence;
}): ShadowInventoryReconciliation {
  const result: ShadowInventoryReconciliation = { botId: input.bot.id, status: "unreconciled", reason: null, receiptCount: 0,
    aggregateBaseAmount: null, receiptNetBaseAmount: null, lotBaseAmount: "", positionBaseAmount: "",
    evidenceSource: null };
  try {
    const position = amount(input.position.baseAmount), lots = input.lots.map(lot => amount(lot.remainingBaseAmount));
    const lotTotal = lots.reduce((sum, lot) => sum.plus(lot), new Decimal(0));
    result.positionBaseAmount = position.toFixed(10); result.lotBaseAmount = lotTotal.toFixed(10);
    // Preserve the existing compatibility gate; no expanded tolerance is introduced.
    if (Math.abs(input.lots.reduce((sum, lot) => sum + Number(lot.remainingBaseAmount), 0) - position.toNumber()) <= 1e-8) {
      result.status = "exact"; return result;
    }
    const evidence = input.evidence;
    check(evidence, "MISSING_ORDERED_RECEIPTS");
    check(evidence.version === "ordered-receipts-v1" && evidence.scope === "all_bot_executions_through_position_state",
      "INVALID_RECEIPT_SCOPE");
    check(evidence.botId === input.bot.id && evidence.mode === input.bot.mode &&
      (evidence.mode === "live" || evidence.mode === "paper") && evidence.baseMint === input.bot.baseMint &&
      evidence.quoteMint === input.bot.quoteMint, "RECEIPT_IDENTITY_MISMATCH");
    const genesis = timestamp(input.bot.createdAt), cutoff = timestamp(input.position.updatedAt);
    check(timestamp(evidence.botCreatedAt) === genesis && timestamp(evidence.stateAt) === cutoff &&
      genesis <= cutoff && timestamp(evidence.extractedAt) >= cutoff, "RECEIPT_BOUNDARY_MISMATCH");
    check(Array.isArray(evidence.rows) && evidence.rows.length > 0, "MISSING_ORDERED_RECEIPTS");
    const ids = new Set<string>(); let previous = -Infinity, aggregate = 0, net = new Decimal(0);
    for (const row of evidence.rows) {
      check(typeof row.id === "string" && row.id.length > 0 && !ids.has(row.id), "DUPLICATE_OR_INVALID_RECEIPT");
      ids.add(row.id);
      check(row.botId === input.bot.id && row.mode === input.bot.mode && (row.side === "buy" || row.side === "sell"),
        "RECEIPT_IDENTITY_MISMATCH");
      const created = timestamp(row.createdAt);
      check(created >= genesis && created <= cutoff, "RECEIPT_OUTSIDE_STATE_BOUNDARY");
      const completed = row.completedAt === null ? null : timestamp(row.completedAt);
      check(completed === null || (completed >= created && completed <= cutoff), "RECEIPT_OUTSIDE_STATE_BOUNDARY");
      if (row.status === "failed") {
        check((row.executedInputAmount === null || amount(row.executedInputAmount).isZero()) &&
          (row.executedOutputAmount === null || amount(row.executedOutputAmount).isZero()), "FAILED_RECEIPT_HAS_QUANTITIES");
        continue;
      }
      check(row.status === "filled" && completed !== null, "UNSUPPORTED_RECEIPT_STATUS");
      check(completed > previous, "AMBIGUOUS_OR_UNORDERED_RECEIPTS"); previous = completed;
      check(typeof row.executedInputAmount === "string" && typeof row.executedOutputAmount === "string", "MISSING_RECEIPT_QUANTITIES");
      const spent = amount(row.executedInputAmount), received = amount(row.executedOutputAmount);
      check(spent.gt(0) && received.gt(0), "INVALID_RECEIPT_QUANTITIES");
      const signed = row.side === "buy" ? received : spent.negated();
      aggregate = Number((aggregate + signed.toNumber()).toFixed(8)); net = net.plus(signed);
      check(aggregate >= 0 && net.gte(0), "NEGATIVE_RECEIPT_PREFIX");
      amount(aggregate); amount(net.toFixed(10));
      result.receiptCount++;
    }
    result.aggregateBaseAmount = new Decimal(aggregate).toFixed(10); result.receiptNetBaseAmount = net.toFixed(10);
    check(result.receiptCount > 0 && new Decimal(aggregate).eq(position) && net.eq(lotTotal), "RECEIPT_RECONSTRUCTION_MISMATCH");
    result.status = "ordered_receipts_match"; result.evidenceSource = "reconstructed_after_capture";
  } catch (error) { result.reason = error instanceof Error ? error.message : "INVALID_INVENTORY_EVIDENCE"; }
  return result;
}

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function amount(value: string | number): Decimal {
  check((typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)), "INVALID_INVENTORY_AMOUNT");
  const parsed = new Decimal(value);
  // Ten-decimal integer units must remain exactly representable for the JS projection.
  check(parsed.isFinite() && parsed.gte(0) && parsed.decimalPlaces() <= 10 &&
    parsed.mul(1e10).lte(Number.MAX_SAFE_INTEGER), "INVALID_INVENTORY_AMOUNT");
  return parsed;
}
function timestamp(value: string | Date): number {
  const source = value instanceof Date ? value.toISOString() : value;
  check(typeof source === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(source),
    "INVALID_OR_UNZONED_RECEIPT_TIME");
  const year = Number(source.slice(0, 4)), month = Number(source.slice(5, 7)), day = Number(source.slice(8, 10));
  const monthDays = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  check(month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]! &&
    Number(source.slice(11, 13)) <= 23 && Number(source.slice(14, 16)) <= 59 && Number(source.slice(17, 19)) <= 59,
    "INVALID_OR_UNZONED_RECEIPT_TIME");
  const time = Date.parse(source); check(Number.isFinite(time), "INVALID_OR_UNZONED_RECEIPT_TIME"); return time;
}
