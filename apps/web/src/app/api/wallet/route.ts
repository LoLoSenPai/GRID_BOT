import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { WalletService } from "@grid-bot/core";

import { readSession } from "@/lib/auth";
import { getAllocatedBudgetUsd } from "@/lib/wallet-budget";

export async function GET() {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const env = getEnv();
  if (!env.EXECUTION_WALLET_SECRET_KEY_PATH) {
    return NextResponse.json(
      { error: "Wallet not configured." },
      { status: 503 },
    );
  }

  try {
    const wallet = WalletService.fromEnv();
    const [balances, allocated] = await Promise.all([
      wallet.getBalances(),
      getAllocatedBudgetUsd(),
    ]);

    return NextResponse.json(
      {
        pubkey: balances.pubkey,
        sol: balances.sol,
        usdc: balances.usdc,
        wbtc: balances.wbtc,
        allocatedUsd: allocated,
        availableUsd: Math.max(0, balances.usdc - allocated),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Wallet balance fetch failed:", error);
    return NextResponse.json(
      { error: "Failed to fetch wallet balances." },
      { status: 500 },
    );
  }
}
