import { BotMode, EntryMode } from "@grid-bot/core/enums";
import { findLatestBotStateSnapshot, findLatestBotStateSnapshots, prisma } from "@grid-bot/db";

type RuntimeMode = BotMode | undefined;
type RuntimeBotShape = Awaited<ReturnType<typeof getBotRuntimeListPayload>>["bots"][number];
type LatestRuntimeState = NonNullable<Awaited<ReturnType<typeof findLatestBotStateSnapshot>>>;

function buildLatestOrder(order: {
  id: string;
  side: string;
  status: string;
  levelIndex: number;
  targetPrice: { toString(): string };
  requestedBaseAmount: { toString(): string };
  requestedQuoteAmount: { toString(): string };
  reason: string;
  createdAt: Date;
} | null | undefined) {
  if (!order) {
    return null;
  }

  return {
    id: order.id,
    side: order.side,
    status: order.status,
    levelIndex: order.levelIndex,
    targetPrice: Number(order.targetPrice),
    requestedBaseAmount: Number(order.requestedBaseAmount),
    requestedQuoteAmount: Number(order.requestedQuoteAmount),
    reason: order.reason,
    createdAt: order.createdAt.toISOString(),
  };
}

function buildLatestExecution(execution: {
  id: string;
  status: string;
  provider: string;
  executionRef: string;
  txId: string | null;
  quotePrice: { toString(): string } | null;
  executedInputAmount: { toString(): string } | null;
  executedOutputAmount: { toString(): string } | null;
  errorMessage: string | null;
  completedAt: Date | null;
  createdAt: Date;
  order: {
    id: string;
    side: string;
    levelIndex: number;
    targetPrice: { toString(): string };
    requestedBaseAmount: { toString(): string };
    requestedQuoteAmount: { toString(): string };
    reason: string;
  };
} | null | undefined) {
  if (!execution) {
    return null;
  }

  const requestedQuoteAmount = Number(execution.order.requestedQuoteAmount);
  const requestedBaseAmount = Number(execution.order.requestedBaseAmount);
  const executedInputAmount = execution.executedInputAmount ? Number(execution.executedInputAmount) : null;
  const executedOutputAmount = execution.executedOutputAmount ? Number(execution.executedOutputAmount) : null;
  const quoteAmount =
    execution.order.side === "buy"
      ? executedInputAmount ?? requestedQuoteAmount
      : executedOutputAmount ?? requestedQuoteAmount;
  const baseAmount =
    execution.order.side === "buy"
      ? executedOutputAmount ?? requestedBaseAmount
      : executedInputAmount ?? requestedBaseAmount;
  const effectivePrice =
    quoteAmount > 0 && baseAmount > 0
      ? quoteAmount / baseAmount
      : execution.quotePrice
        ? Number(execution.quotePrice)
        : null;

  return {
    id: execution.id,
    orderId: execution.order.id,
    side: execution.order.side,
    status: execution.status,
    levelIndex: execution.order.levelIndex,
    targetPrice: Number(execution.order.targetPrice),
    quoteAmount,
    baseAmount,
    effectivePrice,
    provider: execution.provider,
    executionRef: execution.executionRef,
    txId: execution.txId,
    errorMessage: execution.errorMessage,
    reason: execution.order.reason,
    time: (execution.completedAt ?? execution.createdAt).toISOString(),
    createdAt: execution.createdAt.toISOString(),
    completedAt: execution.completedAt?.toISOString() ?? null,
  };
}

function buildPaperSessionFallback() {
  return {
    ordersCount: 0,
    executionsCount: 0,
    latestExecutionAt: null,
    latestExecutionStatus: null,
    latestExecutionInputAmount: null,
    latestExecutionOutputAmount: null,
    latestExecutionPrice: null,
    latestOrderSide: null,
    latestOrderStatus: null,
    latestOrderAt: null,
    latestExecutionId: null,
    latestExecutionSide: null,
    latestExecutionTxId: null,
  };
}

