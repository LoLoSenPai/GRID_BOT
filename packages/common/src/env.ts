import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const cwd = /* turbopackIgnore: true */ process.cwd();

const envCandidates = [
  resolve(cwd, ".env.local"),
  resolve(cwd, ".env"),
  resolve(cwd, "../../.env.local"),
  resolve(cwd, "../../.env"),
  resolve(moduleDir, "../../../.env.local"),
  resolve(moduleDir, "../../../.env")
];

for (const path of envCandidates) {
  if (existsSync(path)) {
    loadDotEnv({ path, override: false, quiet: true });
  }
}

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  DISCORD_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  LIVE_TRADING_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  DEFAULT_CLUSTER: z.enum(["devnet", "mainnet-beta"]).default("mainnet-beta"),
  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),
  EXECUTION_WALLET_SECRET_KEY_PATH: z.string().optional().or(z.literal("")),
  EXECUTION_WALLET_SECRET_KEY_JSON: z.string().optional().or(z.literal("")),
  JUPITER_API_KEY: z.string().optional().or(z.literal("")),
  PYTH_HERMES_BASE_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_HISTORY_BASE_URL: z.string().url().default("https://pyth.dourolabs.app/v1"),
  BOT_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  PRICE_STALE_AFTER_MS: z.coerce.number().int().positive().default(10000)
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = envSchema.parse(process.env);
  return cachedEnv;
}
