import { logger } from "@grid-bot/common";

/** Durable execution recovery must remain independent from market-price availability. */
export class ExecutionRecoveryPoller {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly listPendingBotIds: () => Promise<string[]>,
    private readonly recoverBot: (botId: string) => Promise<void>,
    private readonly intervalMs = 5_000
  ) {}

  start() {
    if (!this.stopped || this.running) return;
    this.stopped = false;
    this.launch();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private launch() {
    this.running = this.poll().finally(() => {
      this.running = null;
      if (!this.stopped) this.timer = setTimeout(() => this.launch(), this.intervalMs);
    });
  }

  private async poll() {
    try {
      const ids = await this.listPendingBotIds();
      for (const id of new Set(ids)) {
        if (this.stopped) break;
        try { await this.recoverBot(id); }
        catch (error) { logger.error({ error, botId: id }, "Execution recovery failed; durable attempt remains held"); }
      }
    } catch (error) {
      logger.error({ error }, "Could not enumerate durable executions for recovery");
    }
  }
}
