import { BotMode } from "@grid-bot/core/enums";
import { getEnv } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

type ReservedQuoteSource = {
  totalBudgetUsd: number;
  availableQuoteAmount?: number | null;
};

export function calculateReservedQuoteUsd(
  sources: ReservedQuoteSource[],
): number {
  return sources.reduce((total, source) => {
    const fallbackBudget = Math.max(0, source.totalBudgetUsd);
    const reservedQuote =
      source.availableQuoteAmount == null
        ? fallbackBudget
        : Math.max(0, source.availableQuoteAmount);

    return total + reservedQuote;
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
        },
      },
    },
  });

  return calculateReservedQuoteUsd(
    bots.map((bot) => ({
      totalBudgetUsd: bot.config?.totalBudgetUsd.toNumber() ?? 0,
      availableQuoteAmount:
        bot.stateSnapshots[0]?.availableQuoteAmount.toNumber() ?? null,
    })),
  );
}

export async function getAllocatedBudgetUsd(
  excludeBotId?: string,
): Promise<number> {
  return getReservedQuoteUsd(excludeBotId);
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
