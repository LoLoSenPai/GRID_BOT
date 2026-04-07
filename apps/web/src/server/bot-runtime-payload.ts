import { prisma } from "@grid-bot/db";

export async function getBotRuntimeListPayload() {
  const bots = await prisma.bot.findMany({
    include: {
      stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
      orders: { orderBy: { createdAt: "desc" }, take: 1 },
      executions: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: {
        select: {
          orders: true,
          executions: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });

  return {
    bots: bots.map((bot) => {
      const latestState = bot.stateSnapshots[0];
      const latestOrder = bot.orders[0];
      const latestExecution = bot.executions[0];

      return {
        id: bot.id,
        status: bot.status,
        currentPrice: bot.currentPrice ? Number(bot.currentPrice) : latestState?.currentPrice ? Number(latestState.currentPrice) : null,
        lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
        runtime: latestState
          ? {
              availableQuoteAmount: Number(latestState.availableQuoteAmount),
              availableBaseAmount: Number(latestState.availableBaseAmount),
              deployedQuoteAmount: Number(latestState.deployedQuoteAmount),
              averageEntryPrice: latestState.averageEntryPrice ? Number(latestState.averageEntryPrice) : null,
              realizedPnlUsd: Number(latestState.realizedPnlUsd),
              unrealizedPnlUsd: Number(latestState.unrealizedPnlUsd),
              totalEquityUsd: Number(latestState.totalEquityUsd),
              consecutiveFailures: latestState.consecutiveFailures,
              lastProcessedAt: latestState.lastProcessedAt?.toISOString() ?? null,
              lastExecutionAt: latestState.lastExecutionAt?.toISOString() ?? null,
              pendingSignal: latestState.metadata
            }
          : null,
        paperSession: {
          ordersCount: bot._count.orders,
          executionsCount: bot._count.executions,
          latestExecutionAt: latestExecution?.createdAt.toISOString() ?? null,
          latestExecutionStatus: latestExecution?.status ?? null,
          latestExecutionInputAmount: latestExecution?.executedInputAmount ? Number(latestExecution.executedInputAmount) : null,
          latestExecutionOutputAmount: latestExecution?.executedOutputAmount ? Number(latestExecution.executedOutputAmount) : null,
          latestExecutionPrice: latestExecution?.quotePrice ? Number(latestExecution.quotePrice) : null,
          latestOrderSide: latestOrder?.side ?? null,
          latestOrderStatus: latestOrder?.status ?? null,
          latestOrderAt: latestOrder?.createdAt.toISOString() ?? null
        }
      };
    })
  };
}

export async function getBotRuntimePayload(id: string) {
  const bot = await prisma.bot.findUnique({
    where: { id },
    include: {
      stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 }
    }
  });

  if (!bot) {
    return null;
  }

  const latestState = bot.stateSnapshots[0];

  return {
    id: bot.id,
    status: bot.status,
    currentPrice: bot.currentPrice ? Number(bot.currentPrice) : latestState?.currentPrice ? Number(latestState.currentPrice) : null,
    lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
    lastProcessedAt: latestState?.lastProcessedAt?.toISOString() ?? null,
    lastExecutionAt: latestState?.lastExecutionAt?.toISOString() ?? null
  };
}

export function createSseResponse<T>({
  request,
  getPayload,
  intervalMs = 2000
}: {
  request: Request;
  getPayload: () => Promise<T>;
  intervalMs?: number;
}) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const pushEvent = async () => {
        if (closed) {
          return;
        }

        try {
          const payload = await getPayload();
          controller.enqueue(encoder.encode(`event: runtime\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch (error) {
          const message = error instanceof Error ? error.message : "stream_error";
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`));
        }
      };

      void pushEvent();
      const intervalId = setInterval(() => {
        void pushEvent();
      }, intervalMs);

      const close = () => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(intervalId);
        controller.close();
      };

      request.signal.addEventListener("abort", close, { once: true });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive"
    }
  });
}
