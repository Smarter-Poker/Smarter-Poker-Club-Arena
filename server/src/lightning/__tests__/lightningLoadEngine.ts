/**
 * LIGHTNING PHASE 12: one engine process (supervisor, workers, hosting,
 * hosts, registry) wired against a FakeLightningWorld, plus the simulated
 * clients and the table driver that plays every hand like a crowd would.
 * See lightningLoadChaosKit.ts for the world itself. Both live under
 * __tests__ so the engine image never compiles them (tsconfig.runtime.json).
 */
import { LightningSupervisor } from '../LightningSupervisor.js';
import { LightningHosting, LightningRegistry } from '../LightningRegistry.js';
import { LightningClusterWorker } from '../LightningClusterWorker.js';
import { LightningMetrics, type LightningLatencySegment } from '../LightningMetrics.js';
import { LightningFormationGate } from '../LightningFormationGate.js';
import type { LightningHandHost } from '../LightningHandHost.js';
import { MetricsRegistry } from '../../observability/Metrics.js';
import { FakeLightningWorld, LoadHub } from './lightningLoadChaosKit.js';
import { fakeHorseLane } from '../../testing/lightningHostTestKit.js';

export const quietLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface LoadEngineOptions {
  /** The forming call's timeout (the RPC timeout injection shortens it). */
  formTimeoutMs?: number;
  /** Players (fraction) whose client never acknowledges a render (a background tab). */
  noAckShare?: number;
  /** Client render time, ms. */
  renderMs?: () => number;
  rnd?: () => number;
}

