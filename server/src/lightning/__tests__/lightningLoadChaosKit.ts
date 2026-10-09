/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LIGHTNING PHASE 12: AN IN-MEMORY LIGHTNING WORLD FOR LOAD AND CHAOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The engine's real Lightning stack - LightningSupervisor, its
 * LightningClusterWorkers, LightningHosting, every LightningHandHost and the
 * LightningRegistry - driven against a fake of the RPC layer that models the
 * database CONTRACT faithfully:
 *
 *   - fn_lightning_match_and_form: one pass per Cluster at a time (a second
 *     concurrent call answers `pass_in_progress` and is COUNTED - the engine
 *     must never cause one), a recorded request id is REPLAYED, at most
 *     p_max_hands hands per pass (`max_hands` when cut short), only idle,
 *     present, funded players, never a player already reserved anywhere;
 *   - reservations: a formed player is held by their instance until
 *     settlement, an abandon, or a LIGHTNING / normal fold releases them;
 *   - begin_dealing / bind / abandon move the instance's state exactly as
 *     the SQL does, and refuse out-of-order calls;
 *   - fn_lightning_fast_fold is idempotent per request id;
 *   - fn_lightning_settle_hand is idempotent per request id: the same body
 *     replays the same receipt, a different body is IDEMPOTENCY_CONFLICT, a
 *     second request id for a settled hand is a violation, an abandoned
 *     instance is refused, a body that does not conserve chips FREEZES;
 *   - fn_lightning_latency_report is idempotent per (cluster, window_from);
 *   - a formation reaper voids instances nobody hosts (crash recovery).
 *
 * Every fault the chaos suite injects (transport before / after commit,
 * delays, hangs, connection loss) goes through `faults`. Nothing here talks
 * to a database; no card is ever logged.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5): a horse is a pool player like any
 * other; it is reported present by its anchor engine instead of a room
 * socket, which is the only difference the world models.
 */
import { createHash } from 'node:crypto';
import type {
  LightningCallOutcome,
  LightningHandBackend,
  LightningParticipant,
  LightningSettleArgs,
} from '../LightningHandBackend.js';
import type { LightningHub } from '../LightningHandHost.js';
import type { PresenceTableReport } from '../LightningPresence.js';
import type { LightningRpcClient } from '../LightningRpc.js';

