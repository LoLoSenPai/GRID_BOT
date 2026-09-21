import { MINTS } from "@grid-bot/common";
import { Prisma } from "@prisma/client";
import { WalletService } from "@grid-bot/core";

type Tx = Prisma.TransactionClient;
export async function lockLiveWallet(tx: Tx) {
  // One configured execution wallet. Also acquired before durable live order preparation.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('grid-bot:live-wallet', 0))::text`;
}

export async function assertLiveWalletCapital(tx: Tx, additionalUsdc: number, feeSol = 0,
  observe = () => WalletService.fromEnv().getBalances()) {
  if (![additionalUsdc, feeSol].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Invalid funding request.");
  await lockLiveWallet(tx);
  if (await tx.executionAttempt.count({ where: { bot: { mode: "live" } } }) ||
    await tx.execution.count({ where: { mode: "live", completedAt: null, status: { in: ["pending", "submitted", "unknown"] } } }))
    throw new Error("Live execution awaiting settlement; retry allocation afterwards.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wallet = await Promise.race([observe(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Wallet observation timed out.")), 8000);
  })]).finally(() => clearTimeout(timer));
  const amount = (value: unknown) => {
    const n = new Prisma.Decimal(String(value));
    if (!n.isFinite() || n.isNegative()) throw new Error("Invalid wallet accounting amount.");
    return n;
  };
  let cash = new Prisma.Decimal(0), ownedSol = new Prisma.Decimal(0), feeClaims = new Prisma.Decimal(0);
  const portfolios = await tx.portfolio.findMany({ where: { mode: "live" }, include: {
    assetStrategies: { include: { bands: true } } } });
  for (const p of portfolios) {
    if (p.walletIdentity !== wallet.pubkey || p.quoteMint !== MINTS.USDC) throw new Error("Live portfolio wallet ownership must be reconciled.");
    cash = cash.plus(amount(p.freeQuoteAmount));
    feeClaims = feeClaims.plus(amount(p.nativeFeeReserveSol));
    for (const s of p.assetStrategies) for (const b of s.bands) if (b.status !== "CLOSED") {
      if (amount(b.reservedQuoteAmount).gt(amount(b.availableQuoteAmount))) throw new Error("Invalid band reservation.");
      cash = cash.plus(amount(b.availableQuoteAmount));
    }
  }
  const bots = await tx.bot.findMany({ where: { mode: "live" }, include: { gridBand: true,
    positionLots: { where: { closedAt: null } }, stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
  for (const b of bots) {
    if (b.archivedAt) {
      if (b.positionLots.some(l => amount(l.remainingBaseAmount).gt(0))) throw new Error("Archived inventory needs ownership reconciliation.");
      continue;
    }
    const s = b.stateSnapshots[0];
    if (!s) throw new Error("Live bot lacks an accounting snapshot.");
    if (!b.gridBand) cash = cash.plus(amount(s.availableQuoteAmount));
    if (b.baseMint === MINTS.SOL) ownedSol = ownedSol.plus(Prisma.Decimal.max(amount(s.availableBaseAmount),
      b.positionLots.reduce((sum, l) => sum.plus(amount(l.remainingBaseAmount)), new Prisma.Decimal(0))));
  }
  if (cash.plus(additionalUsdc).gt(amount(wallet.usdc))) throw new Error("Insufficient unassigned wallet USDC.");
  if (ownedSol.plus(feeClaims).plus(feeSol).gt(amount(wallet.sol))) throw new Error("Insufficient unassigned native SOL for fees.");
  return wallet;
}
