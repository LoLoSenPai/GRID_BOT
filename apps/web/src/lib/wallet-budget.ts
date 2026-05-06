import { BotMode } from "@grid-bot/core/enums";
import { getEnv } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";
import { findLatestBotStateSnapshot, findLatestBotStateSnapshots, prisma } from "@grid-bot/db";

type ReservedQuoteSource = {
  totalBudgetUsd: number;
  availableQuoteAmount?: number | null;
  realizedPnlUsd?: number | null;
};

type ReservedBaseSource = {
  baseSymbol: string;
  availableBaseAmount?: number | null;
};

export function calculateReservedQuoteUsd(
  sources: ReservedQuoteSource[],
): number {
  return sources.reduce((total, source) => {
    const fallbackBudget = Math.max(0, source.totalBudgetUsd);
    if (source.availableQuoteAmount == null) {
      return total + fallbackBudget;
    }

    const idleQuote = Math.max(0, source.availableQuoteAmount);
    const realizedProfit = Math.max(0, source.realizedPnlUsd ?? 0);
    const reservedQuote = Math.max(0, idleQuote - realizedProfit);

    return total + Math.min(fallbackBudget, reservedQuote);
  }, 0);
}

export function calculateAvailableBudgetUsd({
  walletUsdc,
  reservedQuoteUsd,
  currentBotNonQuoteEquityUsd = 0,
}: {
  walletUsdc: number;
  reservedQuoteUsd: number;
  currentBotNonQuoteEquityUsd?: number;
}): number {
  return Math.max(
    0,
    walletUsdc - reservedQuoteUsd + currentBotNonQuoteEquityUsd,
  );
}

export function calculateReservedBaseBySymbol(
  sources: ReservedBaseSource[],
): Record<string, number> {
  return sources.reduce<Record<string, number>>((reservedBySymbol, source) => {
    const symbol = source.baseSymbol.toUpperCase();
    const amount = Math.max(0, source.availableBaseAmount ?? 0);
    if (amount <= 0) {
      return reservedBySymbol;
    }

    reservedBySymbol[symbol] = (reservedBySymbol[symbol] ?? 0) + amount;
    return reservedBySymbol;
  }, {});
}

export async function getReservedQuoteUsd(
  excludeBotId?: string,
): Promise<number> {
  const bots = await prisma.bot.findMany({
    where: {
      mode: BotMode.Live as never,
      archivedAt: null,
      status: { notIn: ["stopped"] },
      ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
    },
    select: {
      id: true,
      config: {
        select: {
          totalBudgetUsd: true,
        },
      },
    },
  });
  const latestStateByBotId = await findLatestBotStateSnapshots(
    bots.map((bot) => bot.id),
  );

  return calculateReservedQuoteUsd(
    bots.map((bot) => {
      const latestState = latestStateByBotId.get(bot.id);
      return {
        totalBudgetUsd: bot.config?.totalBudgetUsd.toNumber() ?? 0,
        availableQuoteAmount:
          latestState?.availableQuoteAmount.toNumber() ?? null,
        realizedPnlUsd: latestState?.realizedPnlUsd.toNumber() ?? null,
      };
    }),
  );
}

export async function getReservedBaseBySymbol(
  excludeBotId?: string,
): Promise<Record<string, number>> {
  const bots = await prisma.bot.findMany({
    where: {
      mode: BotMode.Live as never,
      archivedAt: null,
      status: { notIn: ["stopped"] },
      ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
    },
    select: {
      id: true,
      baseSymbol: true,
    },
  });
  const latestStateByBotId = await findLatestBotStateSnapshots(
    bots.map((bot) => bot.id),
  );

  return calculateReservedBaseBySymbol(
    bots.map((bot) => {
      const latestState = latestStateByBotId.get(bot.id);
      return {
        baseSymbol: bot.baseSymbol,
        availableBaseAmount:
          latestState?.availableBaseAmount.toNumber() ?? null,
      };
    }),
  );
}

export async function getAllocatedBudgetUsd(
  excludeBotId?: string,
): Promise<number> {
  const result = await prisma.botConfig.aggregate({
    where: {
      bot: {
        mode: BotMode.Live as never,
        archivedAt: null,
        status: { notIn: ["stopped"] },
        ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
      },
    },
    _sum: {
      totalBudgetUsd: true,
    },
  });

  return result._sum.totalBudgetUsd?.toNumber() ?? 0;
}

async function getCurrentBotNonQuoteEquityUsd(
  botId?: string,
): Promise<number> {
  if (!botId) {
    return 0;
  }

  const bot = await prisma.bot.findFirst({
    where: { id: botId, archivedAt: null },
    select: {
      id: true,
    },
  });

  const snapshot = bot ? await findLatestBotStateSnapshot(bot.id) : null;
  if (!snapshot) {
    return 0;
  }

  return Math.max(
    0,
    snapshot.totalEquityUsd.toNumber() -
      snapshot.availableQuoteAmount.toNumber(),
  );
}

export async function validateBudgetAllocation(
  totalBudgetUsd: number,
  mode: string,
  excludeBotId?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (mode !== BotMode.Live) {
    return { ok: true };
  }

  const env = getEnv();
  if (!env.EXECUTION_WALLET_SECRET_KEY_PATH) {
    return {
      ok: false,
      error:
        "Live wallet is not configured. Set EXECUTION_WALLET_SECRET_KEY_PATH before creating or editing live bots.",
    };
  }

  try {
    const wallet = WalletService.fromEnv();
    const [balances, reservedQuote, currentBotNonQuoteEquity] =
      await Promise.all([
        wallet.getBalances(),
        getReservedQuoteUsd(excludeBotId),
        getCurrentBotNonQuoteEquityUsd(excludeBotId),
      ]);

    const available = calculateAvailableBudgetUsd({
      walletUsdc: balances.usdc,
      reservedQuoteUsd: reservedQuote,
      currentBotNonQuoteEquityUsd: currentBotNonQuoteEquity,
    });

    if (totalBudgetUsd > available) {
      return {
        ok: false,
        error: `Insufficient USDC. Available: $${available.toFixed(2)}, requested: $${totalBudgetUsd.toFixed(2)}. Fund your wallet (${balances.pubkey}) or reduce the budget.`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Live wallet check failed: ${error.message}`
          : "Live wallet check failed.",
    };
  }
}

export async function validateAdditionalBudgetAllocation(
  additionalBudgetUsd: number,
  mode: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (mode !== BotMode.Live || additionalBudgetUsd <= 0) {
    return { ok: true };
  }

  const env = getEnv();
  if (!env.EXECUTION_WALLET_SECRET_KEY_PATH) {
    return {
      ok: false,
      error:
        "Live wallet is not configured. Set EXECUTION_WALLET_SECRET_KEY_PATH before adding live bot budget.",
    };
  }

  try {
    const wallet = WalletService.fromEnv();
    const [balances, reservedQuote] = await Promise.all([
      wallet.getBalances(),
      getReservedQuoteUsd(),
    ]);

    const available = calculateAvailableBudgetUsd({
      walletUsdc: balances.usdc,
      reservedQuoteUsd: reservedQuote,
    });

    if (additionalBudgetUsd > available) {
      return {
        ok: false,
        error: `Insufficient unreserved USDC. Available: $${available.toFixed(2)}, additional budget requested: $${additionalBudgetUsd.toFixed(2)}. Fund your wallet (${balances.pubkey}) or reduce the top-up.`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Live wallet check failed: ${error.message}`
          : "Live wallet check failed.",
    };
  }
}
