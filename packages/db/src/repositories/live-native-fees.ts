import { getEnv, MINTS } from "@grid-bot/common";
import { WalletService, type ExecuteSwapParams, type NativeFeePolicy } from "@grid-bot/core";
import { Prisma } from "@prisma/client";
import { prisma } from "../client";

export async function resolveLiveNativeFeePolicy(params: ExecuteSwapParams, db: Prisma.TransactionClient = prisma): Promise<NativeFeePolicy> {
  const portfolios = await db.portfolio.findMany({ where: { mode: "live" } });
  // Preserve legacy operation when no V2 fee envelope exists; still validate a wallet balance envelope.
  const bots = await db.bot.findMany({ where: { mode: "live" }, include: { gridBand: { include: { assetStrategy: true } },
    stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }, positionLots: { where: { closedAt: null } } } });
  const own = bots.find(b => b.id === params.botId && !b.archivedAt);
  if (!own) throw new Error("Execution bot ownership unavailable.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wallet = await Promise.race([WalletService.fromEnv().getBalances(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native balance observation timed out.")), 8000);
  })]).finally(() => clearTimeout(timer));
  if (params.walletPublicKey && params.walletPublicKey !== wallet.pubkey) throw new Error("Execution wallet mismatch.");
  let protectedSol = 0;
  const amount = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error("Invalid native inventory accounting.");
    return n;
  };
  for (const bot of bots) {
    if (bot.baseMint !== MINTS.SOL || bot.archivedAt) continue;
    const lotSol = bot.positionLots.reduce((n, l) => n + amount(l.remainingBaseAmount), 0);
    const state = bot.stateSnapshots[0];
    if (!state) throw new Error("SOL ownership snapshot missing.");
    protectedSol += Math.max(amount(state.availableBaseAmount), lotSol);
  }
  const principal = params.inputMint === MINTS.SOL ? params.amount : 0;
  protectedSol = Math.max(0, protectedSol - principal);
  let ownReserve: number | undefined;
  for (const p of portfolios) {
    if (p.walletIdentity !== wallet.pubkey || p.quoteMint !== MINTS.USDC) throw new Error("Live portfolio wallet mismatch.");
    const reserve = amount(p.nativeFeeReserveSol);
    if (own.gridBand?.assetStrategy.portfolioId === p.id) {
      if (!getEnv().V2_LIVE_ENABLED || !getEnv().LIVE_TRADING_ENABLED || !p.autoLive || reserve <= 0)
        throw new Error("Live portfolio activation or fee envelope is unavailable.");
      ownReserve = reserve;
    } else protectedSol += reserve;
  }
  const available = Math.max(0, wallet.sol - principal - protectedSol);
  if (![protectedSol, available, ownReserve ?? 0].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Invalid native fee accounting.");
  return { maxFeeAmount: new Prisma.Decimal(Math.min(available, ownReserve ?? available)).toDecimalPlaces(9, Prisma.Decimal.ROUND_DOWN).toNumber(),
    minimumPostExecutionBalance: new Prisma.Decimal(protectedSol).toDecimalPlaces(9, Prisma.Decimal.ROUND_UP).toNumber() };
}
