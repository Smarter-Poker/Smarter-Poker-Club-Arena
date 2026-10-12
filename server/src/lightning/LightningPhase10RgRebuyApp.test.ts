/**
 * LIGHTNING PHASE 10 (engine): responsible gaming, auto-rebuy and the
 * hidden-information review (spec Phases 16 and 17, app side).
 *
 *   - AUTO-REBUY runs between hands only: the host reports the settled
 *     boundary (after fn_lightning_settle_hand answered ok, before anyone is
 *     handed back to the matcher), and the executor makes at most ONE
 *     fn_lightning_auto_rebuy call per player per boundary. Config off is
 *     silence; a missing function is ten minutes of quiet (deploy window);
 *     a refusal or an error is terminal for that boundary - no retry storm.
 *   - STOP PLAYING is the database's: the matcher simply stops naming the
 *     player in formed hands, and the engine deals ONLY what the matcher
 *     formed. There is no engine-side RG filter to get wrong.
 *   - HIDDEN INFORMATION: every socket frame type a simulated hand emits is
 *     walked; before the showdown frame no room sees any other player's hole
 *     cards at all, afterwards only the tabled (non-mucked) ones; the host's
 *     log lines never carry a card; the settle row's players carry none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning Phase 10 fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning Phase 10 fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (e: unknown) => String(e),
}));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const {
  LightningAutoRebuyExecutor,
  LIGHTNING_AUTO_REBUY_RETRY_MS,
  lightningAutoRebuyTriggerStack,
} = await import('./LightningAutoRebuy.js');
const { LIGHTNING_AUTO_REBUY_DEFAULTS, parseLightningAutoRebuyConfig, parseLightningConfig } =
  await import('./LightningConfig.js');
const { LightningClusterWorker } = await import('./LightningClusterWorker.js');
const { LightningPresence } = await import('./LightningPresence.js');
const { LightningMetrics } = await import('./LightningMetrics.js');
const { MetricsRegistry } = await import('../observability/Metrics.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

const CLUSTER = uid(1);
const HAND = uid(77);
const P1 = uid(11);
const P2 = uid(12);
const P3 = uid(13);

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

const ON = {
  ...LIGHTNING_AUTO_REBUY_DEFAULTS,
  enabled: true,
  trigger: 'below_bb' as const,
  thresholdBb: 20,
};

function executor(opts: {
  answer?: (args: Record<string, unknown>) => { data: unknown; error: unknown };
  now?: () => number;
  logger?: typeof quiet;
}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push([fn, args]);
    return opts.answer ? opts.answer(args) : { data: { ok: true }, error: null };
  };
  const x = new LightningAutoRebuyExecutor({ rpc, logger: opts.logger ?? quiet, now: opts.now });
  return { x, calls };
}

// ─── 1. The config keys and the trigger ────────────────────────────────────

describe('the auto-rebuy config (fn_lightning_config keys)', () => {
  it('parses the keys, defaults to off, and fails closed on nonsense', () => {
    expect(parseLightningAutoRebuyConfig(null)).toEqual(LIGHTNING_AUTO_REBUY_DEFAULTS);
    expect(parseLightningAutoRebuyConfig({})).toEqual(LIGHTNING_AUTO_REBUY_DEFAULTS);
    const full = parseLightningAutoRebuyConfig({
      auto_rebuy_enabled: true,
      auto_rebuy_trigger: ' BELOW_PCT ',
      auto_rebuy_threshold_bb: '25',
      auto_rebuy_threshold_pct: 40,
      auto_rebuy_target: 'max',
      auto_rebuy_max_count: 3,
      auto_rebuy_session_cap: 500,
    });
    expect(full).toEqual({
      enabled: true,
      trigger: 'below_pct',
      thresholdBb: 25,
      thresholdPct: 40,
      target: 'max',
      maxCount: 3,
      sessionCap: 500,
    });
    // 'yes' is not true; a zero or negative threshold is no threshold; an
    // unknown trigger or target falls to the narrowest ('zero', 'initial').
    expect(parseLightningAutoRebuyConfig({ auto_rebuy_enabled: 'yes' }).enabled).toBe(false);
    expect(parseLightningAutoRebuyConfig({ auto_rebuy_threshold_bb: 0 }).thresholdBb).toBeNull();
    expect(parseLightningAutoRebuyConfig({ auto_rebuy_trigger: 'turbo' }).trigger).toBe('zero');
    expect(parseLightningAutoRebuyConfig({ auto_rebuy_target: 7 }).target).toBe('initial');
    // The worker's parse carries it, so every formed hand knows its rules.
    expect(parseLightningConfig({ auto_rebuy_enabled: true }).autoRebuy.enabled).toBe(true);
    expect(parseLightningConfig(null).autoRebuy).toEqual(LIGHTNING_AUTO_REBUY_DEFAULTS);
  });

  it('the trigger stack mirrors the migration: zero, below_bb, below_pct', () => {
    expect(lightningAutoRebuyTriggerStack(ON, 2)).toBe(40);
    // 'zero' asks only about a stack that is gone, whatever the blind says.
    expect(lightningAutoRebuyTriggerStack({ ...ON, trigger: 'zero' }, 0)).toBe(0);
    // 'below_pct' prices the target ('initial' | 'max') in the database, so
    // every released player is asked and NOT_TRIGGERED answers the rest.
    expect(
      lightningAutoRebuyTriggerStack({ ...ON, trigger: 'below_pct', thresholdPct: 25 }, 2)
    ).toBe(Number.POSITIVE_INFINITY);
    expect(lightningAutoRebuyTriggerStack({ ...ON, enabled: false }, 2)).toBeNull();
    expect(lightningAutoRebuyTriggerStack({ ...ON, thresholdBb: null }, 2)).toBeNull();
    expect(
      lightningAutoRebuyTriggerStack({ ...ON, trigger: 'below_pct', thresholdPct: null }, 2)
    ).toBeNull();
    expect(lightningAutoRebuyTriggerStack(ON, 0)).toBeNull();
  });
});

// ─── 2. The executor ───────────────────────────────────────────────────────

describe('the auto-rebuy executor (fn_lightning_auto_rebuy)', () => {
  it('asks once per triggered player, and config off asks nothing at all', async () => {
    const clock = { v: 1_000_000 };
    const { x, calls } = executor({ now: () => clock.v });
    await x.onHandSettled({
      clusterId: CLUSTER,
      handId: HAND,
      bigBlind: 2,
      config: { ...ON, enabled: false },
      players: [{ playerId: P1, stackAfter: 1 }],
    });
    expect(calls).toHaveLength(0);
    await x.onHandSettled({
      clusterId: CLUSTER,
      handId: HAND,
      bigBlind: 2,
      config: ON,
      players: [
        { playerId: P1, stackAfter: 12 }, // under 40: asked
        { playerId: P2, stackAfter: 300 }, // healthy: not asked
        { playerId: P3, stackAfter: 40 }, // at the trigger: asked
      ],
    });
    expect(calls.map(([fn]) => fn)).toEqual(['fn_lightning_auto_rebuy', 'fn_lightning_auto_rebuy']);
    expect(calls[0][1]).toEqual({
      p_cluster_id: CLUSTER,
      p_player_id: P1,
      p_now: new Date(clock.v).toISOString(),
    });
    expect(calls[1][1].p_player_id).toBe(P3);
  });

  it('at most one attempt per player per hand boundary: a replayed settle asks nothing again', async () => {
    const { x, calls } = executor({});
    const boundary = {
      clusterId: CLUSTER,
      handId: HAND,
      bigBlind: 2,
      config: ON,
      players: [{ playerId: P1, stackAfter: 10 }],
    };
    await x.onHandSettled(boundary);
    await x.onHandSettled(boundary);
    expect(calls).toHaveLength(1);
    // The NEXT hand is the next boundary, and it may ask again.
    await x.onHandSettled({ ...boundary, handId: uid(78) });
    expect(calls).toHaveLength(2);
  });

  it('a refusal and an error are both terminal for the boundary (no retry storm)', async () => {
    const errors: unknown[] = [];
    const logger = { ...quiet, error: (m: string) => errors.push(m) };
    const { x, calls } = executor({
      answer: () => ({ data: { ok: false, reason: 'session_cap_reached' }, error: null }),
    });
    await x.onHandSettled({
      clusterId: CLUSTER,
      handId: HAND,
      bigBlind: 2,
      config: ON,
      players: [{ playerId: P1, stackAfter: 10 }],
    });
    expect(calls).toHaveLength(1);
    const failing = executor({
      answer: () => ({ data: null, error: { code: '57014', message: 'canceled' } }),
      logger: logger as never,
    });
    await failing.x.onHandSettled({
      clusterId: CLUSTER,
      handId: HAND,
      bigBlind: 2,
      config: ON,
      players: [{ playerId: P1, stackAfter: 10 }],
    });
    expect(failing.calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('a missing function (deploy window) is quiet for ten minutes, then asked again', async () => {
    const clock = { v: 5_000_000 };
    const { x, calls } = executor({
      answer: () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      }),
      now: () => clock.v,
    });
    const boundary = (hand: string) => ({
      clusterId: CLUSTER,
      handId: hand,
      bigBlind: 2,
      config: ON,
      players: [{ playerId: P1, stackAfter: 10 }],
    });
    await x.onHandSettled(boundary(uid(81)));
    expect(calls).toHaveLength(1);
    await x.onHandSettled(boundary(uid(82))); // inside the window: not asked
    expect(calls).toHaveLength(1);
    clock.v += LIGHTNING_AUTO_REBUY_RETRY_MS + 1;
    await x.onHandSettled(boundary(uid(83)));
    expect(calls).toHaveLength(2);
  });
});

// ─── 3. The seam: between hands only ───────────────────────────────────────

describe('the host reports the settled boundary, between hands only', () => {
  interface Boundary {
    handId: string;
    bigBlind: number;
    players: Array<{ playerId: string; stackAfter: number }>;
    releasedBefore: number;
  }

  it('one report per settled hand, before anyone is handed back, with the settled stacks', async () => {
    const boundaries: Boundary[] = [];
    const formed = formedHand(3, 4000);
    let t!: ReturnType<typeof buildHost>;
    t = buildHost(formed, [100, 100, 100], {
      deps: {
        onHandSettled: (settled) =>
          void boundaries.push({ ...settled, releasedBefore: t.released.length }),
      },
    });
    await t.host.start();
    await playOut(t.host, mulberry32(21), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    expect(boundaries).toHaveLength(1);
    const b = boundaries[0];
    expect(b.handId).toBe(formed.handId);
    expect(b.bigBlind).toBe(2);
    // BEFORE the boundary's players were released to the matcher.
    expect(b.releasedBefore).toBe(0);
    const settled = t.calls.settle[0];
    expect(b.players.map((p) => p.playerId).sort()).toEqual(
      settled.results.map((r) => r.playerId).sort()
    );
    for (const p of b.players) {
      expect(p.stackAfter).toBe(settled.results.find((r) => r.playerId === p.playerId)!.stackAfter);
    }
  });

  it('a LIGHTNING folded player is not this boundary’s (their next hand is their next chance)', async () => {
    const boundaries: Boundary[] = [];
    const formed = formedHand(4, 4100);
    let t!: ReturnType<typeof buildHost>;
    t = buildHost(formed, [200, 200, 200, 200], {
      deps: {
        onHandSettled: (settled) =>
          void boundaries.push({ ...settled, releasedBefore: t.released.length }),
      },
    });
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const waiting = st.players.find(
      (p) => p.seat !== st.currentPlayerSeat && st.currentBet - p.bet > 0 && !p.is_folded
    )!;
    expect(t.host.handlePlayerAction(waiting.user_id, 'fast_fold').success).toBe(true);
    await playOut(t.host, mulberry32(22), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    expect(boundaries).toHaveLength(1);
    const named = boundaries[0].players.map((p) => p.playerId);
    expect(named).not.toContain(waiting.user_id);
    expect(named).toHaveLength(3);
  });

  it('an abandoned hand and an unknown settlement report no boundary at all', async () => {
    const calls: unknown[] = [];
    const onHandSettled = () => void calls.push(1);
    const abandoned = buildHost(formedHand(3, 4200), [100, 100, 100], {
      lease: () => null,
      deps: { onHandSettled },
    });
    await abandoned.host.start();
    expect(abandoned.host.lifecycle).toBe('abandoned');
    expect(calls).toHaveLength(0);

    const unknown = buildHost(formedHand(2, 4300), [100, 100], {
      settleScript: ['transport'],
      deps: { onHandSettled },
    });
    await unknown.host.start();
    await playOut(unknown.host, mulberry32(23), (_u, legal) =>
      legal.includes('fold') ? 'fold' : null
    );
    await flush();
    expect(unknown.host.lifecycle).toBe('settlement_unknown');
    expect(calls).toHaveLength(0);
  });

  it('a seam that throws never disturbs the settlement', async () => {
    const t = buildHost(formedHand(2, 4400), [100, 100], {
      deps: {
        onHandSettled: () => {
          throw new Error('boom');
        },
      },
    });
    await t.host.start();
    await playOut(t.host, mulberry32(24), (_u, legal) => (legal.includes('fold') ? 'fold' : null));
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    expect(t.calls.settle).toHaveLength(1);
  });
});

// ─── 4. Stop playing: the matcher's exclusion is the engine's ──────────────

describe('stop playing is honored by dealing only what the matcher formed', () => {
  it('the worker starts hands for exactly the players the SQL named; a withheld player gets none', async () => {
    const started: Array<string[]> = [];
    const rpc = async (fn: string) => {
      expect(fn).toBe('fn_lightning_match_and_form');
      return {
        data: {
          ok: true,
          hands: [
            {
              hand_id: uid(900),
              instance_id: uid(901),
              bb: P1,
              sb: P2,
              btn: P2,
              players: [P1, P2],
            },
          ],
        },
        error: null,
      };
    };
    const w = new LightningClusterWorker(
      CLUSTER,
      {
        matcherVersion: null,
        workerMode: 'form',
        passIntervalMs: 1_000,
        keepaliveIntervalMs: 30_000,
        maxHandsPerPass: 8,
        dealWindowMs: 600_000,
        autoRebuy: LIGHTNING_AUTO_REBUY_DEFAULTS,
      },
      {
        rpc: rpc as never,
        presence: new LightningPresence(() => []),
        metrics: new LightningMetrics(new MetricsRegistry()),
        logger: quiet,
        startHand: (hand) => started.push(hand.players),
        hasInstance: () => false,
      }
    );
    const out = await w.pass();
    expect(out.outcome).toBe('formed');
    // P3 (stopping, RG-blocked, or simply unmatched) is in no started hand:
    // the engine deals the SQL's answer and adds no player of its own.
    expect(started).toEqual([[P1, P2]]);
  });

  it('no engine-side RG or horse filter exists in the Phase 10 surfaces', () => {
    const code = (f: string) =>
      readFileSync(join(__dirname, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    // The worker's one dealing door is the loop over the matcher's hands.
    expect(code('LightningClusterWorker.ts').match(/deps\.startHand!\(/g)?.length).toBe(1);
    for (const f of [
      'LightningAutoRebuy.ts',
      'LightningClusterWorker.ts',
      'LightningRegistry.ts',
    ]) {
      const src = code(f);
      // CLAUDE.md 10.5: horses are humans - no is_horse in app matching logic.
      expect(src, f).not.toMatch(/is_horse|isHorse/);
      // RG verdicts are the database's; the engine never re-derives them.
      expect(src, f).not.toMatch(/stop_playing|stopPlaying|responsible/i);
    }
  });
});

// ─── 5. The hidden-information review (spec Phase 17) ──────────────────────

describe('hidden information: the frame walk, the logs and the record', () => {
  it('walks every frame type of a showdown hand: nothing before the showdown frame, tabled cards only after', async () => {
    for (let seed = 500; seed < 512; seed++) {
      const n = 2 + (seed % 3);
      const formed = formedHand(n, 10_000 + seed * 10);
      const t = buildHost(
        formed,
        Array.from({ length: n }, () => 100)
      );
      await t.host.start();
      // Check/call everything down: the hand reaches a real showdown.
      await playOut(t.host, mulberry32(seed), (_u, legal) =>
        legal.includes('check') ? 'check' : 'call'
      );
      await flush();
      expect(t.host.lifecycle).toBe('complete');
      const hole = new Map<string, Array<{ rank: string; suit: string }>>();
      for (const f of t.hub.frames) {
        if (f.kind === 'private' && f.payload.kind === 'hole_cards') {
          hole.set(f.userId!, f.payload.row.cards);
        }
      }
      expect(hole.size).toBe(n);
      const shown = new Set(
        (
          (t.host as never as { showdown: Array<{ userId: string; mucked?: boolean }> }).showdown ??
          []
        )
          .filter((r) => !r.mucked)
          .map((r) => r.userId)
      );
      expect(shown.size).toBeGreaterThan(0);
      const ownerOf = new Map(t.participants.map((p) => [p.poolSessionId, p.playerId]));
      const seenTypes = new Set<string>();
      const cardOf = (c: { rank: string; suit: string }) =>
        `{"rank":"${c.rank}","suit":"${c.suit}"}`;
      for (const room of t.participants.map((p) => p.poolSessionId)) {
        const frames = t.hub.inRoom(room);
        const owner = ownerOf.get(room)!;
        let showdownSeen = false;
        for (const f of frames) {
          if (f.kind === 'private') continue; // the owner's own cards, pinned below
          if (typeof f.payload.type === 'string') seenTypes.add(f.payload.type);
          if (f.payload.type === 'showdown' || f.payload.type === 'showdown_cards_revealed') {
            showdownSeen = true;
          }
          const json = JSON.stringify(f.payload);
          for (const [pid, cards] of hole) {
            if (pid === owner) continue;
            const allowed = showdownSeen && shown.has(pid);
            if (allowed) continue;
            for (const c of cards) {
              expect(
                json,
                `room ${room} saw ${pid}'s ${c.rank}${c.suit} (${String(f.payload.type ?? f.kind)}, pre-showdown=${!showdownSeen})`
              ).not.toContain(cardOf(c));
            }
          }
        }
        // Private hole cards in this room belong to its owner alone.
        for (const f of frames) {
          if (f.kind !== 'private') continue;
          expect(f.userId).toBe(owner);
        }
      }
      // The walk is not vacuous: the hand's whole frame vocabulary went past it.
      for (const required of [
        'hand_started',
        'turn_change',
        'player_action',
        'community_cards_dealt',
        'showdown',
        'showdown_cards_revealed',
        'hand_complete',
      ]) {
        expect([...seenTypes], `frame type ${required}`).toContain(required);
      }
    }
  });

  it('the host’s log lines never carry a hole card, settled or abandoned', async () => {
    const lines: string[] = [];
    const logger = {
      log: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string, err?: unknown) => lines.push(`${m} ${String(err ?? '')}`),
    };
    const formed = formedHand(3, 11_000);
    const t = buildHost(formed, [100, 100, 100], {
      deps: { logger },
      postCommitScript: ['predecessor_pending', 'ok'],
    });
    await t.host.start();
    await playOut(t.host, mulberry32(31), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    const abandoned = buildHost(formedHand(3, 11_100), [100, 100, 100], {
      deps: { logger },
      settleScript: ['refuse'],
    });
    await abandoned.host.start();
    await playOut(abandoned.host, mulberry32(32), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    const hole = [
      ...t.hub.frames.filter((f) => f.kind === 'private').map((f) => f.payload.row.cards),
      ...abandoned.hub.frames.filter((f) => f.kind === 'private').map((f) => f.payload.row.cards),
    ].flat() as Array<{ rank: string; suit: string }>;
    expect(hole.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0); // the pin is not vacuous
    for (const line of lines) {
      for (const c of hole) {
        expect(line).not.toContain(`"rank":"${c.rank}","suit":"${c.suit}"`);
      }
      expect(line).not.toMatch(/hole_cards|"cards"/);
    }
  });

  it('the durable record: no card in players or actions, hole_cards only for tabled showdowns', async () => {
    const formed = formedHand(3, 12_000);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await playOut(t.host, mulberry32(41), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    const row = t.calls.settle[0].handRow as {
      players: Array<{ cards: string[] }>;
      actions: Array<Record<string, unknown>>;
      hole_cards: Record<string, unknown> | null;
      showdown: Array<{ user_id: string; mucked: boolean }> | null;
    };
    expect(row.players.every((p) => p.cards.length === 0)).toBe(true);
    expect(JSON.stringify(row.actions)).not.toMatch(/"cards"|"rank"/);
    const shown = new Set(
      (
        (t.host as never as { showdown: Array<{ userId: string; mucked?: boolean }> }).showdown ??
        []
      )
        .filter((r) => !r.mucked)
        .map((r) => r.userId)
    );
    for (const key of Object.keys(row.hole_cards ?? {})) expect(shown.has(key)).toBe(true);
  });
});
