import { getEnv, logger } from "@grid-bot/common";
import type { AlertRecord, AlertSink } from "@grid-bot/core";

export class DiscordWebhookSink implements AlertSink {
  async notify(alert: AlertRecord): Promise<void> {
    const webhook = getEnv().DISCORD_WEBHOOK_URL;
    if (!webhook) {
      return;
    }

    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        embeds: [
          {
            title: alert.title,
            description: alert.message,
            color: alert.severity === "critical" ? 0xff6b7a : alert.severity === "warning" ? 0xf8c86c : 0x44d39c,
            footer: {
              text: alert.type
            },
            timestamp: alert.createdAt.toISOString()
          }
        ]
      })
    });

    if (!response.ok) {
      logger.warn({ alert, status: response.status }, "Discord webhook failed");
    }
  }
}
