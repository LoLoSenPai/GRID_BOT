import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionRecoveryPoller } from "./execution-recovery-poller";
import { SymbolRunScheduler } from "./symbol-run-scheduler";

afterEach(() => vi.useRealTimers());

describe("execution recovery independently of price delivery", () => {
  it("recovers pending bots on startup without receiving any price event", async () => {
    const recover = vi.fn(async (_id: string) => undefined);
    const list = vi.fn(async () => ["paused-bot", "archived-bot", "paused-bot"]);
    const poller = new ExecutionRecoveryPoller(list, recover);
    poller.start();
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await poller.stop();
    expect(recover.mock.calls.map(([id]) => id)).toEqual(["paused-bot", "archived-bot"]);
  });

  it("retries enumeration failures and continues after one bot's recovery fails", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockRejectedValueOnce(new Error("temporary DB outage")).mockResolvedValue(["a", "b"]);
    const recover = vi.fn().mockRejectedValueOnce(new Error("lock unavailable")).mockResolvedValue(undefined);
    const poller = new ExecutionRecoveryPoller(list, recover, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(recover.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("never overlaps slow recoveries and drains the active attempt during shutdown", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const recover = vi.fn(async () => pending);
    const list = vi.fn(async () => ["a", "b"]);
    const poller = new ExecutionRecoveryPoller(list, recover, 1_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(list).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    let stopped = false;
    const shutdown = poller.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    expect(stopped).toBe(true);
    expect(recover).toHaveBeenCalledOnce();
  });
});

describe("scheduler shutdown", () => {
  it("waits for the active run, cancels queued work, and rejects future events", async () => {
    let release!: () => void;
    const run = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = new SymbolRunScheduler(run);
    scheduler.schedule("SOL");
    scheduler.schedule("SOL");
    let stopped = false;
    const shutdown = scheduler.stop().then(() => { stopped = true; });
    scheduler.schedule("BTC");
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    expect(run).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(true);
  });
});
