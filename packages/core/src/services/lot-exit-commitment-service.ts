import { TradeSide } from "../domain/enums";
import type { PositionLot, TriggerSignal } from "../domain/types";
import { isTradingLot } from "./lot-accounting-service";

/** Absolute commitments survive changes to the entry grid. Indices are display metadata only. */
export interface AbsoluteExit {
  lotId: string;
  targetStatus: "KNOWN" | "UNKNOWN";
  sellTargetPrice: number | null;
  sellLevelIndex: number | null;
  originRevisionId: string;
  maxAdverseDriftBps: number;
}

export interface CommittedExitSignal extends TriggerSignal {
  exitLotId: string;
  gridRevisionId: string;
  maxAdverseDriftBps: number;
}

export function eligibleCommittedExits(input: {
  botId: string;
  price: number;
  now: Date;
  lots: PositionLot[];
  commitments: AbsoluteExit[];
}): CommittedExitSignal[] {
  if (!Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.now.getTime())) return [];
  const lots = new Map(input.lots.filter(isTradingLot).map(lot => [lot.id, lot]));
  return input.commitments
    .filter(exit => exit.targetStatus === "KNOWN" && lots.has(exit.lotId) &&
      typeof exit.sellTargetPrice === "number" && Number.isFinite(exit.sellTargetPrice) &&
      exit.sellTargetPrice > 0 && input.price >= exit.sellTargetPrice)
    .sort((a, b) => a.sellTargetPrice! - b.sellTargetPrice! ||
      lots.get(a.lotId)!.openedAt.getTime() - lots.get(b.lotId)!.openedAt.getTime() || a.lotId.localeCompare(b.lotId))
    .map(exit => ({
      side: TradeSide.Sell,
      levelIndex: exit.sellLevelIndex ?? 1,
      levelPrice: exit.sellTargetPrice!,
      observedPrice: input.price,
      exitLotId: exit.lotId,
      gridRevisionId: exit.originRevisionId,
      maxAdverseDriftBps: exit.maxAdverseDriftBps,
      // Retry after a definitive failure is allowed; unresolved attempts retain their original identity.
      idempotencyKey: `${input.botId}:exit:${exit.lotId}:${input.now.toISOString()}`,
      triggeredAt: input.now,
    }));
}

/** No historical price interval may be replayed against newly moved rails. */
export function previousPriceForRevision(input: {
  activeRevisionId: string;
  observedRevisionId?: string;
  previousPrice: number | null;
}): number | null {
  return input.activeRevisionId === input.observedRevisionId ? input.previousPrice : null;
}
