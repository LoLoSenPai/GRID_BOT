import { getEnv } from "@grid-bot/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __gridBotPrisma__: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __gridBotLockPool__: Pool | undefined;
}

export const prisma =
  globalThis.__gridBotPrisma__ ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: getEnv().DATABASE_URL }),
    log: ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__gridBotPrisma__ = prisma;
}

// Dedicated sessions for advisory locks; no SQL transaction is held while an
// execution waits on Jupiter. The regular Prisma pool remains available for writes.
export const botLockPool = globalThis.__gridBotLockPool__ ?? new Pool({
  connectionString: getEnv().DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: true,
});
if (process.env.NODE_ENV !== "production") globalThis.__gridBotLockPool__ = botLockPool;

botLockPool.on("error", () => { console.error("Database advisory-lock pool connection failed."); });
