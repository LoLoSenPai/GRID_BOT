import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { CaptureShadowObservationInput } from "@grid-bot/db";
import { ShadowCaptureSpool } from "./shadow-capture-spool";

const directories: string[] = [], spools: ShadowCaptureSpool[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const spool of spools.splice(0)) await spool.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const at = new Date("2026-10-06T00:00:00Z");
const input: CaptureShadowObservationInput = {
  portfolioId: "portfolio", strategyId: "strategy", bandId: "band", botId: "bot", observedAt: at,
  questionSetVersion: "shadow-jev-v4.1", modelRequested: "jev-1.13.0", policyInput: {
    candles: [{ openedAt: new Date(+at - 3_600_000), closedAt: at, close: 100 }], now: at,
  } as CaptureShadowObservationInput["policyInput"],
  context: { shadowTiming: { stateReadAt: at } }, botState: {}, proposedDecision: { action: "wait" },
  marketMeta: { provider: "gecko", symbol: "SOL", quoteSymbol: "USDC", resolution: "1h" },
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "shadow-capture-")); directories.push(directory);
  let time = Date.now();
  const spool = new ShadowCaptureSpool(directory, () => time); spools.push(spool);
  const storage = { capture: vi.fn(async (_input: CaptureShadowObservationInput) => ({ observationId: "observation", snapshotId: "snapshot" })),
    finalizeOutcome: vi.fn(async (_id: string, _outcome: unknown) => undefined) };
  return { directory, spool, storage, advance: () => { time += 300_000; } };
}
async function queueFiles(directory: string) { return (await readdir(directory)).filter(name => name.endsWith(".json")); }

