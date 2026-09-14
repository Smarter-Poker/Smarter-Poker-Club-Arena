import { Worker } from 'node:worker_threads';
import {
  parseDiscoveryReceipt,
  unknownDiscovery,
  type DiscoveryReceipt,
} from './horseAdaptiveJournal/discoveryReceipt.js';
import {
  parseCaptureQueueHealth,
  type CaptureQueueHealth,
} from './horseAdaptiveJournal/captureHealth.js';
import {
  parseJournalQueueHealth,
  type JournalQueueHealth,
} from './horseAdaptiveJournal/queueHealth.js';

interface Child {
  on(event: string, listener: (value: unknown) => void): unknown;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
}
type Owner = {
  child: Child;
  bornAt: number;
  lastMessageAt: number;
  activeAt: number | null;
  ready: boolean;
  reaping: boolean;
  termination: Promise<number> | null;
  exited: Promise<void>;
  resolveExit: () => void;
};
export type JournalWorkerStatus = Readonly<{
  phase: 'stopped' | 'starting' | 'ready' | 'recovering' | 'failed' | 'stopping';
  cycles: number;
  completed: number;
  capturesAdmitted: number;
  captureSlicesContinued: number;
  capturesRefined: number;
  capturesRecovered: number;
  captureGaps: number;
  lastCapture: string | null;
  lastDiscovery: DiscoveryReceipt;
  discoveryReceivedAt: number | null;
  quarantined: number;
  uncertain: number;
  restarts: number;
  lastWork: string | null;
  lastRetention: string | null;
  activeSince: number | null;
  lastMessageAt: number | null;
  queueHealth: JournalQueueHealth;
  queueHealthReceivedAt: number | null;
  captureQueueHealth: CaptureQueueHealth;
  captureQueueHealthReceivedAt: number | null;
}>;
const workStates = new Set([
  'skipped',
  'unavailable',
  'idle',
  'completed',
  'deferred',
  'quarantined',
  'unknown',
  'lease_lost',
]);
const retentionStates = new Set(['skipped', 'pruned', 'unavailable', 'unknown']);
const captureStates = new Set([
  'idle',
  'admitted',
  'continued',
  'captured',
  'refined',
  'gap',
  'deferred',
  'unknown',
  'unavailable',
  'lease_lost',
]);

/** Explicit lifecycle ownership for one separate journal worker. Starting this
 * service discovers retained public actors and journals qualified observations;
 * it does not claim complete source coverage or activate a policy. Its bootstrap
 * owner must stop it before releasing that ownership. */
export class HorseAdaptiveJournalWorker {
  private desired = false;
  private owner: Owner | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private attempts: number[] = [];
  private summary: JournalWorkerStatus = {
    phase: 'stopped',
    cycles: 0,
    completed: 0,
    capturesAdmitted: 0,
    captureSlicesContinued: 0,
    capturesRefined: 0,
    capturesRecovered: 0,
    captureGaps: 0,
    lastCapture: null,
    lastDiscovery: unknownDiscovery(),
    discoveryReceivedAt: null,
    quarantined: 0,
    uncertain: 0,
    restarts: 0,
    lastWork: null,
    lastRetention: null,
    activeSince: null,
    lastMessageAt: null,
    queueHealth: Object.freeze({ status: 'unknown' }),
    queueHealthReceivedAt: null,
    captureQueueHealth: Object.freeze({ status: 'unknown' }),
    captureQueueHealthReceivedAt: null,
  };
  constructor(
    private readonly factory: () => Child = () =>
      new Worker(new URL('./horseAdaptiveJournal/worker.js', import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
        execArgv: [],
      })
  ) {}

