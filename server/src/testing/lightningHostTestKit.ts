/**
 * An in-memory Lightning backend and hub for the hand-host tests and the
 * Lightning card/money law. No database: every call is recorded, and the
 * settlement can be told to fail as a transport (outcome unknown) or refuse.
 */
import { vi } from 'vitest';
import type {
  LightningCallOutcome,
  LightningHandBackend,
  LightningParticipant,
  LightningSettleArgs,
} from '../lightning/LightningHandBackend.js';
import {
  LightningHandHost,
  LightningTimeBankLedger,
  type LightningFormedHand,
  type LightningHandHostDeps,
  type LightningLease,
} from '../lightning/LightningHandHost.js';
import { LightningMetrics } from '../lightning/LightningMetrics.js';
import { MetricsRegistry } from '../observability/Metrics.js';
import { HorseLogic } from '../engine/HorseLogic.js';
import type {
  FastHorseDecisionResult,
  LiveHorseDecisionLane,
  LiveHorseDecisionSnapshot,
} from '../engine/horseDecision/index.js';

/**
 * A stand-in for the live horse decision lane: it answers with the brain the
 * worker runs (HorseLogic.decide) on the snapshot it was sent, so a test sees
 * exactly what the host asked for (`calls`) and a real decision back.
 */
export function fakeHorseLane(opts: { fail?: boolean } = {}) {
  const calls: LiveHorseDecisionSnapshot[] = [];
  const committed: FastHorseDecisionResult[] = [];
  const lane = {
    decideFast: vi.fn(async (snap: LiveHorseDecisionSnapshot): Promise<FastHorseDecisionResult> => {
      calls.push(snap);
      if (opts.fail) throw new Error('worker down');
      const decision = HorseLogic.decide(snap.player, snap.gameState, snap.style, snap.mods ?? {}, {
        mind: false,
        telemetry: false,
      } as never);
      return {
        type: 'FAST_RESULT',
        requestId: calls.length,
        planBinding: null,
        planIssueDisposition: 'no_effects',
        generation: snap.generation,
        fence: snap.fence,
        decision,
        rngBefore: 0,
        rngAfter: 0,
        computeMs: 1,
        governorScale: 1,
        effects: [],
      } as unknown as FastHorseDecisionResult;
    }),
    commitDecisionEffects: vi.fn(async (r: FastHorseDecisionResult) => {
      committed.push(r);
      return { ok: true } as never;
    }),
  };
  return { lane: lane as unknown as LiveHorseDecisionLane, calls, committed, raw: lane };
}

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const HOST_TABLE = uid(9000);

export interface Frame {
  kind: 'publish' | 'event' | 'private';
  room: string;
  userId?: string;
  payload: Record<string, any>;
}

export class RecordingHub {
  frames: Frame[] = [];
  publish(room: string, payload: Record<string, unknown>) {
    this.frames.push({ kind: 'publish', room, payload: structuredClone(payload) as any });
    return 1;
  }
  emitEvent(room: string, payload: Record<string, unknown>) {
    this.frames.push({ kind: 'event', room, payload: structuredClone(payload) as any });
  }
  sendToUser(room: string, userId: string, payload: Record<string, unknown>) {
    this.frames.push({ kind: 'private', room, userId, payload: structuredClone(payload) as any });
    return 1;
  }
  inRoom(room: string) {
    return this.frames.filter((f) => f.room === room);
  }
}

export interface FakeBackendOptions {
  /** Settlement answers: 'ok', 'transport' (unknown) or 'refuse', in order. */
  settleScript?: Array<'ok' | 'transport' | 'refuse' | 'frozen' | 'cluster_frozen'>;
  rules?: Record<string, unknown>;
  participantsOverride?: (p: LightningParticipant[]) => LightningParticipant[];
  /** Post-commit answers, in order (the last repeats): ok, or a refusal reason. */
  postCommitScript?: Array<'ok' | string>;
}

