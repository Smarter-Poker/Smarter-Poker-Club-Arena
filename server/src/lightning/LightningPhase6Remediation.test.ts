/**
 * LIGHTNING PHASE 6, ENGINE REMEDIATION (2026-10-01): one test per review
 * finding - the jackpot, a frozen Cluster, the re-form loop, the folder's
 * room, the post-commit drain, two hands sharing a time bank, the horse lane,
 * ended rooms and a replayed pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning remediation fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning remediation fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String((e as Error)?.message ?? e),
}));
const alerts = vi.hoisted(() => ({ raised: [] as Array<{ source: string; details: any }> }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async (_sev: string, source: string, _msg: string, details: any) => {
    alerts.raised.push({ source, details });
  }),
}));
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { lightningRequestId, LightningTimeBankLedger } = await import('./LightningHandHost.js');
const { LightningHosting, LightningRegistry } = await import('./LightningRegistry.js');
const { LightningClusterWorker } = await import('./LightningClusterWorker.js');
const { LightningSupervisor } = await import('./LightningSupervisor.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const { detectLightningJackpot, settleLightningJackpot } = await import('./LightningJackpot.js');
const { LIGHTNING_HORSE_MAX_BANK_BURN_MS, lightningHorseThinkTimeMs } =
  await import('./LightningHorse.js');
const { HorseLogic } = await import('../engine/HorseLogic.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  alerts.raised = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const foldAll = (_u: string, legal: string[]) => (legal.includes('fold') ? 'fold' : null);

// ─── 1. THE BAD BEAT JACKPOT ─────────────────────────────────────────────────

const c = (rank: string, suit: string) => ({ rank, suit });
function qualifyingHand(overrides: Record<string, unknown> = {}) {
  // Board Kh Kd Ac Jd Js: W's KK is quad kings, L's AJ is aces full of jacks.
  return {
    hostTableId: kit.HOST_TABLE,
    clubId: uid(77),
    asset: 'chips',
    bbjPercent: 100,
    handNumber: 1_234_567,
    variant: 'nlh',
    smallBlind: 5,
    bigBlind: 10,
    showdown: [
      {
        userId: 'W',
        handRanking: 8,
        handName: 'Four of a Kind',
        kickers: [13, 14],
        holeCards: [c('K', 'spades'), c('K', 'clubs')],
      },
      {
        userId: 'L',
        handRanking: 7,
        handName: 'Full House',
        kickers: [14, 11],
        holeCards: [c('A', 'hearts'), c('J', 'hearts')],
      },
    ],
    winnerIds: ['W'],
    potSize: 500,
    dealtInPlayerIds: ['W', 'L', 'X'],
    board: ['Khearts', 'Kdiamonds', 'Aclubs', 'Jdiamonds', 'Jspades'],
    rooms: [
      ['W', uid(5001)],
      ['L', uid(5002)],
      ['X', uid(5003)],
    ] as Array<[string, string]>,
    stacks: [],
    ...overrides,
  };
}

describe('1. a Lightning bad beat pays the jackpot exactly as a physical table', () => {
  it('detects with the physical rule and pays through processBBJPayout, every share direct (nobody is seated at the host)', async () => {
    const emitted: Array<{ room: string; payload: any }> = [];
    const payMain = vi.fn(async () => ({
      status: 'paid' as const,
      result: {
        totalPayout: 100,
        loserShare: 50,
        winnerShare: 25,
        tableShare: 25,
        perPlayerShare: 25,
        poolId: 'p',
      },
    }));
    const payMini = vi.fn();
    const verdict = await settleLightningJackpot(qualifyingHand() as any, {
      emit: (room, payload) => emitted.push({ room, payload }),
      logger: quiet,
      payMain: payMain as any,
      payMini: payMini as any,
    });
    expect(verdict).toBe('main');
    expect(payMini).not.toHaveBeenCalled();
    expect(payMain).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: kit.HOST_TABLE,
        clubId: uid(77),
        handNumber: 1_234_567,
        loserUserId: 'L',
        winnerUserId: 'W',
        dealtInPlayerIds: ['W', 'L', 'X'],
        seatedUserIds: [],
      })
    );
    // The physical events, to every participant's own room.
    for (const room of [uid(5001), uid(5002), uid(5003)]) {
      const types = emitted.filter((e) => e.room === room).map((e) => e.payload.type);
      expect(types).toEqual(['bbj_hit', 'bbj_payout_complete']);
      expect(emitted.find((e) => e.room === room)!.payload.table_id).toBe(room);
    }
  });

  it('a boat over a boat is no jackpot; a zero bbj_percent or a diamond table pays nothing', async () => {
    const boat = qualifyingHand({
      showdown: [
        {
          userId: 'W',
          handRanking: 7,
          handName: 'Full House',
          kickers: [14, 13],
          holeCards: [c('A', 'spades'), c('K', 'spades')],
        },
        {
          userId: 'L',
          handRanking: 7,
          handName: 'Full House',
          kickers: [14, 11],
          holeCards: [c('A', 'hearts'), c('J', 'hearts')],
        },
      ],
    });
    expect(detectLightningJackpot(boat as any).verdict).not.toBe('main');
    expect(detectLightningJackpot(qualifyingHand({ bbjPercent: 0 }) as any).verdict).toBe('none');
    const payMain = vi.fn();
    await settleLightningJackpot(qualifyingHand({ asset: 'diamonds' }) as any, {
      emit: () => undefined,
      logger: quiet,
      payMain: payMain as any,
    });
    expect(payMain).not.toHaveBeenCalled();
  });

  it('the host runs the jackpot only after a settled hand, never after a refusal or an abandon', async () => {
    const settled = buildHost(formedHand(3, 8000), [100, 100, 100]);
    await settled.host.start();
    await playOut(settled.host, mulberry32(3));
    await flush();
    expect(settled.host.lifecycle).toBe('complete');
    // The fixture's payout doors: called only when a hand qualified, never otherwise.
    const refused = buildHost(formedHand(2, 8100), [100, 100], { settleScript: ['refuse'] });
    await refused.host.start();
    await playOut(refused.host, mulberry32(4), foldAll);
    await flush();
    expect(refused.host.lifecycle).toBe('abandoned');
    expect(refused.jackpot.payMain).not.toHaveBeenCalled();
    expect(refused.jackpot.payMini).not.toHaveBeenCalled();
    // And the host hands the jackpot every participant's room and the host table.
    const hand = (settled.host as any).jackpotHand(settled.host.peekState());
    expect(hand.hostTableId).toBe(kit.HOST_TABLE);
    expect(hand.rooms.map((r: [string, string]) => r[1]).sort()).toEqual(
      settled.participants.map((p) => p.poolSessionId).sort()
    );
  });
});

// ─── 2. A FROZEN CLUSTER ─────────────────────────────────────────────────────

describe('2. a frozen Cluster', () => {
  it('settle answering cluster_frozen abandons the instance (nothing moved) and stops the worker', async () => {
    const frozen = vi.fn();
    const t = buildHost(formedHand(2, 8200), [100, 100], {
      settleScript: ['cluster_frozen'],
      deps: { onClusterFrozen: frozen },
    });
    await t.host.start();
    await playOut(t.host, mulberry32(5), foldAll);
    await flush();
    expect(t.host.lifecycle).toBe('abandoned');
    expect(t.calls.settle).toHaveLength(1);
    expect(t.calls.abandon).toEqual(['cluster_frozen']);
    expect(t.calls.postCommit).toEqual([]);
    expect(frozen).toHaveBeenCalledWith(formedHand(2, 8200).clusterId);
  });

  it('the supervisor’s onFrozen also aborts the Cluster’s unsettled hands', () => {
    const src = readFileSync(join(__dirname, 'LightningSupervisor.ts'), 'utf8');
    const at = src.indexOf('const onFrozen = (id: string): void => {');
    const body = src.slice(at, src.indexOf('};', at));
    expect(body).toContain("hosting?.abortCluster(id, 'cluster_frozen')");
  });
});

// ─── 3. NO ZERO-DELAY RE-FORM LOOP ───────────────────────────────────────────

function hostingFixture(opts: Partial<Parameters<typeof buildHost>[2]> = {}) {
  const formed = formedHand(3, 8300);
  const fb = kit.fakeBackend(formed, [100, 100, 100], new Set(), opts);
  const registry = new LightningRegistry({
    viewAccess: async () => true,
    roomOwner: async () => null,
  });
  let leased = true;
  let nowMs = 1_000_000;
  const hosting = new LightningHosting({
    registry,
    backend: fb.backend,
    hub: new kit.RecordingHub(),
    leaseFor: () => (leased ? { instance: 'i', generation: uid(4242) } : null),
    metrics: new LightningMetrics(new MetricsRegistry()),
    hostOptions: { sleep: () => Promise.resolve(), now: () => nowMs, logger: quiet },
  });
  const cfg = { keepaliveIntervalMs: 5_000, dealWindowMs: 600_000 } as any;
  return {
    formed,
    fb,
    registry,
    hosting,
    cfg,
    setLease: (v: boolean) => (leased = v),
    advance: (ms: number) => (nowMs += ms),
    now: () => nowMs,
  };
}

describe('3. an abandon never wakes the worker, and repeated abandons back the Cluster off', () => {
  it('abandon: no wake, backoff doubles; a settled hand wakes and clears it', async () => {
    const f = hostingFixture({
      participantsOverride: (ps) => ps.map((p) => ({ ...p, position: 'utg' })),
    });
    const wake = vi.fn();
    const a = f.hosting.startHand(f.formed, f.cfg, wake);
    await a.whenFinished();
    expect(a.lifecycle).toBe('abandoned');
    expect(wake).not.toHaveBeenCalled();
    const first = f.hosting.formBackoffUntil(f.formed.clusterId) - f.now();
    expect(first).toBeGreaterThan(0);
    const b = f.hosting.startHand({ ...f.formed, instanceId: uid(8399) }, f.cfg, wake);
    await b.whenFinished();
    expect(f.hosting.formBackoffUntil(f.formed.clusterId) - f.now()).toBe(first * 2);
    expect(wake).not.toHaveBeenCalled();

    const ok = hostingFixture();
    const wake2 = vi.fn();
    (ok.hosting as any).abandonBackoff.set(ok.formed.clusterId, {
      count: 3,
      until: ok.now() + 4000,
    });
    const h = ok.hosting.startHand(ok.formed, ok.cfg, wake2);
    await flush();
    await playOut(h, mulberry32(9), (_u, legal) => (legal.includes('check') ? 'check' : 'call'));
    await h.whenFinished();
    expect(h.lifecycle).toBe('complete');
    expect(wake2).toHaveBeenCalled();
    expect(ok.hosting.formBackoffUntil(ok.formed.clusterId)).toBe(0);
  });

  it('a folded player wakes the worker while the hand plays on', async () => {
    const f = hostingFixture();
    const wake = vi.fn();
    const h = f.hosting.startHand(f.formed, f.cfg, wake);
    await flush();
    const st = h.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    expect(h.handlePlayerAction(current.user_id, 'fold').success).toBe(true);
    await flush();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(h.lifecycle).toBe('dealing');
  });

  function worker(deps: Record<string, unknown>) {
    const rpc = vi.fn(async () => ({ data: { ok: true, hands: [] }, error: null }));
    const w = new LightningClusterWorker(
      uid(1),
      {
        workerMode: 'form',
        passIntervalMs: 1000,
        keepaliveIntervalMs: 5000,
        maxHandsPerPass: 4,
        matcherVersion: 1,
      } as any,
      {
        rpc,
        presence: new LightningPresence(() => []),
        logger: quiet,
        metrics: new LightningMetrics(new MetricsRegistry()),
        startHand: vi.fn(),
        now: () => new Date(2_000_000),
        ...deps,
      } as any
    );
    return { w, rpc };
  }

  it('formPass refuses during the backoff and without the front table lease, calling nothing', async () => {
    const backedOff = worker({ formBackoffUntil: () => 2_000_500 });
    expect(await backedOff.w.pass()).toMatchObject({
      outcome: 'skipped',
      reason: 'abandon_backoff',
    });
    expect(backedOff.rpc).not.toHaveBeenCalled();
    const noLease = worker({ holdsFrontTableLease: async () => false });
    expect(await noLease.w.pass()).toMatchObject({
      outcome: 'skipped',
      reason: 'front_table_lease_not_held',
    });
    expect(noLease.rpc).not.toHaveBeenCalled();
    const leased = worker({ holdsFrontTableLease: async () => true, formBackoffUntil: () => 0 });
    await leased.w.pass();
    expect(leased.rpc).toHaveBeenCalledTimes(1);
  });

  it('the supervisor asks the front table once per TTL and checks this process’s lease on it', async () => {
    const front = uid(9000);
    const frontTable = vi.fn(async () => front);
    const leaseFor = vi.fn((t: string) =>
      t === front ? { instance: 'i', generation: 'g' } : null
    );
    const hosting = { leaseFor, hasInstance: () => false, formBackoffUntil: () => 0 } as any;
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      hosting,
      frontTable,
      logger: quiet,
    });
    const w = (sup as any).createWorker(uid(1), { workerMode: 'form', passIntervalMs: 1000 });
    expect(await w.deps.holdsFrontTableLease()).toBe(true);
    expect(await w.deps.holdsFrontTableLease()).toBe(true);
    expect(frontTable).toHaveBeenCalledTimes(1);
    expect(leaseFor).toHaveBeenCalledWith(front);
  });
});

// ─── 4. THE FOLDER'S ROOM GETS THE IDLE SHAPE ────────────────────────────────

describe('4. a room this hand stops publishing to is told the felt is empty', () => {
  it('a fast fold publishes the idle shape to the folder’s room before it is dropped', async () => {
    const t = buildHost(formedHand(4, 8400), [200, 200, 200, 200]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const room = t.host.roomOf(current.user_id)!;
    expect(t.host.handlePlayerAction(current.user_id, 'fast_fold').success).toBe(true);
    await flush();
    const last = t.hub
      .inRoom(room)
      .filter((f) => f.kind === 'publish')
      .at(-1)!.payload;
    expect(last).toMatchObject({ stage: 'waiting', players: [], hand_id: null, table_id: room });
    expect(last.lightning).toMatchObject({ fast_fold_available: false, hand_id: null });
  });

  it('an abandon after the deal started (hole cards could not be written) idles every room', async () => {
    const t = buildHost(formedHand(3, 8500), [100, 100, 100]);
    (t.backend.insertHoleCards as any).mockImplementation(async () => {
      throw new Error('insert_hole_cards failed');
    });
    await t.host.start();
    expect(t.host.lifecycle).toBe('abandoned');
    for (const p of t.participants) {
      const last = t.hub
        .inRoom(p.poolSessionId)
        .filter((f) => f.kind === 'publish')
        .at(-1)!;
      expect(last.payload).toMatchObject({ stage: 'waiting', players: [], hand_id: null });
    }
  });
});

// ─── 6. THE POST-COMMIT DRAIN ────────────────────────────────────────────────

describe('6. post-commit obligations: ok !== true is a failure, retried, bounded, alerted', () => {
  it('predecessor_pending is retried until it completes; no alert', async () => {
    const t = buildHost(formedHand(2, 8600), [100, 100], {
      postCommitScript: ['predecessor_pending', 'predecessor_pending', 'ok'],
    });
    await t.host.start();
    await playOut(t.host, mulberry32(6), foldAll);
    await flush(40);
    expect(t.host.lifecycle).toBe('complete');
    expect(t.calls.postCommit).toHaveLength(3);
    expect(alerts.raised).toEqual([]);
  });

  it('a drain that never completes gives up at its budget and files the critical alert once', async () => {
    let nowMs = 5_000_000;
    const t = buildHost(formedHand(2, 8700), [100, 100], {
      postCommitScript: ['predecessor_pending'],
      deps: {
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
        postCommitBudgetMs: 10_000,
      },
    });
    await t.host.start();
    await playOut(t.host, mulberry32(7), foldAll);
    await flush(60);
    expect(t.host.lifecycle).toBe('complete');
    const n = t.calls.postCommit.length;
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(20);
    expect(alerts.raised).toHaveLength(1);
    expect(alerts.raised[0]).toMatchObject({
      source: 'LightningHandHost.post_commit_obligations_pending',
      details: { table_id: kit.HOST_TABLE, attempts: n, hand_id: uid(7777) },
    });
  });
});

// ─── 7. TWO HANDS, ONE TIME BANK ─────────────────────────────────────────────

describe('7. the time bank across concurrent hands and restarts', () => {
  function ledgerBackend(extra = 60, durable?: Map<string, any>) {
    const consumed: Array<{ userId: string; seconds: number; requestId: string }> = [];
    let failures = 0;
    const backend = {
      timeBankAllowance: vi.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, { extraSeconds: extra, unlimitedActivations: false }]))
      ),
      consumeTimeBank: vi.fn(async (userId: string, seconds: number, requestId: string) => {
        if (failures-- > 0) throw new Error('timeout');
        consumed.push({ userId, seconds, requestId });
      }),
      durableTimeBanks: vi.fn(async () => durable ?? new Map()),
    };
    return { backend, consumed, failWith: (n: number) => (failures = n) };
  }
  const P = uid(42);

  it('keeps the minimum remaining, and debits paid seconds once per (hand, player) under a deterministic id', async () => {
    const b = ledgerBackend(60);
    const ledger = new LightningTimeBankLedger(
      b.backend as any,
      uid(1),
      () => Promise.resolve(),
      quiet
    );
    await ledger.ensure([P]);
    // Hand A leaves 30 of 100 (30 paid seconds); hand B, dealt from the same bank, reports 90.
    await ledger.record(P, 30, 2, uid(1001));
    await ledger.record(P, 90, 5, uid(1002));
    expect(ledger.get(P)!.remainingSeconds).toBe(30);
    expect(b.consumed).toEqual([
      { userId: P, seconds: 30, requestId: lightningRequestId(uid(1001), `tb/${P}`) },
    ]);
  });

  it('an unanswered debit is retried under the same id, and owed again if it never answers', async () => {
    const b = ledgerBackend(60);
    const ledger = new LightningTimeBankLedger(
      b.backend as any,
      uid(1),
      () => Promise.resolve(),
      quiet
    );
    await ledger.ensure([P]);
    b.failWith(1);
    await ledger.record(P, 50, 3, uid(2001));
    expect(b.backend.consumeTimeBank).toHaveBeenCalledTimes(2);
    expect(new Set(b.backend.consumeTimeBank.mock.calls.map((c) => c[2])).size).toBe(1);
    expect(b.consumed).toEqual([
      { userId: P, seconds: 10, requestId: lightningRequestId(uid(2001), `tb/${P}`) },
    ]);
    b.failWith(3);
    await ledger.record(P, 40, 2, uid(2002));
    expect(b.consumed).toHaveLength(1);
    await ledger.record(P, 40, 2, uid(2003));
    expect(b.consumed.at(-1)).toEqual({
      userId: P,
      seconds: 10,
      requestId: lightningRequestId(uid(2003), `tb/${P}`),
    });
  });

  it('a restarted worker seeds from the durable bank instead of refilling', async () => {
    // Before the restart the player had spent into the paid seconds: the
    // allowance is already net of that debit (12 left) and the seat says 12.
    const b = ledgerBackend(12, new Map([[P, { remainingSeconds: 12, usesRemaining: 1 }]]));
    const ledger = new LightningTimeBankLedger(
      b.backend as any,
      uid(1),
      () => Promise.resolve(),
      quiet
    );
    await ledger.ensure([P]);
    expect(b.backend.durableTimeBanks).toHaveBeenCalledWith(uid(1), [P]);
    expect(ledger.get(P)).toMatchObject({
      remainingSeconds: 12,
      usesRemaining: 1,
      initialSeconds: 52,
    });
    // Nothing more spent: nothing is debited again for what was spent before the restart.
    await ledger.record(P, 12, 1, uid(3001));
    expect(b.consumed).toEqual([]);
    // Two more seconds spent: exactly two are debited.
    await ledger.record(P, 10, 1, uid(3002));
    expect(b.consumed).toEqual([
      { userId: P, seconds: 2, requestId: lightningRequestId(uid(3002), `tb/${P}`) },
    ]);
  });

  it('a folder’s bank is recorded at the fold, and once', async () => {
    const t = buildHost(formedHand(3, 8800), [100, 100, 100]);
    const record = vi.spyOn((t.host as any).deps.timeBanks, 'record');
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    t.host.handlePlayerAction(current.user_id, 'fold');
    await flush();
    expect(record.mock.calls.filter((c) => c[0] === current.user_id)).toHaveLength(1);
    await playOut(t.host, mulberry32(8), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(record.mock.calls.filter((c) => c[0] === current.user_id)).toHaveLength(1);
    expect(record.mock.calls).toHaveLength(3);
    expect(record.mock.calls.every((c) => c[3] === formedHand(3, 8800).handId)).toBe(true);
  });
});

// ─── 8. HORSES DECIDE IN THE LIVE LANE ───────────────────────────────────────

describe('8. a Lightning horse decides in the physical tables’ lane, as itself', () => {
  it('the lane gets the horse’s own style and mods, its own cards, and nobody else’s', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(3, 8900);
    const horses = new Set(formed.players);
    const t = buildHost(formed, [100, 100, 100], {
      horses,
      participantsOverride: (ps) =>
        ps.map((p) => ({
          ...p,
          horseProfile: { style: 'maniac', aggression: 1.2, tightness: 0.9 },
        })),
    });
    await t.host.start();
    for (let i = 0; i < 80 && t.host.lifecycle === 'dealing'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush(4);
    }
    expect(t.host.lifecycle).toBe('complete');
    expect(t.horseLane.calls.length).toBeGreaterThan(0);
    for (const snap of t.horseLane.calls) {
      expect(snap.style).toBe('lag');
      expect(snap.mods).toMatchObject({ aggression: 1.2, tightness: 0.9 });
      expect(snap.player.cards.length).toBe(2);
      for (const p of snap.gameState.players as any[]) expect(p.cards).toEqual([]);
      expect(snap.decisionKey).toBeTruthy();
    }
    // Every horse action came through the policy door, never a timeout.
    const origins = ((t.host as any).actions as any[]).filter(
      (a) => a.origin && a.origin !== 'forced'
    );
    expect(origins.every((a) => a.origin === 'horse_policy')).toBe(true);
  });

  it('a lane that fails gives the liveness answer through the same door, never a brain on the main loop', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(2, 9000);
    const failing = kit.fakeHorseLane({ fail: true });
    const decide = vi.spyOn(HorseLogic, 'decide');
    const t = buildHost(formed, [100, 100], {
      horses: new Set(formed.players),
      deps: { horseLane: () => failing.lane },
    });
    await t.host.start();
    for (let i = 0; i < 30 && t.host.lifecycle === 'dealing'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush(4);
    }
    expect(t.host.lifecycle).toBe('complete');
    expect(decide).not.toHaveBeenCalled();
    const origins = ((t.host as any).actions as any[]).filter(
      (a) => a.origin && a.origin !== 'forced'
    );
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every((a) => a.origin === 'horse_fallback')).toBe(true);
    decide.mockRestore();
  });

  it('the think time maps exactly as the physical engine, and the bank-burn ceiling is the physical one', () => {
    const turns = readFileSync(join(__dirname, '../engine/ServerTableEngineTurns.ts'), 'utf8');
    expect(Number(turns.match(/HORSE_MAX_BANK_BURN_MS\s*=\s*(\d+)/)![1])).toBe(
      LIGHTNING_HORSE_MAX_BANK_BURN_MS
    );
    const S = HorseLogic.THINK_TIMEBANK_SENTINEL;
    expect(
      lightningHorseThinkTimeMs({
        requested: 3000,
        actionTimeMs: 15000,
        workerFallback: false,
        bankUsable: false,
      })
    ).toBe(3000);
    expect(
      lightningHorseThinkTimeMs({
        requested: 3000,
        actionTimeMs: 15000,
        workerFallback: true,
        bankUsable: true,
      })
    ).toBe(0);
    expect(
      lightningHorseThinkTimeMs({
        requested: S,
        actionTimeMs: 15000,
        workerFallback: false,
        bankUsable: false,
      })
    ).toBe(13500);
    expect(
      lightningHorseThinkTimeMs({
        requested: S,
        actionTimeMs: 15000,
        workerFallback: false,
        bankUsable: true,
      })
    ).toBe(17000);
    expect(
      lightningHorseThinkTimeMs({
        requested: S + 100_000,
        actionTimeMs: 15000,
        workerFallback: false,
        bankUsable: true,
      })
    ).toBe(24000);
  });
});

// ─── 9. ENDED ROOMS ARE CLOSED ───────────────────────────────────────────────

describe('9. a room whose pool session ended has its sockets closed', () => {
  it('the sweep closes a socketed room with no hand once view access says no, and only then', async () => {
    let allowed = true;
    const closed: string[] = [];
    const registry = new LightningRegistry({
      viewAccess: async () => allowed,
      roomOwner: async () => null,
      closeRoom: (room) => closed.push(room),
    });
    const room = uid(6001);
    const user = uid(6002);
    await registry.authorize(room, user);
    registry.connect(room, user);
    expect(await registry.sweepEndedRooms()).toBe(0);
    allowed = false;
    expect(await registry.sweepEndedRooms()).toBe(1);
    expect(closed).toEqual([room]);
    expect(registry.isRoom(room)).toBe(false);
  });

  it('a check that cannot run closes nothing', async () => {
    const closed: string[] = [];
    let fail = false;
    const registry = new LightningRegistry({
      viewAccess: async () => {
        if (fail) throw new Error('down');
        return true;
      },
      roomOwner: async () => null,
      closeRoom: (room) => closed.push(room),
    });
    await registry.authorize(uid(6101), uid(6102));
    registry.connect(uid(6101), uid(6102));
    fail = true;
    expect(await registry.sweepEndedRooms()).toBe(0);
    expect(closed).toEqual([]);
  });

  it('unregister checks a participant room that is not moving to a new hand', async () => {
    const closed: string[] = [];
    const registry = new LightningRegistry({
      viewAccess: async () => false,
      roomOwner: async () => null,
      closeRoom: (room) => closed.push(room),
    });
    const t = buildHost(formedHand(2, 9100), [100, 100], {
      deps: { onDealing: (h) => registry.register(h) },
    });
    await t.host.start();
    const room = t.participants[0].poolSessionId;
    registry.connect(room, t.participants[0].playerId);
    registry.unregister(t.host);
    await flush();
    expect(closed).toEqual([room]);
  });

  it('the supervisor sweeps on its own interval while it runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const sweepRooms = vi.fn(async () => 0);
    const sup = new LightningSupervisor({
      presenceSource: () => [],
      discover: async () => [],
      sweepRooms,
      frozen: () => false,
      logger: quiet,
    });
    sup.start();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(sweepRooms).toHaveBeenCalledTimes(2);
    await sup.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweepRooms).toHaveBeenCalledTimes(2);
  });
});

// ─── 10. A REPLAYED PASS CANNOT START A SECOND HOST ──────────────────────────

describe('10. hasInstance sees a host that is still starting', () => {
  it('a pending (not yet registered) host answers true', async () => {
    const f = hostingFixture();
    let release!: () => void;
    (f.fb.backend.beginDealing as any).mockImplementation(
      () =>
        new Promise((r) => (release = () => r({ ok: true, value: { handId: f.formed.handId } })))
    );
    const h = f.hosting.startHand(f.formed, f.cfg, () => undefined);
    expect(f.registry.hasInstance(f.formed.instanceId)).toBe(false);
    expect(f.hosting.hasInstance(f.formed.instanceId)).toBe(true);
    release();
    await flush();
    await h.abort('test_over');
    await h.whenFinished();
    await flush();
    expect(f.hosting.hasInstance(f.formed.instanceId)).toBe(false);
  });
});