  status(): JournalWorkerStatus {
    const h = this.summary.queueHealth;
    const health =
      this.summary.phase === 'ready' &&
      this.summary.queueHealthReceivedAt !== null &&
      Math.abs(Date.now() - this.summary.queueHealthReceivedAt) <= 75000 &&
      (h.status !== 'snapshot' || Math.abs(Date.now() - h.sampledAtMs) <= 75000)
        ? h
        : Object.freeze({ status: 'unknown' as const });
    const c = this.summary.captureQueueHealth;
    const captureHealth =
      this.summary.phase === 'ready' &&
      this.summary.captureQueueHealthReceivedAt !== null &&
      Math.abs(Date.now() - this.summary.captureQueueHealthReceivedAt) <= 75000 &&
      (c.status !== 'snapshot' || Math.abs(Date.now() - c.sampledAtMs) <= 75000)
        ? c
        : Object.freeze({ status: 'unknown' as const });
    return Object.freeze({
      ...this.summary,
      queueHealth: health,
      captureQueueHealth: captureHealth,
    });
  }
  start(): boolean {
    if (this.stopping || this.owner?.reaping) return false;
    if (this.desired) return true;
    this.desired = true;
    this.spawn();
    return true;
  }
  private update(patch: Partial<JournalWorkerStatus>): void {
    this.summary = { ...this.summary, ...patch };
  }
  private spawn(): void {
    if (!this.desired || this.owner) return;
    this.update({
      phase: 'starting',
      activeSince: null,
      queueHealth: Object.freeze({ status: 'unknown' }),
      queueHealthReceivedAt: null,
      captureQueueHealth: Object.freeze({ status: 'unknown' }),
      captureQueueHealthReceivedAt: null,
      lastDiscovery: unknownDiscovery(),
      discoveryReceivedAt: null,
    });
    let child: Child;
    try {
      child = this.factory();
    } catch {
      this.scheduleRestart();
      return;
    }
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const now = Date.now();
    const owner: Owner = {
      child,
      bornAt: now,
      lastMessageAt: now,
      activeAt: null,
      ready: false,
      reaping: false,
      termination: null,
      exited,
      resolveExit,
    };
    this.owner = owner;
    child.on('message', (m: unknown) => this.message(owner, m));
    child.on('error', () => {
      void this.fail(owner);
    });
    child.on('exit', () => {
      owner.resolveExit();
      if (this.owner === owner && this.desired && !owner.reaping) void this.fail(owner);
    });
    this.watchdog = setInterval(() => {
      if (this.owner !== owner || !this.desired || owner.reaping) return;
      const at = Date.now();
      if (
        (!owner.ready && at - owner.bornAt >= 10000) ||
        at - owner.lastMessageAt >= 15000 ||
        (owner.activeAt !== null && at - owner.activeAt >= 30000)
      )
        void this.fail(owner);
    }, 1000);
    this.watchdog.unref();
  }
  private message(owner: Owner, m: unknown): void {
    if (
      this.owner !== owner ||
      !this.desired ||
      owner.reaping ||
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m)
    )
      return;
    const r = m as Record<string, unknown>;
    if (r.type === 'FAILED' || r.type === 'STOPPED') {
      void this.fail(owner);
      return;
    }
    if (r.type === 'HEARTBEAT') {
      owner.lastMessageAt = Date.now();
      this.update({ lastMessageAt: owner.lastMessageAt });
      return;
    }
    if (r.type === 'CAPTURE_HEALTH' && owner.ready && owner.activeAt !== null) {
      this.update({
        captureQueueHealth: parseCaptureQueueHealth(r.value),
        captureQueueHealthReceivedAt: Date.now(),
      });
      owner.lastMessageAt = Date.now();
      this.update({ lastMessageAt: owner.lastMessageAt });
      return;
    }
    if (r.type === 'QUEUE_HEALTH' && owner.ready && owner.activeAt !== null) {
      this.update({
        queueHealth: parseJournalQueueHealth(r.value),
        queueHealthReceivedAt: Date.now(),
      });
      owner.lastMessageAt = Date.now();
      this.update({ lastMessageAt: owner.lastMessageAt });
      return;
    }
    if (r.type === 'READY' && !owner.ready) {
      owner.ready = true;
      this.update({ phase: 'ready' });
    } else if (r.type === 'CYCLE_STARTED' && owner.ready && owner.activeAt === null) {
      owner.activeAt = Date.now();
      this.update({ activeSince: owner.activeAt });
    } else if (
      r.type === 'CYCLE_COMPLETED' &&
      owner.ready &&
      owner.activeAt !== null &&
      typeof r.work === 'string' &&
      workStates.has(r.work) &&
      typeof r.retention === 'string' &&
      retentionStates.has(r.retention) &&
      (r.discovery !== undefined
        ? r.work === 'skipped' && r.retention === 'skipped' && r.acquisition === undefined
        : r.acquisition === undefined
          ? r.work !== 'skipped'
          : r.work === 'skipped' &&
            r.retention === 'skipped' &&
            typeof r.acquisition === 'string' &&
            captureStates.has(r.acquisition))
    ) {
      owner.activeAt = null;
      this.update({
        cycles: this.summary.cycles + 1,
        completed: this.summary.completed + (r.work === 'completed' ? 1 : 0),
        capturesAdmitted: this.summary.capturesAdmitted + (r.acquisition === 'admitted' ? 1 : 0),
        captureSlicesContinued:
          this.summary.captureSlicesContinued + (r.acquisition === 'continued' ? 1 : 0),
        capturesRefined: this.summary.capturesRefined + (r.acquisition === 'refined' ? 1 : 0),
        capturesRecovered: this.summary.capturesRecovered + (r.acquisition === 'captured' ? 1 : 0),
        captureGaps: this.summary.captureGaps + (r.acquisition === 'gap' ? 1 : 0),
        lastCapture: typeof r.acquisition === 'string' ? r.acquisition : this.summary.lastCapture,
        lastDiscovery:
          r.discovery !== undefined
            ? parseDiscoveryReceipt(r.discovery)
            : this.summary.lastDiscovery,
        discoveryReceivedAt:
          r.discovery !== undefined ? Date.now() : this.summary.discoveryReceivedAt,
        quarantined: this.summary.quarantined + (r.work === 'quarantined' ? 1 : 0),
        uncertain:
          this.summary.uncertain +
          (['unavailable', 'deferred', 'unknown', 'lease_lost'].includes(r.work) ||
          ['unavailable', 'deferred', 'unknown', 'lease_lost'].includes(String(r.acquisition)) ||
          (r.discovery !== undefined &&
            ['unavailable', 'deferred', 'unknown'].includes(
              parseDiscoveryReceipt(r.discovery).status
            ))
            ? 1
            : 0),
        lastWork: r.work,
        lastRetention: r.retention,
        activeSince: null,
      });
    } else {
      void this.fail(owner);
      return;
    }
    owner.lastMessageAt = Date.now();
    this.update({ lastMessageAt: owner.lastMessageAt });
  }
  private clearWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }
  private terminate(owner: Owner): Promise<number> {
    if (!owner.termination) {
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Journal worker termination unconfirmed')), 5000);
      });
      owner.termination = Promise.race([
        Promise.resolve().then(() => owner.child.terminate()),
        deadline,
      ]).finally(() => clearTimeout(timer));
    }
    return owner.termination;
  }
  private async fail(owner: Owner): Promise<void> {
    if (this.owner !== owner || owner.reaping) return;
    owner.reaping = true;
    this.clearWatchdog();
    this.update({ phase: 'recovering' });
    try {
      await this.terminate(owner);
    } catch {
      this.desired = false;
      this.update({ phase: 'failed' });
      return;
    }
    if (this.owner !== owner) return;
    this.owner = null;
    this.update({ activeSince: null });
    if (this.desired) this.scheduleRestart();
  }
  private scheduleRestart(): void {
    if (!this.desired || this.owner || this.restart) return;
    const now = Date.now();
    this.attempts = this.attempts.filter((at) => now - at < 3600000);
    if (this.attempts.length >= 3) {
      this.desired = false;
      this.update({ phase: 'failed' });
      return;
    }
    this.attempts.push(now);
    this.update({ phase: 'recovering', restarts: this.summary.restarts + 1 });
    const delay = [1000, 5000, 30000][this.attempts.length - 1];
    this.restart = setTimeout(() => {
      this.restart = null;
      this.spawn();
    }, delay);
    this.restart.unref();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.desired = false;
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    this.clearWatchdog();
    this.update({ phase: 'stopping' });
    const owner = this.owner;
    let operation!: Promise<void>;
    operation = (async () => {
      if (owner) {
        if (owner.reaping) await this.terminate(owner);
        else {
          owner.reaping = true;
          let deadline: ReturnType<typeof setTimeout> | null = null;
          try {
            const expired = new Promise<'deadline'>((resolve) => {
              deadline = setTimeout(() => resolve('deadline'), 20000);
            });
            try {
              owner.child.postMessage({ type: 'STOP' });
            } catch {
              await this.terminate(owner);
            }
            const outcome = await Promise.race([owner.exited.then(() => 'exit' as const), expired]);
            if (outcome === 'deadline') await this.terminate(owner);
          } finally {
            if (deadline) clearTimeout(deadline);
          }
        }
        if (this.owner === owner) this.owner = null;
      }
      this.update({ phase: 'stopped', activeSince: null });
    })()
      .catch((error) => {
        this.update({ phase: 'failed' });
        throw error;
      })
      .finally(() => {
        if (this.stopping === operation) this.stopping = null;
      });
    this.stopping = operation;
    return operation;
  }
}

// Construction is inert; only the leader bootstrap starts this owner.
export const horseAdaptiveJournalWorker = new HorseAdaptiveJournalWorker();