describe("durable shadow capture handoff", () => {
  it("retains input and outcome while DB is down, respects backoff, then acknowledges both commits", async () => {
    const f = await fixture(); await f.spool.enqueue(input, { status: "observed_only" }); await f.spool.acquire();
    f.storage.capture.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await f.spool.drain(f.storage)).toMatchObject({ queued: 1, failed: 1, completed: 0 });
    expect(await queueFiles(f.directory)).toHaveLength(1);
    await f.spool.drain(f.storage); expect(f.storage.capture).toHaveBeenCalledTimes(1);
    f.advance(); expect(await f.spool.drain(f.storage)).toMatchObject({ queued: 0, completed: 1 });
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("observation", { status: "observed_only" });
    expect(await queueFiles(f.directory)).toHaveLength(0);
  });
  it("survives a producer restart, freezes the first duplicate, and restores policy dates", async () => {
    const f = await fixture(); await f.spool.enqueue(input, { status: "observed_only" });
    const producer = new ShadowCaptureSpool(f.directory);
    await producer.enqueue({ ...input, context: { changed: true } }, { status: "rejected", error: "later" });
    expect(await queueFiles(f.directory)).toHaveLength(1);
    const consumer = new ShadowCaptureSpool(f.directory); spools.push(consumer); await consumer.acquire();
    await consumer.drain(f.storage);
    const captured = f.storage.capture.mock.calls[0]![0] as CaptureShadowObservationInput;
    expect(captured.context).toEqual(JSON.parse(JSON.stringify(input.context)));
    expect(captured.observedAt).toEqual(at);
    expect((captured.policyInput as { now?: unknown }).now).toEqual(at);
    expect((captured.policyInput.candles[0] as { closedAt: unknown }).closedAt).toEqual(at);
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("observation", { status: "observed_only" });
  });
  it("keeps the file when outcome persistence fails, then safely recaptures the same immutable identity", async () => {
    const f = await fixture(); await f.spool.enqueue(input, { status: "observed_only" }); await f.spool.acquire();
    f.storage.finalizeOutcome.mockRejectedValueOnce(new Error("commit unavailable"));
    await f.spool.drain(f.storage); expect(await queueFiles(f.directory)).toHaveLength(1);
    f.advance(); await f.spool.drain(f.storage);
    expect(f.storage.capture).toHaveBeenCalledTimes(2);
    expect(f.storage.capture.mock.calls[0]).toEqual(f.storage.capture.mock.calls[1]);
    expect(await queueFiles(f.directory)).toHaveLength(0);
  });
  it("integrates conflict retry and immutable recapture before acknowledging a failed outcome commit", async () => {
    for (const [key, value] of Object.entries({ DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
      ADMIN_USERNAME: "test", ADMIN_PASSWORD: "test", SESSION_SECRET: "test-session-secret-only",
      RPC_HTTP_URL: "https://example.invalid", RPC_WS_URL: "wss://example.invalid", LIVE_TRADING_ENABLED: "false" })) vi.stubEnv(key, value);
    const { PrismaShadowObservationRepository } = await import("@grid-bot/db");
    const f = await fixture(); let existing: { id: string; snapshotId: string; observationHash: string } | null = null;
    const tx = {
      portfolio: { findUniqueOrThrow: vi.fn(async () => ({ id: "portfolio", version: 1, capitalReservations: [],
        assetStrategies: [{ id: "strategy", bands: [{ id: "band", botId: "bot" }] }] })) },
      $executeRaw: vi.fn(async () => 1).mockRejectedValueOnce({ code: "P2010", meta: {
        driverAdapterError: { cause: { originalCode: "40001" } },
      } }),
      shadowMarketSnapshot: { findUniqueOrThrow: vi.fn(async () => ({ id: "first-market" })) },
      shadowJevObservation: { findUnique: vi.fn(async () => existing),
        findUniqueOrThrow: vi.fn(async (args: { where: { observationHash: string } }) => {
          existing = { id: "first-observation", snapshotId: "first-market", observationHash: args.where.observationHash }; return existing;
        }) },
      shadowJevOutbox: { findUniqueOrThrow: vi.fn(async () => ({ observationId: "first-observation" })) },
    };
    const client = { $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
      shadowEngineOutcome: { findUnique: vi.fn(async () => null),
        create: vi.fn(async () => undefined).mockRejectedValueOnce(new Error("outcome commit failed")) } };
    const storage = new PrismaShadowObservationRepository(client as never);
    await f.spool.enqueue({ ...input, questionSetVersion: "shadow-jev-v3.2", candidateSet: { candidates: [] } }, { status: "observed_only" });
    await f.spool.acquire();
    expect(await f.spool.drain(storage)).toMatchObject({ failed: 1, completed: 0 });
    expect(client.$transaction).toHaveBeenCalledTimes(2);
    tx.portfolio.findUniqueOrThrow.mockRejectedValue(new Error("band is now closed"));
    f.advance(); expect(await f.spool.drain(storage)).toMatchObject({ completed: 1, queued: 0 });
    expect(tx.portfolio.findUniqueOrThrow).toHaveBeenCalledTimes(2);
    expect(client.shadowEngineOutcome.create).toHaveBeenCalledTimes(2);
  });
  it("refuses a second active consumer and retains malformed envelopes for diagnosis", async () => {
    const f = await fixture(); await f.spool.acquire();
    const second = new ShadowCaptureSpool(f.directory);
    await expect(second.acquire()).rejects.toThrow("already active");
    await writeFile(join(f.directory, `${"a".repeat(64)}.json`), "{broken");
    expect(await f.spool.drain(f.storage)).toMatchObject({ invalid: 1, queued: 1 });
    expect(await queueFiles(f.directory)).toHaveLength(1);
  });
  it("reports filesystem failure rather than claiming durable capture", async () => {
    const f = await fixture(), blocked = join(f.directory, "not-a-directory"); await writeFile(blocked, "blocked");
    await expect(new ShadowCaptureSpool(blocked).enqueue(input, { status: "observed_only" })).rejects.toThrow();
    expect(f.storage.capture).not.toHaveBeenCalled();
  });
  it("recovers a processing file and dead PID lease after a real consumer process crash", async () => {
    const f = await fixture(); await f.spool.enqueue(input, { status: "observed_only" });
    const module = pathToFileURL(resolve("src/shadow-capture-spool.ts")).href;
    const script = `import { ShadowCaptureSpool } from ${JSON.stringify(module)};
      setInterval(() => {}, 1000);
      const spool = new ShadowCaptureSpool(process.env.SHADOW_TEST_SPOOL);
      await spool.acquire(); await spool.drain({ capture: async () => { console.log('processing');
      return new Promise(() => {}); }, finalizeOutcome: async () => {} });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve("."), env: { ...process.env, SHADOW_TEST_SPOOL: f.directory }, stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolveReady, reject) => {
        let stderr = ""; const timer = setTimeout(() => reject(new Error(`child startup timeout: ${stderr}`)), 10_000);
        child.stderr.on("data", data => { stderr += String(data); });
        child.stdout.on("data", data => { if (String(data).includes("processing")) { clearTimeout(timer); resolveReady(); } });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`child exited ${code}: ${stderr}`)); });
      });
      const file = (await queueFiles(f.directory))[0]!;
      expect(JSON.parse(await readFile(join(f.directory, file), "utf8")).status).toBe("processing");
      const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit())); child.kill("SIGKILL"); await exited;
      await f.spool.acquire();
      expect(await f.spool.drain(f.storage)).toMatchObject({ recovered: 1, completed: 1, queued: 0 });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 15_000);
});
