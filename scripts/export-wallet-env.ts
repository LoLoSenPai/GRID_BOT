import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const arg = process.argv[2];
const outputArg = process.argv[3];

if (!arg) {
  console.error("Usage:");
  console.error("  npx tsx scripts/export-wallet-env.ts <base58-private-key> [output-path]");
  console.error("  npx tsx scripts/export-wallet-env.ts /path/to/id.json [output-path]");
  process.exit(1);
}

let secret: Uint8Array;

if (arg.endsWith(".json")) {
  const raw = readFileSync(arg, "utf8");
  secret = Uint8Array.from(JSON.parse(raw) as number[]);
} else {
  secret = bs58.decode(arg);
}

if (secret.length !== 64) {
  console.error(
    `Error: expected 64 bytes, got ${secret.length}. Is this a valid Solana keypair?`,
  );
  process.exit(1);
}

const kp = Keypair.fromSecretKey(secret);
const outputPath = resolve(process.cwd(), outputArg || ".wallets/imported-wallet.json");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(Array.from(secret))}\n`, "utf8");

console.log(`\nPublic key: ${kp.publicKey.toBase58()}`);
console.log(`Wallet file written to: ${outputPath}`);
console.log(`\nAdd this to your .env:\n`);
console.log(`EXECUTION_WALLET_SECRET_KEY_PATH=${outputPath}`);