export class LoadEngine {
  readonly registry: LightningRegistry;
  readonly hosting: LightningHosting;
  readonly supervisor: LightningSupervisor;
  readonly hub: LoadHub;
  readonly metrics: LightningMetrics;
  readonly gate = new LightningFormationGate();
  readonly samples = new Map<LightningLatencySegment, number[]>();
  /** Player -> when their room's socket connected (join) and when their first hand reached it. */
  readonly joinedAt = new Map<string, number>();
  readonly firstHandAt = new Map<string, number>();
  readonly connected = new Set<string>();
  readonly noAck = new Set<string>();
  private readonly rnd: () => number;
  private readonly renderMs: () => number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    readonly world: FakeLightningWorld,
    opts: LoadEngineOptions = {}
  ) {
    this.rnd = opts.rnd ?? Math.random;
    this.renderMs = opts.renderMs ?? (() => 5 + Math.floor(this.rnd() * 30));
    this.metrics = new LightningMetrics(new MetricsRegistry());
    const observe = this.metrics.observeLatency.bind(this.metrics);
    this.metrics.observeLatency = (segment, ms, clusterId) => {
      let s = this.samples.get(segment);
      if (!s) this.samples.set(segment, (s = []));
      if (Number.isFinite(ms) && ms >= 0) s.push(ms);
      observe(segment, ms, clusterId);
    };
    this.hub = new LoadHub((room) => world.sessionOwner.get(room));
    this.registry = new LightningRegistry({
      viewAccess: async (room, user) => {
        const p = world.players.get(user);
        return (
          !!p && p.poolSessionId === room && world.clusters.get(p.clusterId)?.mode !== 'must_move'
        );
      },
      roomOwner: async (room) => {
        const owner = world.sessionOwner.get(room);
        const p = owner ? world.players.get(owner) : undefined;
        return p ? { playerId: p.id, clusterId: p.clusterId } : null;
      },
      clusterMode: async (c) => world.clusters.get(c)?.mode ?? null,
      presenceReport: null,
      metrics: this.metrics,
    });
    const lane = fakeHorseLane();
    this.hosting = new LightningHosting({
      registry: this.registry,
      backend: world.backend,
      hub: this.hub,
      leaseFor: () => ({ ...world.lease }),
      metrics: this.metrics,
      autoRebuy: null,
      hostOptions: {
        sleep: () => Promise.resolve(),
        logger: quietLogger,
        horseLane: () => lane.lane,
        jackpot: {
          payMain: async () => ({ status: 'nothing_to_pay', reason: 'load' }),
          payMini: async () => ({ status: 'skipped', reason: 'load' }),
        } as never,
        postCommitBudgetMs: 50,
      },
    });
    this.supervisor = new LightningSupervisor({
      presenceSource: () => [...this.registry.presenceReports(), ...world.anchorReports()],
      discover: async () => world.discover(),
      rpc: world.rpc,
      metrics: this.metrics,
      logger: quietLogger,
      frozen: () => false,
      hosting: this.hosting,
      sweepRooms: () => this.registry.sweepEndedRooms(),
      // LIGHTNING PHASE 13: a held Cluster's rooms are told, exactly as GameServer wires it.
      clusterStatus: (clusterId, status) => this.registry.setClusterStatus(clusterId, status),
      frontTable: async (c) => world.clusters.get(c)?.frontTable ?? null,
      workerOptions: {
        formationGate: this.gate,
        ...(opts.formTimeoutMs !== undefined ? { formTimeoutMs: opts.formTimeoutMs } : {}),
      },
    });
    this.registry.setArrivalListener((c) => this.supervisor.admit(c));
    // A client renders each new hand its room is sent, then acknowledges it.
    this.hub.onNewHand = (room, handId) => {
      const user = world.sessionOwner.get(room);
      if (!user) return;
      if (!this.firstHandAt.has(user)) this.firstHandAt.set(user, Date.now());
      if (!this.connected.has(user) || this.noAck.has(user)) return;
      this.later(this.renderMs(), () => this.registry.renderAck(room, user, handId));
    };
    const share = opts.noAckShare ?? 0;
    // A background tab never paints, so it never acknowledges a render.
    for (const p of world.players.values())
      if (p.presentVia === 'room' && this.rnd() < share) this.noAck.add(p.id);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Every host this process has, across Clusters. */
  hosts(): LightningHandHost[] {
    const out: LightningHandHost[] = [];
    for (const c of this.world.clusters.keys()) out.push(...this.registry.hostsOf(c));
    return out;
  }

  /** Hosts still starting or dealing (the hosting's own pending set). */
  pendingHosts(): number {
    return (this.hosting as unknown as { pending: Set<unknown> }).pending.size;
  }

  start(): void {
    this.supervisor.start();
  }

  /** A human's client opens their room (JOIN LIGHTNING landed, or a reconnect). */
  async join(playerId: string): Promise<boolean> {
    const p = this.world.players.get(playerId)!;
    const verdict = await this.registry.authorize(p.poolSessionId, playerId);
    if (!verdict.allowed) return false;
    p.online = true;
    if (!this.joinedAt.has(playerId)) this.joinedAt.set(playerId, Date.now());
    this.connected.add(playerId);
    this.registry.connect(p.poolSessionId, playerId, 'desktop');
    return true;
  }

  /** The socket drops (the DB presence stamp is the reporter's business; here it stays). */
  drop(playerId: string): void {
    const p = this.world.players.get(playerId)!;
    if (!this.connected.delete(playerId)) {
      // A duplicated / reordered disconnect: the registry must shrug it off.
      this.registry.disconnect(p.poolSessionId, playerId);
      return;
    }
    this.registry.disconnect(p.poolSessionId, playerId);
  }

  async stop(): Promise<void> {
    await this.supervisor.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export interface DriverOptions {
  rnd: () => number;
  /** Chance a player facing a bet folds on their turn. */
  foldShare?: number;
  /** Of the folds, the share that are LIGHTNING FOLD / FOLD & WATCH. */
  fastShare?: number;
  watchShare?: number;
  /** Chance per tick that a player facing a bet LIGHTNING FOLDs ahead of their turn. */
  earlyFoldShare?: number;
  /** A human's think time, ms (the turn waits this long). */
  thinkMs?: () => number;
  /** Duplicate every Nth fold request (a double tap / a duplicated event). */
  duplicateFoldEvery?: number;
}

/**
 * Plays every live hand like a crowd: on each tick, each host whose turn is
 * due gets one legal action. Folds go through the same doors a client uses
 * (LIGHTNING FOLD and FOLD & WATCH through the host's action door).
 */
export class TableDriver {
  private running = false;
  private readonly due = new Map<LightningHandHost, number>();
  actions = 0;
  folds = 0;
  duplicateFolds = 0;
  private foldSeq = 0;

  constructor(
    private readonly engine: LoadEngine,
    private readonly opts: DriverOptions
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      try {
        this.tick();
      } catch {
        // a driver hiccup is not an engine fault
      }
      // A crowd acts every millisecond or so; never a busy loop that starves the engine.
      setTimeout(loop, 1);
    };
    setTimeout(loop, 1);
  }

  stop(): void {
    this.running = false;
  }

  private tick(): void {
    const now = Date.now();
    const { rnd } = this.opts;
    for (const host of this.engine.hosts()) {
      if (host.lifecycle !== 'dealing') continue;
      const st = host.peekState();
      if (!st || !['preflop', 'flop', 'turn', 'river'].includes(st.stage)) continue;
      // Early LIGHTNING FOLDs by players facing a bet who are not on the clock.
      const early = this.opts.earlyFoldShare ?? 0;
      if (early > 0) {
        for (const p of st.players) {
          if (p.seat === st.currentPlayerSeat || p.is_folded || p.is_all_in) continue;
          if (st.currentBet - p.bet <= 0 || rnd() >= early) continue;
          this.fold(host, p.user_id, 'fast_fold');
        }
      }
      if (st.currentPlayerSeat < 1) continue;
      const cur = st.players.find((x) => x.seat === st.currentPlayerSeat);
      if (!cur) continue;
      const at = this.due.get(host);
      if (at === undefined) {
        this.due.set(host, now + (this.opts.thinkMs?.() ?? 0));
        continue;
      }
      if (at > now) continue;
      this.due.delete(host);
      const legal: string[] =
        (
          host as unknown as {
            hc: { getAuthoritativeActionState(u: string): { legalActions: string[] } | null };
          }
        ).hc?.getAuthoritativeActionState(cur.user_id)?.legalActions ?? [];
      if (legal.length === 0) continue;
      const facing = st.currentBet - cur.bet > 0;
      if (facing && legal.includes('fold') && rnd() < (this.opts.foldShare ?? 0.45)) {
        const r = rnd();
        const fast = this.opts.fastShare ?? 0.5;
        const watch = this.opts.watchShare ?? 0.15;
        const kind = r < fast ? 'fast_fold' : r < fast + watch ? 'fold_watch' : 'fold';
        this.fold(host, cur.user_id, kind);
        continue;
      }
      let a = legal.includes('check') ? 'check' : legal.includes('call') ? 'call' : legal[0];
      if (rnd() < 0.03 && (legal.includes('raise') || legal.includes('bet'))) a = 'all_in';
      this.actions++;
      const res = host.handlePlayerAction(cur.user_id, a);
      if (!res.success)
        host.handlePlayerAction(cur.user_id, legal.includes('check') ? 'check' : 'fold');
    }
    for (const h of [...this.due.keys()]) if (h.lifecycle !== 'dealing') this.due.delete(h);
  }

  private fold(host: LightningHandHost, userId: string, kind: string): void {
    this.folds++;
    this.foldSeq++;
    const res = host.handlePlayerAction(userId, kind);
    if (this.opts.duplicateFoldEvery && this.foldSeq % this.opts.duplicateFoldEvery === 0) {
      // The same tap delivered twice: the second must be refused, never a second fold.
      this.duplicateFolds++;
      host.handlePlayerAction(userId, kind);
    }
    if (!res.success && kind !== 'fold') host.handlePlayerAction(userId, 'fold');
  }
}

/** Count the worker's passes and time them (every Cluster, every worker object). */
export function instrumentWorkerPasses(): {
  durations: number[];
  outcomes: Array<{ at: number; outcome: string; reason?: string; formed?: number }>;
  starts: () => number;
  restore: () => void;
} {
  const proto = LightningClusterWorker.prototype as unknown as {
    pass: () => Promise<{ outcome: string; reason?: string; formed?: number }>;
    start: () => void;
  };
  const origPass = proto.pass;
  const origStart = proto.start;
  const durations: number[] = [];
  const outcomes: Array<{ at: number; outcome: string; reason?: string; formed?: number }> = [];
  let starts = 0;
  proto.pass = async function (this: unknown) {
    const t0 = performance.now();
    const r = await origPass.call(this);
    durations.push(performance.now() - t0);
    outcomes.push({ at: Date.now(), outcome: r.outcome, reason: r.reason, formed: r.formed });
    return r;
  };
  proto.start = function (this: unknown) {
    starts++;
    return origStart.call(this);
  };
  return {
    durations,
    outcomes,
    starts: () => starts,
    restore: () => {
      proto.pass = origPass;
      proto.start = origStart;
    },
  };
}

export const waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until `cond` holds or `ms` passes; answers whether it held. */
export async function waitFor(cond: () => boolean, ms: number, step = 10): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await waitMs(step);
  }
  return cond();
}

export { FakeLightningWorld };
