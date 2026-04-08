import { BotMode } from "@grid-bot/core/enums";
import { getEnv } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

export async function getAllocatedBudgetUsd(
  excludeBotId?: string,
): Promise<number> {
  const result = await prisma.botConfig.aggregate({
    _sum: { totalBudgetUsd: true },
    where: {
      bot: {
        mode: BotMode.Live as never,
        status: { notIn: ["stopped"] },
        ...(excludeBotId ? { id: { not: excludeBotId } } : {}),
      },
    },
  });
  return result._sum.totalBudgetUsd?.toNumber() ?? 0;
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
    const [balances, allocated] = await Promise.all([
      wallet.getBalances(),
      getAllocatedBudgetUsd(excludeBotId),
    ]);

    const available = Math.max(0, balances.usdc - allocated);

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
