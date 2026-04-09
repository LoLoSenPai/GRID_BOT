import { PYTH_FEED_IDS, getEnv, logger } from "@grid-bot/common";
import { type HermesParsedPriceUpdate, normalizePythFeedId, parseHermesPriceUpdate } from "@grid-bot/core";

const STREAM_RECONNECT_DELAY_MS = 2_000;

const FEED_SYMBOL_BY_ID = new Map<string, string>([
  [normalizePythFeedId(PYTH_FEED_IDS.SOL_USD), "SOL"],
  [normalizePythFeedId(PYTH_FEED_IDS.BTC_USD), "BTC"],
]);

interface HermesStreamPayload {
  parsed?: HermesParsedPriceUpdate[];
}

function buildPriceStreamUrl(baseUrl: string) {
  const query = Object.values(PYTH_FEED_IDS)
    .map((feedId) => `ids[]=${encodeURIComponent(feedId)}`)
    .join("&");

  return `${baseUrl}/v2/updates/price/stream?${query}&parsed=true`;
}

export class PythPriceStreamService {
  private readonly env = getEnv();
  private readonly url = buildPriceStreamUrl(this.env.PYTH_HERMES_BASE_URL);
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly onPrice: (price: ReturnType<typeof parseHermesPriceUpdate>) => Promise<void> | void) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.abortController?.abort();
  }

  private async connect() {
    if (this.stopped) {
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const response = await fetch(this.url, {
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(`Pyth stream request failed with status ${response.status}`);
      }

      logger.info({ url: this.url }, "Connected to Pyth Hermes stream");
      await this.consume(response.body, controller.signal);

      if (!this.stopped && !controller.signal.aborted) {
        throw new Error("Pyth stream closed unexpectedly");
      }
    } catch (error) {
      if (this.stopped || controller.signal.aborted) {
        return;
      }

      logger.warn({ error }, "Pyth Hermes stream disconnected");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimeout) {
      return;
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.connect();
    }, STREAM_RECONNECT_DELAY_MS);
  }

  private async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.stopped && !signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let boundaryIndex = buffer.indexOf("\n\n");
        while (boundaryIndex !== -1) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          await this.handleEvent(rawEvent);
          boundaryIndex = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleEvent(rawEvent: string) {
    if (!rawEvent) {
      return;
    }

    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    const payloadText = dataLines.join("\n");
    let payload: HermesStreamPayload;

    try {
      payload = JSON.parse(payloadText) as HermesStreamPayload;
    } catch (error) {
      logger.debug({ error, payloadText }, "Skipping malformed Pyth stream event");
      return;
    }

    for (const item of payload.parsed ?? []) {
      const symbol = FEED_SYMBOL_BY_ID.get(normalizePythFeedId(item.id));
      if (!symbol) {
        continue;
      }

      await this.onPrice(parseHermesPriceUpdate(symbol, "USDC", item));
    }
  }
}
