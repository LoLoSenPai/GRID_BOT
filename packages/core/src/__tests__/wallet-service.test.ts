import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  loadExecutionWallet,
  sumTokenAccountBalances,
} from "../services/wallet-service";

describe("loadExecutionWallet", () => {
  it("loads a valid keypair from a wallet path", () => {
    const directory = mkdtempSync(join(tmpdir(), "grid-bot-wallet-"));
    const walletPath = join(directory, "wallet.json");
    const keypair = Keypair.generate();

    writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));

    const loaded = loadExecutionWallet(walletPath);

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());

    rmSync(directory, { recursive: true, force: true });
  });

  it("fails on a missing wallet path", () => {
    expect(() => loadExecutionWallet("Z:/missing-wallet.json")).toThrow(
      /does not exist/,
    );
  });
});

describe("sumTokenAccountBalances", () => {
  it("sums every token account balance for a mint", () => {
    const total = sumTokenAccountBalances([
      {
        account: {
          data: {
            parsed: { info: { tokenAmount: { uiAmount: 1.25 } } },
          },
        },
      },
      {
        account: {
          data: {
            parsed: { info: { tokenAmount: { uiAmount: 3.5 } } },
          },
        },
      },
      {
        account: {
          data: {
            parsed: { info: { tokenAmount: { uiAmount: null } } },
          },
        },
      },
    ]);

    expect(total).toBe(4.75);
  });
});