export function fakeBackend(
  formed: LightningFormedHand,
  stacks: number[],
  horses: Set<string>,
  opts: FakeBackendOptions = {}
) {
  const n = formed.players.length;
  // The barrier's seat map: seat 1 small blind, seat 2 big blind, 3.. in the
  // matcher order, the button last (heads-up: seat 1 is the button).
  const others = formed.players.filter((p) => p !== formed.bb && p !== formed.sb);
  const seatOf = new Map<string, number>([
    [formed.sb, 1],
    [formed.bb, 2],
  ]);
  others.forEach((p, i) => seatOf.set(p, 3 + i));
  let participants: LightningParticipant[] = formed.players.map((p, i) => {
    const seat = seatOf.get(p)!;
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
      playerId: p,
      poolSessionId: uid(5000 + i),
      seat,
      position,
      blindRole: seat === 1 ? 'sb' : seat === 2 ? 'bb' : 'none',
      stackBefore: stacks[i],
      username: `P${i}`,
      avatarUrl: '',
      equippedFrame: '',
      equippedAura: '',
      isHorse: horses.has(p),
    };
  });
  if (opts.participantsOverride) participants = opts.participantsOverride(participants);
  const script = [...(opts.settleScript ?? ['ok'])];
  const postScript = [...(opts.postCommitScript ?? ['ok'])];
  const calls = {
    settle: [] as LightningSettleArgs[],
    fastFold: [] as Array<{
      playerId: string;
      requestId: string;
      foldType: string;
      committed: number;
    }>,
    abandon: [] as string[],
    keepalive: 0,
    postCommit: [] as string[],
    insertHoleCards: [] as Array<{ table: string; hand: number; rows: unknown[] }>,
    consumed: [] as Array<{ userId: string; seconds: number; requestId: string }>,
  };
  let handNumber = 1_000_000 + Math.floor(Math.random() * 1000);
  const backend: LightningHandBackend = {
    beginDealing: vi.fn(async () => ({ ok: true as const, value: { handId: formed.handId } })),
    nextHandNumber: vi.fn(async () => ++handNumber),
    bindHandNumber: vi.fn(async (_i: string, hn: number) => ({
      ok: true as const,
      value: { handId: formed.handId, handNumber: hn, hostTableId: HOST_TABLE },
    })),
    loadParticipants: vi.fn(async () => participants.map((p) => ({ ...p }))),
    loadHostRules: vi.fn(async () => ({
      id: HOST_TABLE,
      small_blind: 1,
      big_blind: 2,
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
      ...(opts.rules ?? {}),
    })),
    insertHoleCards: vi.fn(async (table: string, hand: number, rows: unknown[]) => {
      calls.insertHoleCards.push({ table, hand, rows });
    }),
    keepalive: vi.fn(async () => {
      calls.keepalive++;
      return { ok: true as const, value: null };
    }),
    abandon: vi.fn(async (_i: string, reason: string) => {
      calls.abandon.push(reason);
      return { ok: true as const, value: null };
    }),
    fastFold: vi.fn(
      async (
        _h: string,
        playerId: string,
        requestId: string,
        foldType: string,
        committed: number
      ) => {
        calls.fastFold.push({ playerId, requestId, foldType, committed });
        return { ok: true as const, value: null };
      }
    ),
    settle: vi.fn(
      async (
        a: LightningSettleArgs
      ): Promise<LightningCallOutcome<{ handHistoryId: string; receiptHash: string | null }>> => {
        calls.settle.push(structuredClone(a));
        const next = script.length > 1 ? script.shift()! : script[0];
        if (next === 'transport')
          return { ok: false, reason: 'fn_lightning_settle_hand_failed', transport: true };
        if (next === 'refuse') return { ok: false, reason: 'lease_mismatch' };
        if (next === 'frozen') return { ok: false, reason: 'stack_invariant_failed', frozen: true };
        if (next === 'cluster_frozen') return { ok: false, reason: 'cluster_frozen' };
        return { ok: true, value: { handHistoryId: uid(7777), receiptHash: 'r' } };
      }
    ),
    postCommit: vi.fn(async (id: string) => {
      calls.postCommit.push(id);
      const next = postScript.length > 1 ? postScript.shift()! : postScript[0];
      return next === 'ok' ? { ok: true } : { ok: false, reason: next };
    }),
    timeBankAllowance: vi.fn(async () => new Map()),
    consumeTimeBank: vi.fn(async (userId: string, seconds: number, requestId: string) => {
      calls.consumed.push({ userId, seconds, requestId });
    }),
  };
  return { backend, participants, calls };
}

