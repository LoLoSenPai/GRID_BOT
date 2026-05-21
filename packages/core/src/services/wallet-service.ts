import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getEnv, MINTS } from "@grid-bot/common";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export type WalletBalances = {
  pubkey: string;
  sol: number;
  usdc: number;
  wbtc: number;
  hype: number;
};

export type LoadedExecutionWallet = {
  keypair: Keypair;
  publicKey: PublicKey;
  path: string;
};

export function loadExecutionWallet(secretKeyPath = getEnv().EXECUTION_WALLET_SECRET_KEY_PATH): LoadedExecutionWallet {
  if (!secretKeyPath) {
    throw new Error("EXECUTION_WALLET_SECRET_KEY_PATH is not configured.");
  }

  const resolvedPath = resolve(secretKeyPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Execution wallet file does not exist: ${resolvedPath}`);
  }

  const raw = readFileSync(resolvedPath, "utf8").trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Execution wallet file is not valid JSON: ${resolvedPath}`);
  }

  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((value) => Number.isInteger(value))) {
    throw new Error(`Execution wallet file must contain a 64-byte keypair array: ${resolvedPath}`);
  }

  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));

  return {
    keypair,
    publicKey: keypair.publicKey,
    path: resolvedPath,
  };
}

export class WalletService {
  private readonly connection: Connection;
  private readonly publicKey: PublicKey;

  constructor(rpcHttpUrl: string, publicKey: PublicKey | string) {
    this.connection = new Connection(rpcHttpUrl, "confirmed");
    this.publicKey =
      typeof publicKey === "string" ? new PublicKey(publicKey) : publicKey;
  }

  static fromEnv() {
    const env = getEnv();
    const wallet = loadExecutionWallet(env.EXECUTION_WALLET_SECRET_KEY_PATH);
    return new WalletService(env.RPC_HTTP_URL, wallet.publicKey);
  }

  async getBalances(): Promise<WalletBalances> {
    const usdcMint = new PublicKey(MINTS.USDC);
    const btcMint = new PublicKey(MINTS.BTC);
    const hypeMint = new PublicKey(MINTS.HYPE);

    const [solLamports, usdcAccounts, btcAccounts, hypeAccounts] = await Promise.all([
      this.connection.getBalance(this.publicKey),
      this.connection.getParsedTokenAccountsByOwner(this.publicKey, {
        mint: usdcMint,
      }),
      this.connection.getParsedTokenAccountsByOwner(this.publicKey, {
        mint: btcMint,
      }),
      this.connection.getParsedTokenAccountsByOwner(this.publicKey, {
        mint: hypeMint,
      }),
    ]);

    const usdcBalance = sumTokenAccountBalances(usdcAccounts.value);
    const btcBalance = sumTokenAccountBalances(btcAccounts.value);
    const hypeBalance = sumTokenAccountBalances(hypeAccounts.value);

    return {
      pubkey: this.publicKey.toBase58(),
      sol: solLamports / 1e9,
      usdc: usdcBalance,
      wbtc: btcBalance,
      hype: hypeBalance,
    };
  }

  getPubkey(): string {
    return this.publicKey.toBase58();
  }
}

export function sumTokenAccountBalances(
  accounts: Array<{
    account: {
      data: {
        parsed?: {
          info?: {
            tokenAmount?: {
              uiAmount?: number | null;
            };
          };
        };
      };
    };
  }>,
) {
  return accounts.reduce((sum, account) => {
    return (
      sum +
      (account.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0)
    );
  }, 0);
}