export const uidN = (prefix: number, n: number): string =>
  `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

export type FaultKind = 'transport_before' | 'transport_after' | 'hang';
export interface Fault {
  kind: FaultKind;
  /** For 'hang': the answer (and its effect) arrives this much later. */
  ms?: number;
}
export type FaultDecider = (
  fn: string,
  ctx: { clusterId?: string; instanceId?: string; handId?: string; playerId?: string }
) => Fault | null;

export interface FakeCluster {
  id: string;
  mode: 'lightning' | 'pending_off' | 'must_move' | 'frozen';
  frontTable: string;
  instanceMax: number;
  maxHands: number;
  bigBlind: number;
}

export interface FakePlayer {
  id: string;
  clusterId: string;
  poolSessionId: string;
  stack: number;
  isHorse: boolean;
  /**
   * How the engine hears this player is present: a room socket (a browser),
   * or the anchor engine that drives the seat (a horse's input device). The
   * only difference the world models; everything else is identical.
   */
  presentVia: 'room' | 'anchor';
  /** The DB's own view of presence (disconnected_at unset). */
  online: boolean;
  /** The non-terminal instance holding this player's reservation, if any. */
  instanceId: string | null;
  idleSinceMs: number;
  /** Chips committed to hands they folded out of, not yet settled (fn_lightning_pool_exposure). */
  exposure: Map<string, number>;
}

export interface FakeInstance {
  id: string;
  handId: string;
  clusterId: string;
  players: string[];
  bb: string;
  sb: string;
  btn: string;
  state: 'reserved' | 'dealing' | 'complete' | 'abandoned';
  formedAtMs: number;
  handNumber: number | null;
  /** Whose hosts are known dead (crash injection): the reaper's to void. */
  hostDead: boolean;
  /** Players a LIGHTNING / normal fold released from this instance while it plays on. */
  released: Set<string>;
}

interface SettleRecord {
  requestId: string;
  bodyHash: string;
  receipt: string;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });

const transportError = (fn: string) => ({
  data: null,
  error: { code: '08006', message: `${fn}: connection lost (injected)` },
});

const cents = (n: number) => Math.round(n * 100);

export interface FakeWorldOptions {
  clusters: number;
  playersPerCluster: number;
  /** Players (by index within a Cluster) that are horses. */
  horseEvery?: number;
  stack?: number;
  /** Simulated RPC round trip, in ms (0 = answer on the next microtask). */
  rpcLatencyMs?: () => number;
  passIntervalMs?: number;
  latencyWindowMs?: number;
  maxHands?: number;
  seed?: number;
}

export class FakeLightningWorld {
  readonly clusters = new Map<string, FakeCluster>();
  readonly players = new Map<string, FakePlayer>();
  readonly sessionOwner = new Map<string, string>();
  readonly instances = new Map<string, FakeInstance>();
  readonly instanceOfHand = new Map<string, string>();
  /** Instances still reserved or dealing (the formation check reads only these). */
  private readonly openIds = new Set<string>();
  private readonly byCluster = new Map<string, FakePlayer[]>();
  private readonly passRecords = new Map<string, Record<string, unknown>>();
  private readonly settleRecords = new Map<string, SettleRecord>();
  private readonly foldRecords = new Map<string, string>();
  private readonly latencyBodies = new Map<string, string>();
  readonly latencyReports: Array<Record<string, unknown>> = [];
  private readonly mafInFlight = new Map<string, number>();
  /** fn_lightning_match_and_form calls per Cluster. */
  readonly mafByCluster = new Map<string, number>();
  readonly violations: string[] = [];
  readonly counters = {
    matchAndForm: 0,
    passInProgress: 0,
    replayed: 0,
    formed: 0,
    settleCalls: 0,
    settleReplays: 0,
    settled: 0,
    idempotencyConflicts: 0,
    abandoned: 0,
    reaped: 0,
    fastFolds: 0,
    latencyReports: 0,
    latencyConflicts: 0,
    rpcCalls: 0,
    maxHandsInOnePass: 0,
  };
  rake = 0;
  bbj = 0;
  readonly initialChips: number;
  lease = { instance: 'load-engine', generation: uidN(4242, 1) };
  faults: FaultDecider | null = null;
  private handNo = 5_000_000;
  private instSeq = 0;
  private readonly rpcLatency: () => number;
  readonly passIntervalMs: number;
  readonly latencyWindowMs: number;

  constructor(opts: FakeWorldOptions) {
    this.rpcLatency = opts.rpcLatencyMs ?? (() => 0);
    this.passIntervalMs = opts.passIntervalMs ?? 500;
    this.latencyWindowMs = opts.latencyWindowMs ?? 10_000;
    const stack = opts.stack ?? 200;
    let total = 0;
    for (let c = 0; c < opts.clusters; c++) {
      const id = uidN(1000 + c, 1);
      this.clusters.set(id, {
        id,
        mode: 'lightning',
        frontTable: uidN(9000 + c, 1),
        instanceMax: 6,
        maxHands: opts.maxHands ?? 32,
        bigBlind: 2 * (c + 1),
      });
      for (let i = 0; i < opts.playersPerCluster; i++) {
        const pid = uidN(2000 + c, i + 1);
        const session = uidN(3000 + c, i + 1);
        const isHorse = !!opts.horseEvery && i % opts.horseEvery === opts.horseEvery - 1;
        this.players.set(pid, {
          id: pid,
          clusterId: id,
          poolSessionId: session,
          stack: stack * (c + 1),
          isHorse,
          presentVia: isHorse ? 'anchor' : 'room',
          online: isHorse,
          instanceId: null,
          idleSinceMs: Date.now(),
          exposure: new Map(),
        });
        this.sessionOwner.set(session, pid);
        total += stack * (c + 1);
      }
    }
    this.initialChips = total;
  }

  // ─── WORLD QUERIES ──────────────────────────────────────────────────────

  playersOf(clusterId: string): FakePlayer[] {
    let list = this.byCluster.get(clusterId);
    if (!list) {
      list = [...this.players.values()].filter((p) => p.clusterId === clusterId);
      this.byCluster.set(clusterId, list);
    }
    return list;
  }

  chipsNow(): number {
    let s = 0;
    for (const p of this.players.values()) s += p.stack;
    return s;
  }

  openInstances(): FakeInstance[] {
    return [...this.openIds]
      .map((id) => this.instances.get(id)!)
      .filter((i) => i.state === 'reserved' || i.state === 'dealing');
  }

  /** Players whose reservation points at an instance that is already over (must be none). */
  orphanReservations(): string[] {
    const out: string[] = [];
    for (const p of this.players.values()) {
      if (!p.instanceId) continue;
      const inst = this.instances.get(p.instanceId);
      if (!inst || inst.state === 'complete' || inst.state === 'abandoned') out.push(p.id);
    }
    return out;
  }

  /** The anchor engines' report: horses are present through their anchor seat. */
  anchorReports(): PresenceTableReport[] {
    const out: PresenceTableReport[] = [];
    for (const c of this.clusters.values()) {
      out.push({
        tableId: c.frontTable,
        clusterId: c.id,
        players: this.playersOf(c.id)
          .filter((p) => p.presentVia === 'anchor')
          .map((p) => ({ userId: p.id, presence: 'connected' as const })),
      });
    }
    return out;
  }

  discover(): Array<{ clusterId: string; draining: boolean }> {
    return [...this.clusters.values()]
      .filter((c) => c.mode === 'lightning' || c.mode === 'pending_off')
      .map((c) => ({ clusterId: c.id, draining: c.mode === 'pending_off' }));
  }

  /** The formation reaper: void every open instance nobody hosts any more. */
  reap(isHosted: (instanceId: string) => boolean): number {
    let n = 0;
    for (const inst of this.openInstances()) {
      if (isHosted(inst.id) && !inst.hostDead) continue;
      this.abandonInstance(inst);
      n++;
    }
    this.counters.reaped += n;
    return n;
  }

  private violate(what: string): void {
    if (this.violations.length < 200) this.violations.push(what);
  }

  private async latency(): Promise<void> {
    const ms = this.rpcLatency();
    if (ms > 0) await sleep(ms);
    else await Promise.resolve();
  }

  private fault(fn: string, ctx: Parameters<FaultDecider>[1]): Fault | null {
    try {
      return this.faults?.(fn, ctx) ?? null;
    } catch {
      return null;
    }
  }

  // ─── THE RPC CLIENT (worker, supervisor, ledger) ─────────────────────────

  readonly rpc: LightningRpcClient = async (fn, args) => {
    this.counters.rpcCalls++;
    if (fn === 'fn_lightning_config') {
      await this.latency();
      const c = this.clusters.get(String(args.p_cluster_id));
      if (!c) return { data: { ok: false, reason: 'not_found' }, error: null };
      return {
        data: {
          ok: true,
          matcher_version: 'm1',
          worker_mode: 'form',
          pass_interval_ms: this.passIntervalMs,
          keepalive_interval_ms: 600_000,
          admission_batch_hands: c.maxHands,
          deal_window_ms: 600_000,
          latency_telemetry: true,
          latency_window_ms: this.latencyWindowMs,
        },
        error: null,
      };
    }
    if (fn === 'fn_lightning_match_and_form') return this.matchAndForm(args);
    if (fn === 'fn_lightning_latency_report') return this.latencyReport(args);
    throw new Error(`unexpected rpc ${fn}`);
  };

  private async matchAndForm(args: Record<string, unknown>) {
    const clusterId = String(args.p_cluster_id);
    const requestId = String(args.p_request_id);
    this.counters.matchAndForm++;
    this.mafByCluster.set(clusterId, (this.mafByCluster.get(clusterId) ?? 0) + 1);
    const f = this.fault('fn_lightning_match_and_form', { clusterId });
    if (f?.kind === 'transport_before') {
      await this.latency();
      return transportError('fn_lightning_match_and_form');
    }
    // ONE PASS PER CLUSTER AT A TIME (the advisory lock).
    if ((this.mafInFlight.get(clusterId) ?? 0) > 0) {
      this.counters.passInProgress++;
      await this.latency();
      return {
        data: {
          ok: true,
          formed: 0,
          skipped: true,
          reason: 'pass_in_progress',
          stopped_reason: 'pass_in_progress',
          hands: [],
        },
        error: null,
      };
    }
    this.mafInFlight.set(clusterId, 1);
    try {
      await this.latency();
      if (f?.kind === 'hang') await sleep(f.ms ?? 1_000);
      const prev = this.passRecords.get(requestId);
      let answer: Record<string, unknown>;
      if (prev) {
        this.counters.replayed++;
        answer = { ...prev, replayed: true };
      } else {
        answer = this.formPass(clusterId, requestId, args);
      }
      if (f?.kind === 'transport_after') return transportError('fn_lightning_match_and_form');
      return { data: answer, error: null };
    } finally {
      this.mafInFlight.set(clusterId, 0);
    }
  }

  private formPass(clusterId: string, requestId: string, args: Record<string, unknown>) {
    const c = this.clusters.get(clusterId);
    if (!c) return { ok: false, formed: 0, reason: 'not_found' };
    if (c.mode === 'frozen') {
      return {
        ok: false,
        formed: 0,
        hands: [],
        frozen: true,
        stopped_reason: 'frozen',
        reason: 'cluster_frozen',
      };
    }
    if (c.mode !== 'lightning') {
      return {
        ok: true,
        formed: 0,
        skipped: true,
        reason: c.mode,
        stopped_reason: c.mode,
        hands: [],
      };
    }
    const disconnected = new Set(
      Array.isArray(args.p_disconnected) ? (args.p_disconnected as string[]) : []
    );
    const maxHands = Math.min(c.maxHands, Math.max(0, Number(args.p_max_hands) || c.maxHands));
    const now = Date.now();
    const eligible = this.playersOf(clusterId)
      .filter(
        (p) =>
          p.instanceId === null &&
          p.online &&
          !disconnected.has(p.id) &&
          p.stack - this.exposureOf(p) >= c.bigBlind
      )
      .sort((a, b) => a.idleSinceMs - b.idleSinceMs || (a.id < b.id ? -1 : 1));
    const hands: Array<Record<string, unknown>> = [];
    while (eligible.length >= 2 && hands.length < maxHands) {
      const size = Math.min(c.instanceMax, eligible.length);
      const group = eligible.splice(0, size);
      for (const p of group) {
        // A player in any non-terminal instance anywhere may never be formed again.
        for (const id of this.openIds) {
          const inst = this.instances.get(id)!;
          if (
            (inst.state === 'reserved' || inst.state === 'dealing') &&
            inst.players.includes(p.id) &&
            !inst.released.has(p.id)
          )
            this.violate(`player_in_two_instances:${p.id}`);
        }
      }
      this.instSeq++;
      const instanceId = uidN(7000, this.instSeq);
      const handId = uidN(8000, this.instSeq);
      const players = group.map((p) => p.id);
      const inst: FakeInstance = {
        id: instanceId,
        handId,
        clusterId,
        players,
        bb: players[0],
        sb: players[1],
        btn: players.length === 2 ? players[1] : players[players.length - 1],
        state: 'reserved',
        formedAtMs: now,
        handNumber: null,
        hostDead: false,
        released: new Set(),
      };
      this.instances.set(instanceId, inst);
      this.openIds.add(instanceId);
      this.instanceOfHand.set(handId, instanceId);
      for (const p of group) p.instanceId = instanceId;
      hands.push({
        hand_id: handId,
        instance_id: instanceId,
        bb: inst.bb,
        sb: inst.sb,
        btn: inst.btn,
        players,
      });
    }
    this.counters.formed += hands.length;
    this.counters.maxHandsInOnePass = Math.max(this.counters.maxHandsInOnePass, hands.length);
    const answer = {
      ok: true,
      replayed: false,
      cluster_id: clusterId,
      request_id: requestId,
      matcher_version: 'm1',
      formed: hands.length,
      hands,
      stopped_reason: hands.length >= maxHands ? 'max_hands' : 'plan_exhausted',
      frozen: false,
    };
    this.passRecords.set(requestId, answer);
    return answer;
  }

  private async latencyReport(args: Record<string, unknown>) {
    await this.latency();
    const f = this.fault('fn_lightning_latency_report', { clusterId: String(args.p_cluster_id) });
    if (f?.kind === 'transport_before') return transportError('fn_lightning_latency_report');
    const key = `${String(args.p_cluster_id)}/${String(args.p_window_from)}`;
    const body = JSON.stringify([args.p_window_to, args.p_legs]);
    const prev = this.latencyBodies.get(key);
    if (prev !== undefined && prev !== body) {
      this.counters.latencyConflicts++;
      this.violate(`latency_idempotency_conflict:${key}`);
      return { data: { ok: false, code: 'IDEMPOTENCY_CONFLICT' }, error: null };
    }
    if (prev === undefined) {
      this.latencyBodies.set(key, body);
      this.latencyReports.push(structuredClone(args));
      this.counters.latencyReports++;
    }
    if (f?.kind === 'transport_after') return transportError('fn_lightning_latency_report');
    return { data: { ok: true, replayed: prev !== undefined }, error: null };
  }

  private exposureOf(p: FakePlayer): number {
    let e = 0;
    for (const v of p.exposure.values()) e += v;
    return e;
  }

  private abandonInstance(inst: FakeInstance): void {
    if (inst.state !== 'reserved' && inst.state !== 'dealing') return;
    inst.state = 'abandoned';
    this.openIds.delete(inst.id);
    this.counters.abandoned++;
    for (const pid of inst.players) {
      const p = this.players.get(pid)!;
      p.exposure.delete(inst.id);
      if (p.instanceId === inst.id) {
        p.instanceId = null;
        p.idleSinceMs = Date.now();
      }
    }
  }

  // ─── THE HAND BACKEND (every host) ──────────────────────────────────────

  readonly backend: LightningHandBackend = {
    beginDealing: async (instanceId) => {
      const f = this.fault('beginDealing', { instanceId });
      await this.latency();
      if (f?.kind === 'transport_before')
        return { ok: false, reason: 'begin_failed', transport: true };
      const inst = this.instances.get(instanceId);
      if (!inst || inst.state !== 'reserved') return { ok: false, reason: 'not_reserved' };
      inst.state = 'dealing';
      if (f?.kind === 'transport_after')
        return { ok: false, reason: 'begin_failed', transport: true };
      return { ok: true, value: { handId: inst.handId } };
    },
    nextHandNumber: async () => {
      await this.latency();
      return ++this.handNo;
    },
    bindHandNumber: async (instanceId, handNumber) => {
      await this.latency();
      const inst = this.instances.get(instanceId);
      if (!inst || inst.state !== 'dealing') return { ok: false, reason: 'not_dealing' };
      if (inst.handNumber !== null && inst.handNumber !== handNumber)
        return { ok: false, reason: 'already_bound' };
      inst.handNumber = handNumber;
      return {
        ok: true,
        value: {
          handId: inst.handId,
          handNumber,
          hostTableId: this.clusters.get(inst.clusterId)!.frontTable,
        },
      };
    },
    loadParticipants: async (handId) => {
      await this.latency();
      const inst = this.instances.get(this.instanceOfHand.get(handId) ?? '');
      if (!inst) return [];
      const n = inst.players.length;
      const others = inst.players.filter((p) => p !== inst.bb && p !== inst.sb);
      const seatOf = new Map<string, number>([
        [inst.sb, 1],
        [inst.bb, 2],
      ]);
      others.forEach((p, i) => seatOf.set(p, 3 + i));
      return inst.players.map((pid, i): LightningParticipant => {
        const p = this.players.get(pid)!;
        const seat = seatOf.get(pid)!;
        const position =
          n === 2
            ? seat === 1
              ? 'btn'
              : 'bb'
            : seat === 1
              ? 'sb'
              : seat === 2
                ? 'bb'
                : seat === n
                  ? 'btn'
                  : 'utg';
        return {
          playerId: pid,
          poolSessionId: p.poolSessionId,
          seat,
          position,
          blindRole: seat === 1 ? 'sb' : seat === 2 ? 'bb' : 'none',
          stackBefore: p.stack - this.exposureOf(p),
          username: `P${i}`,
          avatarUrl: '',
          equippedFrame: '',
          equippedAura: '',
          isHorse: p.isHorse,
        };
      });
    },
    loadHostRules: async (hostTableId) => {
      await this.latency();
      const c = [...this.clusters.values()].find((x) => x.frontTable === hostTableId);
      const bb = c?.bigBlind ?? 2;
      return {
        id: hostTableId,
        name: 'Load Cluster',
        small_blind: bb / 2,
        big_blind: bb,
        game_variant: 'nlh',
        max_players: 6,
        rake_percent: 5,
        rake_cap_bb: 3,
        action_time_seconds: 15,
        time_bank_enabled: true,
        time_bank_max_uses: 120,
        ante_enabled: false,
        ante: 0,
        is_anonymous: false,
        bbj_percent: 0,
      };
    },
    insertHoleCards: async () => {
      await this.latency();
    },
    keepalive: async () => ({ ok: true, value: null }),
    abandon: async (instanceId) => {
      const f = this.fault('abandon', { instanceId });
      await this.latency();
      if (f?.kind === 'transport_before')
        return { ok: false, reason: 'abandon_failed', transport: true };
      const inst = this.instances.get(instanceId);
      if (!inst) return { ok: false, reason: 'not_found' };
      if (inst.state === 'complete') return { ok: false, reason: 'complete' };
      this.abandonInstance(inst);
      return { ok: true, value: null };
    },
    fastFold: async (handId, playerId, requestId, foldType, committed) => {
      const inst = this.instances.get(this.instanceOfHand.get(handId) ?? '');
      const f = this.fault('fastFold', { handId, playerId, instanceId: inst?.id });
      await this.latency();
      if (f?.kind === 'transport_before')
        return { ok: false, reason: 'fold_failed', transport: true };
      const body = `${handId}/${playerId}/${foldType}/${cents(committed)}`;
      const prev = this.foldRecords.get(requestId);
      if (prev !== undefined) {
        if (prev !== body) this.violate(`fold_conflict:${requestId}`);
        return { ok: true, value: null };
      }
      if (!inst || inst.state !== 'dealing') return { ok: false, reason: 'hand_not_dealing' };
      this.foldRecords.set(requestId, body);
      this.counters.fastFolds++;
      const p = this.players.get(playerId)!;
      if (foldType === 'fast' || foldType === 'normal') {
        inst.released.add(playerId);
        p.exposure.set(inst.id, committed);
        if (p.instanceId === inst.id) {
          p.instanceId = null;
          p.idleSinceMs = Date.now();
        }
      }
      if (f?.kind === 'transport_after')
        return { ok: false, reason: 'fold_failed', transport: true };
      return { ok: true, value: null };
    },
    settle: async (a: LightningSettleArgs) => {
      this.counters.settleCalls++;
      const inst = this.instances.get(this.instanceOfHand.get(a.handId) ?? '');
      const f = this.fault('settle', { handId: a.handId, instanceId: inst?.id });
      await this.latency();
      if (f?.kind === 'transport_before')
        return { ok: false, reason: 'fn_lightning_settle_hand_failed', transport: true };
      if (f?.kind === 'hang') await sleep(f.ms ?? 1_000);
      const bodyHash = createHash('sha256')
        .update(
          JSON.stringify([
            a.handId,
            a.results.map((r) => [
              r.playerId,
              cents(r.contributed),
              cents(r.won),
              cents(r.stackAfter),
              r.foldType,
            ]),
            cents(a.rake),
            cents(a.bbj),
          ])
        )
        .digest('hex');
      const prev = this.settleRecords.get(a.handId);
      if (prev) {
        if (prev.requestId !== a.requestId) {
          this.violate(`second_settle_request:${a.handId}`);
          return { ok: false, reason: 'already_settled' };
        }
        if (prev.bodyHash !== bodyHash) {
          this.counters.idempotencyConflicts++;
          this.violate(`settle_idempotency_conflict:${a.handId}`);
          return { ok: false, reason: 'IDEMPOTENCY_CONFLICT' };
        }
        this.counters.settleReplays++;
        return { ok: true, value: { handHistoryId: prev.receipt, receiptHash: bodyHash } };
      }
      if (!inst) return { ok: false, reason: 'not_found' };
      if (inst.state === 'abandoned') return { ok: false, reason: 'instance_abandoned' };
      if (inst.state !== 'dealing') return { ok: false, reason: `instance_${inst.state}` };
      if (a.leaseGeneration !== this.lease.generation)
        return { ok: false, reason: 'lease_mismatch' };
      let net = 0;
      for (const r of a.results) net += cents(r.won) - cents(r.contributed);
      if (net + cents(a.rake) + cents(a.bbj) !== 0) {
        this.violate(`chips_not_conserved:${a.handId}`);
        this.clusters.get(inst.clusterId)!.mode = 'frozen';
        return { ok: false, reason: 'stack_invariant_failed', frozen: true };
      }
      for (const r of a.results) {
        const p = this.players.get(r.playerId)!;
        p.stack = Math.round((p.stack + r.won - r.contributed) * 100) / 100;
        p.exposure.delete(inst.id);
        if (p.instanceId === inst.id) {
          p.instanceId = null;
          p.idleSinceMs = Date.now();
        }
      }
      this.rake = Math.round((this.rake + a.rake) * 100) / 100;
      this.bbj = Math.round((this.bbj + a.bbj) * 100) / 100;
      inst.state = 'complete';
      this.openIds.delete(inst.id);
      const receipt = uidN(7777, this.settleRecords.size + 1);
      this.settleRecords.set(a.handId, { requestId: a.requestId, bodyHash, receipt });
      this.counters.settled++;
      if (f?.kind === 'transport_after')
        return { ok: false, reason: 'fn_lightning_settle_hand_failed', transport: true };
      return { ok: true, value: { handHistoryId: receipt, receiptHash: bodyHash } };
    },
    postCommit: async () => ({ ok: true }),
    timeBankAllowance: async () => new Map(),
    consumeTimeBank: async () => undefined,
  } satisfies LightningHandBackend;

  /** Settlement receipts recorded (one per settled hand, by construction of the check). */
  get settledHands(): number {
    return this.settleRecords.size;
  }
}

/** A hub that keeps counts, not frames (a thousand players would not fit). */
export class LoadHub implements LightningHub {
  publishes = 0;
  events = 0;
  privates = 0;
  /** Private frames that went to anyone but the room's owner (must be zero). */
  misdirected = 0;
  /** A public payload carrying a hole_cards frame or a `hole_cards` key (must be zero). */
  leaked = 0;
  private readonly lastHand = new Map<string, string | null>();
  onNewHand: ((room: string, handId: string) => void) | null = null;

  constructor(private readonly ownerOf: (room: string) => string | undefined) {}

  publish(room: string, payload: Record<string, unknown>): number {
    this.publishes++;
    const handId = typeof payload.hand_id === 'string' ? payload.hand_id : null;
    if (handId && this.lastHand.get(room) !== handId) {
      this.lastHand.set(room, handId);
      this.onNewHand?.(room, handId);
    } else if (!handId) {
      this.lastHand.set(room, null);
    }
    if (this.publishes % 97 === 0 && JSON.stringify(payload).includes('hole_cards')) this.leaked++;
    return 1;
  }
  emitEvent(): void {
    this.events++;
  }
  sendToUser(room: string, userId: string, payload: Record<string, unknown>): number {
    this.privates++;
    if (payload.kind === 'hole_cards' && this.ownerOf(room) !== userId) this.misdirected++;
    return 1;
  }
  get rooms(): number {
    return this.lastHand.size;
  }
}

/** Nearest-rank quantiles of a sample. */
export function quantiles(values: readonly number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
} {
  const s = [...values].sort((a, b) => a - b);
  const q = (x: number) =>
    s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.max(0, Math.ceil(x * s.length) - 1))];
  const r = (v: number) => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)) };
}

export type SettleOutcome = LightningCallOutcome<{
  handHistoryId: string;
  receiptHash: string | null;
}>;
