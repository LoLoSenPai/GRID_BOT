import { logger } from "@grid-bot/common";

import type { AlertRepository, AlertSink } from "../domain/contracts";
import type { AlertRecord } from "../domain/types";

export class AlertService {
  constructor(
    private readonly alertRepository: AlertRepository,
    private readonly sinks: AlertSink[]
  ) {}

  async emit(alert: Omit<AlertRecord, "id" | "createdAt">): Promise<AlertRecord> {
    const persisted = await this.alertRepository.createAlert(alert);
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.notify(persisted);
        } catch (error) {
          logger.error({ error, alert: persisted }, "Failed to dispatch alert");
        }
      })
    );
    return persisted;
  }
}
