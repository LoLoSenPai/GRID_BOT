import { getEnv } from "@grid-bot/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

const SHADOW_DB_TIMEOUT_MS = 2_000;

export interface ShadowObservationClientHandle {
  client: PrismaClient;
  close(): Promise<void>;
}

/**
 * Creates an isolated, deliberately small Prisma pool for best-effort shadow writes.
 * The caller owns the handle and must close it during shutdown.
 */
export function createShadowObservationClient(): ShadowObservationClientHandle {
  const pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: SHADOW_DB_TIMEOUT_MS,
    query_timeout: SHADOW_DB_TIMEOUT_MS,
    statement_timeout: SHADOW_DB_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

  const client = new PrismaClient({
    adapter: new PrismaPg(pool, {
      disposeExternalPool: true,
      onPoolError: () => console.error("Shadow observation database pool connection failed."),
    }),
    log: ["warn", "error"],
  });

  return {
    client,
    close: () => client.$disconnect(),
  };
}
