import { BotMode } from "@grid-bot/core/enums";
import { getEnv } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

type ReservedQuoteSource = {
  totalBudgetUsd: number;
  availableQuoteAmount?: number | null;
  realizedPnlUsd?: number | null;
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

export async function getReservedQuoteUsd(
  excludeBotId?: string,
): Promise<number> {
  const bots = await prisma.bot.findMany({
    where: {
      mode: BotMode.Live as never,
      status: { notIn: ["stopped"] },
      ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
    },
    select: {
      config: {
        select: {
          totalBudgetUsd: true,
        },
      },
      stateSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          availableQuoteAmount: true,
          realizedPnlUsd: true,
        },
      },
    },
  });

  return calculateReservedQuoteUsd(
    bots.map((bot) => ({
      totalBudgetUsd: bot.config?.totalBudgetUsd.toNumber() ?? 0,
      availableQuoteAmount:
        bot.stateSnapshots[0]?.availableQuoteAmount.toNumber() ?? null,
      realizedPnlUsd: bot.stateSnapshots[0]?.realizedPnlUsd.toNumber() ?? null,
    })),
  );
}

export async function getAllocatedBudgetUsd(
  excludeBotId?: string,
): Promise<number> {
  const result = await prisma.botConfig.aggregate({
    where: {
      bot: {
        mode: BotMode.Live as never,
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

  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      stateSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          availableQuoteAmount: true,
          totalEquityUsd: true,
        },
      },
    },
  });

  const snapshot = bot?.stateSnapshots[0];
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
