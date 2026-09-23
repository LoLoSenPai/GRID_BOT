import { randomUUID } from "node:crypto";
import { logger } from "@grid-bot/common";
import { PrismaShadowJevOutboxRepository, prisma } from "@grid-bot/db";

import { HttpJevClient } from "./shadow-jev-client";
import { ShadowJevConsumer } from "./shadow-jev-consumer";

const IDLE_POLL_MS = 5_000;
const ERROR_POLL_MS = 10_000;

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for the separate shadow Jev process.");
  const consumer = new ShadowJevConsumer(new PrismaShadowJevOutboxRepository(),
    new HttpJevClient({ apiKey }), randomUUID());
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  const poll = async () => {
    let nextDelay = IDLE_POLL_MS;
    try {
      if (await consumer.processOne()) nextDelay = 0;
    } catch (error) {
      logger.error({ error }, "Shadow Jev outbox processing failed");
      nextDelay = ERROR_POLL_MS;
    } finally {
      running = null;
      if (!stopping) timer = setTimeout(() => { running = poll(); }, nextDelay);
    }
  };

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (running) await running;
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  logger.info("Shadow Jev outbox consumer started");
  running = poll();
}

main().catch(async (error) => {
  logger.error({ error }, "Shadow Jev consumer could not start");
  await prisma.$disconnect();
  process.exit(1);
});