function buildRuntimeState(latestState: LatestRuntimeState | null | undefined) {
  if (!latestState) {
    return null;
  }

  return {
    availableQuoteAmount: Number(latestState.availableQuoteAmount),
    availableBaseAmount: Number(latestState.availableBaseAmount),
    deployedQuoteAmount: Number(latestState.deployedQuoteAmount),
    averageEntryPrice: latestState.averageEntryPrice
      ? Number(latestState.averageEntryPrice)
      : null,
    realizedPnlUsd: Number(latestState.realizedPnlUsd),
    unrealizedPnlUsd: Number(latestState.unrealizedPnlUsd),
    totalEquityUsd: Number(latestState.totalEquityUsd),
    consecutiveFailures: latestState.consecutiveFailures,
    lastProcessedAt: latestState.lastProcessedAt?.toISOString() ?? null,
    lastExecutionAt: latestState.lastExecutionAt?.toISOString() ?? null,
    pendingSignal: latestState.metadata,
  };
}

export async function getBotRuntimeListPayload(mode?: RuntimeMode) {
  if (mode === BotMode.Live) {
    const bots = await prisma.bot.findMany({
      where: { mode: BotMode.Live as never, archivedAt: null },
      select: {
        id: true,
        status: true,
        currentPrice: true,
        lastHeartbeatAt: true,
        config: {
          select: {
            entryMode: true,
          },
        },
        orders: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            side: true,
            status: true,
            levelIndex: true,
            targetPrice: true,
            requestedBaseAmount: true,
            requestedQuoteAmount: true,
            reason: true,
            createdAt: true,
          },
        },
        executions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            provider: true,
            executionRef: true,
            txId: true,
            quotePrice: true,
            executedInputAmount: true,
            executedOutputAmount: true,
            errorMessage: true,
            completedAt: true,
            createdAt: true,
            order: {
              select: {
                id: true,
                side: true,
                levelIndex: true,
                targetPrice: true,
                requestedBaseAmount: true,
                requestedQuoteAmount: true,
                reason: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

    return {
      bots: bots.map((bot) => {
        const latestState = latestStateByBotId.get(bot.id);
        const latestOrder = buildLatestOrder(bot.orders[0]);
        const latestExecution = buildLatestExecution(bot.executions[0]);

        return {
          id: bot.id,
          status: bot.status,
          currentPrice: bot.currentPrice
            ? Number(bot.currentPrice)
            : latestState?.currentPrice
              ? Number(latestState.currentPrice)
              : null,
          entryMode: bot.config?.entryMode ?? EntryMode.Normal,
          lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
          runtime: buildRuntimeState(latestState),
          latestOrder,
          latestExecution,
          paperSession: buildPaperSessionFallback(),
        };
      }),
    };
  }

  const bots = await prisma.bot.findMany({
    where: { archivedAt: null, ...(mode ? { mode: mode as never } : {}) },
    select: {
      id: true,
      status: true,
      currentPrice: true,
      lastHeartbeatAt: true,
      config: {
        select: {
          entryMode: true,
        },
      },
      orders: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          side: true,
          status: true,
          levelIndex: true,
          targetPrice: true,
          requestedBaseAmount: true,
          requestedQuoteAmount: true,
          reason: true,
          createdAt: true,
        },
      },
      executions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          provider: true,
          executionRef: true,
          txId: true,
          createdAt: true,
          completedAt: true,
          executedInputAmount: true,
          executedOutputAmount: true,
          quotePrice: true,
          errorMessage: true,
          order: {
            select: {
              id: true,
              side: true,
              levelIndex: true,
              targetPrice: true,
              requestedBaseAmount: true,
              requestedQuoteAmount: true,
              reason: true,
            },
          },
        },
      },
      _count: {
        select: {
          orders: true,
          executions: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

  return {
    bots: bots.map((bot) => {
      const latestState = latestStateByBotId.get(bot.id);
      const latestOrder = buildLatestOrder(bot.orders[0]);
      const latestExecution = buildLatestExecution(bot.executions[0]);

      return {
        id: bot.id,
        status: bot.status,
        currentPrice: bot.currentPrice
          ? Number(bot.currentPrice)
          : latestState?.currentPrice
            ? Number(latestState.currentPrice)
            : null,
        entryMode: bot.config?.entryMode ?? EntryMode.Normal,
        lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
        runtime: buildRuntimeState(latestState),
        latestOrder,
        latestExecution,
        paperSession: {
          ordersCount: bot._count.orders,
          executionsCount: bot._count.executions,
          latestExecutionId: latestExecution?.id ?? null,
          latestExecutionSide: latestExecution?.side ?? null,
          latestExecutionAt: latestExecution?.createdAt ?? null,
          latestExecutionStatus: latestExecution?.status ?? null,
          latestExecutionInputAmount:
            latestExecution?.side === "buy" ? latestExecution?.quoteAmount ?? null : latestExecution?.baseAmount ?? null,
          latestExecutionOutputAmount:
            latestExecution?.side === "buy" ? latestExecution?.baseAmount ?? null : latestExecution?.quoteAmount ?? null,
          latestExecutionPrice: latestExecution?.effectivePrice ?? null,
          latestExecutionTxId: latestExecution?.txId ?? null,
          latestOrderSide: latestOrder?.side ?? null,
          latestOrderStatus: latestOrder?.status ?? null,
          latestOrderAt: latestOrder?.createdAt ?? null,
        },
      };
    }),
  };
}

export async function getBotRuntimePayload(id: string) {
  const bot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    select: {
      id: true,
      status: true,
      currentPrice: true,
      lastHeartbeatAt: true,
      config: {
        select: {
          entryMode: true,
        },
      },
      executions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          provider: true,
          executionRef: true,
          txId: true,
          quotePrice: true,
          executedInputAmount: true,
          executedOutputAmount: true,
          errorMessage: true,
          completedAt: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              side: true,
              levelIndex: true,
              targetPrice: true,
              requestedBaseAmount: true,
              requestedQuoteAmount: true,
              reason: true,
            },
          },
        },
      },
    },
  });

  if (!bot) {
    return null;
  }

  const latestState = await findLatestBotStateSnapshot(bot.id);

  return {
    id: bot.id,
    status: bot.status,
    currentPrice: bot.currentPrice
      ? Number(bot.currentPrice)
      : latestState?.currentPrice
        ? Number(latestState.currentPrice)
        : null,
    entryMode: bot.config?.entryMode ?? EntryMode.Normal,
    lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
    runtime: buildRuntimeState(latestState),
    lastProcessedAt: latestState?.lastProcessedAt?.toISOString() ?? null,
    lastExecutionAt: latestState?.lastExecutionAt?.toISOString() ?? null,
    latestExecution: buildLatestExecution(bot.executions[0]),
  };
}

