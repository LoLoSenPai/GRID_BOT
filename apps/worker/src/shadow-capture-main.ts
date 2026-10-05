import { logger } from "@grid-bot/common";
import { createShadowObservationClient, PrismaShadowObservationRepository } from "@grid-bot/db";
import { ShadowCaptureSpool } from "./shadow-capture-spool";

export function shadowSpoolDirectory(): string {
  return process.env.SHADOW_CAPTURE_SPOOL_DIR ?? ".shadow-capture-spool";
}
async function main() {
  const spool = new ShadowCaptureSpool(shadowSpoolDirectory());
  await spool.acquire();
  const handle = createShadowObservationClient(), storage = new PrismaShadowObservationRepository(handle.client);
  let stopped = false, running: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const metrics = await spool.drain(storage);
      if (metrics.queued || metrics.completed || metrics.invalid) logger.info(metrics, "Shadow capture spool status");
    } catch { logger.warn("Shadow capture spool drain failed; queued files retained"); }
    finally { running = undefined; if (!stopped) timer = setTimeout(() => { running = poll(); }, 5_000); }
  };
  const stop = async () => {
    if (stopped) return; stopped = true; if (timer) clearTimeout(timer);
    if (running) await running;
    await spool.close(); await handle.close(); process.exitCode = 0;
  };
  process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
  logger.info("Independent shadow capture spool consumer ready");
  running = poll();
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/shadow-capture-main.ts")) {
  main().catch(() => { logger.error("Shadow capture consumer could not start"); process.exitCode = 1; });
}
