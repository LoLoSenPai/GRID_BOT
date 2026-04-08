import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";

const outputArg = process.argv[2];
const outputPath = resolve(
  process.cwd(),
  outputArg || ".wallets/execution-wallet.json",
);

const kp = Keypair.generate();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(Array.from(kp.secretKey))}\n`,
  "utf8",
);

console.log(`\nPublic key: ${kp.publicKey.toBase58()}`);
console.log(`Wallet file written to: ${outputPath}`);
console.log(`\nAdd this to your .env:\n`);
console.log(`EXECUTION_WALLET_SECRET_KEY_PATH=${outputPath}`);
