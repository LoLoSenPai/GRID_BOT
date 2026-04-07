import { getEnv } from "@grid-bot/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __gridBotPrisma__: PrismaClient | undefined;
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
