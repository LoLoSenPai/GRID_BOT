import { MINTS } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";
import { NextResponse } from "next/server";
import { readSession } from "@/lib/auth";
import { evaluateLivePreflight } from "@/lib/portfolio-live-preflight";

/** Authenticated read-only quote. Does not create a portfolio, reserve capital or enable any bot. */
export async function POST(request: Request) {
  if (!await readSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    const { totalCapital, baseAllocation, feeSol } = body;
    if (![totalCapital, baseAllocation, feeSol].every(n => typeof n === "number" && Number.isFinite(n)) ||
      baseAllocation < 100 || totalCapital < 2 * baseAllocation || feeSol <= 0)
      return NextResponse.json({ error: "Supply totalCapital, equal baseAllocation >= 100, and positive feeSol." }, { status: 400 });
    const wallet = WalletService.fromEnv();
    const observedAt = Date.now();
    const balances = await wallet.getBalances();
    const blockers: string[] = [];
    const claim = (value: unknown) => {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) {
        blockers.push("Invalid persisted capital claim requires reconciliation.");
        return 0;
      }
      return amount;
    };
    if (balances.pubkey !== wallet.getPubkey()) blockers.push("Wallet identity changed.");
    // Repeatable DB snapshot; chain observation remains advisory until atomic activation/reconciliation.
    const { bots, portfolios, pending } = await prisma.$transaction(async tx => ({
      bots: await tx.bot.findMany({ where: { mode: "live" }, include: {
        gridBand: true, positionLots: { where: { closedAt: null } },
        stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } }),
      portfolios: await tx.portfolio.findMany({ where: { mode: "live" }, include: {
        assetStrategies: { include: { bands: true } } } }),
      pending: await tx.executionAttempt.count({ where: { bot: { mode: "live" } } }),
    }), { isolationLevel: "RepeatableRead" });
    if (pending) blockers.push("Pending or uncertain live executions require reconciliation.");
    let quoteClaims = 0;
    let solClaims = 0;
    for (const portfolio of portfolios) {
      if (portfolio.walletIdentity !== balances.pubkey || portfolio.quoteMint !== MINTS.USDC) {
        blockers.push("Existing live portfolio ownership or quote mint requires reconciliation.");
        continue;
      }
      quoteClaims += claim(portfolio.freeQuoteAmount);
      solClaims += claim(portfolio.nativeFeeReserveSol ?? 0);
      for (const strategy of portfolio.assetStrategies) for (const band of strategy.bands) {
        // available includes reserved cash: adding reserved again would double-count it.
        if (band.status !== "CLOSED") {
          quoteClaims += claim(band.availableQuoteAmount);
          if (claim(band.reservedQuoteAmount) > claim(band.availableQuoteAmount))
            blockers.push("Band reservations exceed its available capital.");
        }
      }
    }
    for (const bot of bots) {
      const snapshot = bot.stateSnapshots[0];
      // Archived positions are history; their former balances are not active bot claims.
      if (bot.archivedAt) continue;
      if (!snapshot) { blockers.push("A live bot has no accounting snapshot."); continue; }
      // Paused/stopped is not released. Never subtract realized profit from another bot's cash.
      if (!bot.gridBand) quoteClaims += claim(snapshot.availableQuoteAmount);
      if (bot.baseMint === MINTS.SOL) solClaims += Math.max(claim(snapshot.availableBaseAmount),
        bot.positionLots.reduce((sum, lot) => sum + claim(lot.remainingBaseAmount), 0));
    }
    const result = evaluateLivePreflight({ totalCapital, baseAllocation, feeSol,
      walletUsdc: balances.usdc, walletSol: balances.sol, quoteClaims, solClaims,
      observedAt, now: Date.now(), blockers });
    return NextResponse.json({ ...result, observedAt: new Date(observedAt).toISOString(),
      quoteMint: MINTS.USDC, quoteClaims, solClaims }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ activationAllowed: false, error: "Live preflight unavailable; no funds were reserved." }, { status: 503 });
  }
}