export function formedHand(n: number, base = 100): LightningFormedHand {
  const players = Array.from({ length: n }, (_, i) => uid(base + i));
  // matcher order: bb, sb, then the rest, button last
  return {
    clusterId: uid(1),
    instanceId: uid(base + 50),
    handId: uid(base + 60),
    bb: players[0],
    sb: players[1],
    btn: n === 2 ? players[1] : players[n - 1],
    players,
    formedAtMs: Date.now(),
  };
}

export function buildHost(
  formed: LightningFormedHand,
  stacks: number[],
  opts: FakeBackendOptions & {
    horses?: Set<string>;
    lease?: () => LightningLease | null;
    deps?: Partial<LightningHandHostDeps>;
  } = {}
) {
  const hub = new RecordingHub();
  const fb = fakeBackend(formed, stacks, opts.horses ?? new Set(), opts);
  const released: Array<{ playerId: string; why: string }> = [];
  const metrics = new LightningMetrics(new MetricsRegistry());
  const horseLane = fakeHorseLane();
  const jackpot = {
    payMain: vi.fn(async () => ({ status: 'nothing_to_pay' as const, reason: 'fixture' })),
    payMini: vi.fn(async () => ({ status: 'skipped' as const, reason: 'fixture' })),
  };
  const host = new LightningHandHost(formed, {
    backend: fb.backend,
    hub,
    leaseFor: opts.lease ?? (() => ({ instance: 'test-instance', generation: uid(4242) })),
    keepaliveIntervalMs: 5_000,
    dealWindowMs: 600_000,
    timeBanks: new LightningTimeBankLedger(fb.backend),
    metrics,
    sleep: () => Promise.resolve(),
    isConnected: () => true,
    onPlayerReleased: (playerId, why) => released.push({ playerId, why }),
    horseLane: () => horseLane.lane,
    jackpot: jackpot as never,
    ...(opts.deps ?? {}),
  });
  return { host, hub, released, metrics, horseLane, jackpot, ...fb };
}

/** Let promise chains settle without advancing any fake clock. */
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Play the hand to the end: the current player takes a seeded legal action. */
export async function playOut(
  host: LightningHandHost,
  rnd: () => number,
  pick?: (userId: string, legal: string[]) => string | null
): Promise<void> {
  for (let step = 0; step < 400; step++) {
    await flush(4);
    if (host.lifecycle !== 'dealing') return;
    const st = host.peekState();
    if (
      !st ||
      st.currentPlayerSeat < 1 ||
      !['preflop', 'flop', 'turn', 'river'].includes(st.stage)
    ) {
      await flush(4);
      continue;
    }
    const p = st.players.find((x) => x.seat === st.currentPlayerSeat)!;
    const legal = (host as any).hc.getAuthoritativeActionState(p.user_id)?.legalActions ?? [];
    if (legal.length === 0) continue;
    let a = pick?.(p.user_id, legal) ?? null;
    if (!a) {
      const w = legal.flatMap((x: string) =>
        x === 'fold' ? [x] : x === 'raise' || x === 'bet' ? [x] : [x, x, x]
      );
      a = w[Math.floor(rnd() * w.length)];
    }
    const amount = a === 'bet' || a === 'raise' ? undefined : undefined;
    const r = host.handlePlayerAction(
      p.user_id,
      a === 'bet' || a === 'raise' ? 'all_in' : a!,
      amount
    );
    if (!r.success) host.handlePlayerAction(p.user_id, legal.includes('check') ? 'check' : 'fold');
  }
}