function getRuntimeListDeskEvents(payload: { bots: RuntimeBotShape[] }) {
  return payload.bots.flatMap((bot) => {
    const latestExecution = bot.latestExecution;
    if (!latestExecution) {
      return [];
    }

    if (!["submitted", "filled", "simulated", "failed"].includes(latestExecution.status)) {
      return [];
    }

    return [
      {
        event: "desk-event",
        key: `execution:${latestExecution.id}:${latestExecution.status}`,
        data: {
          kind: "execution",
          botId: bot.id,
          execution: latestExecution,
        },
      },
    ];
  });
}

export function createSseResponse<T>({
  request,
  getPayload,
  intervalMs = 5000,
  getEventsFromPayload,
}: {
  request: Request;
  getPayload: () => Promise<T>;
  intervalMs?: number;
  getEventsFromPayload?: (payload: T) => Array<{
    event: string;
    key: string;
    data: unknown;
  }>;
}) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let eventCachePrimed = false;
      const seenEventKeys = new Set<string>();
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const pushEvent = async () => {
        if (closed) {
          return;
        }

        try {
          const payload = await getPayload();
          safeEnqueue(
            encoder.encode(`event: runtime\ndata: ${JSON.stringify(payload)}\n\n`),
          );

          if (getEventsFromPayload) {
            const events = getEventsFromPayload(payload);
            if (!eventCachePrimed) {
              for (const event of events) {
                seenEventKeys.add(event.key);
              }
              eventCachePrimed = true;
              return;
            }

            for (const event of events) {
              if (seenEventKeys.has(event.key)) {
                continue;
              }

              seenEventKeys.add(event.key);
              safeEnqueue(
                encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
              );
            }

            if (seenEventKeys.size > 500) {
              const recentKeys = Array.from(seenEventKeys).slice(-250);
              seenEventKeys.clear();
              for (const key of recentKeys) {
                seenEventKeys.add(key);
              }
            }
          }
        } catch (error) {
          if (closed) {
            return;
          }

          const message =
            error instanceof Error ? error.message : "stream_error";
          safeEnqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`),
          );
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
        try {
          controller.close();
        } catch {
          return;
        }
      };

      request.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}

export { getRuntimeListDeskEvents };
