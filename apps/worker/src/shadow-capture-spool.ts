import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, link, rename, unlink, readdir, readFile, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureShadowObservationInput, CaptureShadowObservationResult, FinalizeShadowOutcomeInput } from "@grid-bot/db";

interface Envelope {
  version: "shadow-capture-spool-v1";
  id: string;
  enqueuedAt: string;
  input: CaptureShadowObservationInput;
  outcome: FinalizeShadowOutcomeInput;
  attempts: number;
  availableAt: number;
  status: "queued" | "processing";
}
interface Lease { pid: number; host: string; token: string; touchedAt: number; processStart?: string }
export interface ShadowCaptureStorage {
  capture(input: CaptureShadowObservationInput): Promise<CaptureShadowObservationResult>;
  finalizeOutcome(id: string, outcome: FinalizeShadowOutcomeInput): Promise<void>;
}
export interface ShadowSpoolMetrics { queued: number; completed: number; failed: number; recovered: number; invalid: number }
const LEASE_MS = 60_000;

/** Local durable handoff only; no DB connections or trading credentials. */
export class ShadowCaptureSpool {
  private lease?: Lease;
  private heartbeat?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly writes = new Set<Promise<void>>();
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {}

  enqueue(input: CaptureShadowObservationInput, outcome: FinalizeShadowOutcomeInput): Promise<void> {
    const id = spoolIdentity(input), path = join(this.directory, `${id}.json`);
    const envelope: Envelope = { version: "shadow-capture-spool-v1", id, enqueuedAt: new Date(this.now()).toISOString(),
      input, outcome, attempts: 0, availableAt: this.now(), status: "queued" };
    // Freeze before yielding to I/O so subsequent runtime mutations cannot alter the capture.
    const frozen = JSON.parse(JSON.stringify(envelope)) as Envelope;
    const write = this.publish(path, frozen);
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), () => this.writes.delete(write));
    return write;
  }

  async flush(): Promise<void> { await Promise.allSettled([...this.writes]); }

  private async publish(path: string, envelope: Envelope): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = await this.writeTemp(path, envelope);
    try {
      // Exclusive atomic publication preserves the first input AND its known outcome.
      try { await link(temp, path); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      await syncDirectory(this.directory);
    } finally { await unlink(temp).catch(() => undefined); }
  }

  async acquire(): Promise<void> {
    if (this.lease) throw new Error("Shadow spool lease already acquired.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, ".consumer");
    try { await mkdir(lock); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const reclaim = join(this.directory, ".consumer-reclaim");
      // Serialize stale lock recovery; inspect again inside this exclusive gate.
      try { await mkdir(reclaim); }
      catch (gateError) {
        if (!hasCode(gateError, "EEXIST")) throw gateError;
        let owner: Lease | undefined;
        try { owner = JSON.parse(await readFile(join(reclaim, "lease.json"), "utf8")) as Lease; } catch { /* incomplete claim */ }
        const live = owner?.host === hostname() && processAlive(owner.pid) &&
          (!owner.processStart || owner.processStart === await processStart(owner.pid));
        if (live || this.now() - (await stat(reclaim)).mtimeMs < LEASE_MS) throw new Error("Shadow spool recovery active.");
        await rename(reclaim, `${reclaim}.stale-${randomUUID()}`);
        await mkdir(reclaim);
      }
      try {
      await this.replace(join(reclaim, "lease.json"), { pid: process.pid, host: hostname(), token: randomUUID(),
        touchedAt: this.now(), processStart: await processStart(process.pid) });
      let existing: Lease | undefined;
      try { existing = JSON.parse(await readFile(join(lock, "lease.json"), "utf8")) as Lease; }
      catch { if (this.now() - (await stat(lock)).mtimeMs < LEASE_MS) throw new Error("Shadow spool lease initializing."); }
      const sameProcess = existing?.host === hostname() && processAlive(existing.pid) &&
        (!existing.processStart || existing.processStart === await processStart(existing.pid));
      if (existing && (existing.host === hostname() ? sameProcess : this.now() - existing.touchedAt < LEASE_MS)) {
        throw new Error("Shadow spool consumer already active.");
      }
      // Rename the stale lease before claiming, so concurrent claimers cannot both own it.
      const stale = `${lock}.stale-${randomUUID()}`;
      await rename(lock, stale);
      try { await mkdir(lock); } finally { await rm(stale, { recursive: true, force: true }); }
      } finally { await rm(reclaim, { recursive: true, force: true }); }
    }
    this.lease = { pid: process.pid, host: hostname(), token: randomUUID(), touchedAt: this.now(), processStart: await processStart(process.pid) };
    try { await this.touchLease(); }
    catch (error) { this.lease = undefined; await rm(lock, { recursive: true, force: true }); throw error; }
    // Every drain checks the token. A temporary filesystem failure must not
    // permanently strand a live consumer; failed renewals can recover later.
    this.heartbeat = setInterval(() => { void this.touchLease().catch(() => undefined); }, 10_000);
    this.heartbeat.unref();
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.lease) {
      await this.assertLease();
      await rm(join(this.directory, ".consumer"), { recursive: true, force: true });
      this.lease = undefined;
    }
  }

  async drain(storage: ShadowCaptureStorage): Promise<ShadowSpoolMetrics> {
    if (this.busy) throw new Error("Shadow spool drain already running.");
    await this.assertLease();
    this.busy = true;
    const metrics: ShadowSpoolMetrics = { queued: 0, completed: 0, failed: 0, recovered: 0, invalid: 0 };
    try {
      const names = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
      metrics.queued = names.length;
      let processed = 0;
      for (const name of names) {
        await this.assertLease();
        const path = join(this.directory, name);
        let envelope: Envelope;
        try {
          envelope = JSON.parse(await readFile(path, "utf8")) as Envelope;
          if (envelope.version !== "shadow-capture-spool-v1" || envelope.id + ".json" !== name ||
            !envelope.input || !envelope.outcome || !Number.isFinite(envelope.availableAt) ||
            !Number.isSafeInteger(envelope.attempts) || envelope.attempts < 0) throw new Error("Invalid spool envelope.");
          envelope.input = restoreInput(envelope.input);
          if (spoolIdentity(envelope.input) !== envelope.id) throw new Error("Invalid spool identity.");
        } catch { metrics.invalid++; continue; }
        if (envelope.status !== "processing" && envelope.availableAt > this.now()) continue;
        if (processed++ >= 20) break;
        if (envelope.status === "processing") metrics.recovered++;
        envelope.status = "processing";
        await this.replace(path, envelope);
        try {
          const result = await storage.capture(envelope.input);
          await storage.finalizeOutcome(result.observationId, envelope.outcome);
          await this.assertLease();
          await unlink(path);
          await syncDirectory(this.directory);
          metrics.completed++; metrics.queued--;
        } catch {
          // Keep the exact original input/outcome through DB outages and restarts.
          envelope.attempts++;
          envelope.availableAt = this.now() + Math.min(300_000, 1_000 * 2 ** Math.min(envelope.attempts - 1, 9));
          envelope.status = "queued";
          await this.assertLease();
          await this.replace(path, envelope);
          metrics.failed++;
        }
      }
      return metrics;
    } finally { this.busy = false; }
  }

  private async writeTemp(path: string, value: unknown): Promise<string> {
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temp).catch(() => undefined); throw error; }
    await handle.close(); return temp;
  }
  private async replace(path: string, value: unknown): Promise<void> {
    const temp = await this.writeTemp(path, value);
    try { await rename(temp, path); await syncDirectory(dirname(path)); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  private async touchLease(): Promise<void> {
    if (!this.lease) throw new Error("Shadow spool lease lost.");
    try {
      const stored = JSON.parse(await readFile(join(this.directory, ".consumer", "lease.json"), "utf8")) as Lease;
      if (stored.token !== this.lease.token) throw new Error("Shadow spool lease changed.");
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    this.lease.touchedAt = this.now();
    await this.replace(join(this.directory, ".consumer", "lease.json"), this.lease);
  }
  private async assertLease(): Promise<void> {
    if (!this.lease) throw new Error("Shadow spool requires an active consumer lease.");
    const current = JSON.parse(await readFile(join(this.directory, ".consumer", "lease.json"), "utf8")) as Lease;
    if (current.token !== this.lease.token) throw new Error("Shadow spool consumer lease changed.");
  }
}

function spoolIdentity(input: CaptureShadowObservationInput): string {
  return createHash("sha256").update(JSON.stringify([input.portfolioId, input.strategyId, input.bandId, input.botId,
    new Date(input.observedAt).toISOString(), input.questionSetVersion, input.modelRequested])).digest("hex");
}
function restoreInput(input: CaptureShadowObservationInput): CaptureShadowObservationInput {
  const policy = input.policyInput as typeof input.policyInput & { now?: string | Date };
  return { ...input, observedAt: validDate(input.observedAt), policyInput: { ...policy,
    ...(policy.now === undefined ? {} : { now: validDate(policy.now) }),
    candles: policy.candles.map(c => {
      const row = c as Record<string, unknown>;
      return { ...row, ...(row.openedAt === undefined ? {} : { openedAt: validDate(row.openedAt) }),
        ...(row.closedAt === undefined ? {} : { closedAt: validDate(row.closedAt) }) };
    }) } };
}
function validDate(value: unknown): Date {
  const date = new Date(value as string); if (!Number.isFinite(+date)) throw new Error("Invalid spool date."); return date;
}
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return !hasCode(error, "ESRCH"); }
}
async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const row = await readFile(`/proc/${pid}/stat`, "utf8");
    return row.slice(row.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return undefined; }
}
function hasCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === code); }
async function syncDirectory(path: string): Promise<void> {
  // Windows cannot fsync directories; production spool lives on a Linux volume.
  if (process.platform === "win32") return;
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
