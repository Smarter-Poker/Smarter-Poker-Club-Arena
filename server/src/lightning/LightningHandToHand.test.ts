/**
 * LIGHTNING TRANSITIONS, PHASE 4 OF 5 (2026-10-26): faster, safer hand to hand
 * in the engine. Each block pins one cause:
 *
 *   - the first turn's clock waits for the client's deal presentation, for a
 *     horse exactly as for a person (CLAUDE.md 10.5);
 *   - the host table's rules are read alongside begin_dealing for the front
 *     table the supervisor knows, and the bind stays the authority;
 *   - every step of start() is marked, so event-loop delay and database time
 *     can be told apart;
 *   - the settlement's commit sends every participant's receipt at once (a
 *     person's Auto Top Up rides it), then releases the hand's players and
 *     wakes the Cluster before the post-commit drain, after the boundary's
 *     rebuy and horse top-up asks have answered;
 *   - a new player's time-bank reads go out together.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sliceCall } from '../testHelpers/sourceWindow.js';

vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));

const { buildHost, formedHand, flush, playOut, HOST_TABLE, uid } =
  await import('../testing/lightningHostTestKit.js');
const { LightningTimeBankLedger } = await import('./LightningHandHost.js');
const { HAND_COMPLETION } = await import('../config/handCompletionSpec.js');
const {
  lightningDealPresentationMs,
  LIGHTNING_DEAL_CARD_STAGGER_MS,
  LIGHTNING_DEAL_MIN_CARD_STAGGER_MS,
  LIGHTNING_DEAL_FLIGHT_MS,
  LIGHTNING_DEAL_SETTLE_MS,
  LIGHTNING_DEAL_MAX_MS,
  LIGHTNING_DEAL_HOLD_CEILING_MS,
} = await import('./LightningDealPresentation.js');
const { createLightningStartTiming } = await import('./LightningStartTiming.js');

/** A sleep the test releases by hand, recording what was asked. */
function heldSleeps() {
  const asked: Array<{ ms: number; release: () => void }> = [];
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      asked.push({ ms, release: r });
    });
  return { asked, sleep };
}

// ─── THE FIRST TURN WAITS FOR THE DEAL ────────────────────────────────────

describe('the first turn clock starts only once the deal has been shown', () => {
  it('a person: nobody is on the clock until the client has shown the deal', async () => {
    const s = heldSleeps();
    const now = { v: 5_000_000 };
    const t = buildHost(formedHand(6, 9100), [100, 100, 100, 100, 100, 100], {
      deps: { sleep: s.sleep, now: () => now.v },
    });
    try {
      await t.host.start();
      await flush();
      const presentation = lightningDealPresentationMs(6);
      // 700 ms button + (12 cards: 11 x 80 ms + 320 ms flight + 100 ms rest).
      expect(presentation).toBe(HAND_COMPLETION.BUTTON_MOVE_MS + 11 * 80 + 320 + 100);
      expect(s.asked.map((a) => a.ms)).toEqual([presentation]);
      // No clock, no turn frame, while the deal is still being shown.
      expect(t.hub.frames.some((f) => f.payload.type === 'turn_change')).toBe(false);
      now.v += presentation;
      s.asked[0].release();
      await flush();
      const turn = t.hub.frames.find((f) => f.payload.type === 'turn_change');
      expect(turn, 'the first turn opens once the deal is shown').toBeTruthy();
      // The first actor gets the WHOLE of their 15 s clock from that moment.
      expect(turn!.payload.deadline_ms).toBe(now.v + 15_000);
    } finally {
      for (const a of s.asked) a.release();
      await t.host.abort('test_cleanup');
    }
  });

  it('a horse waits exactly as long: its decision is not even asked for before the deal is shown', async () => {
    const s = heldSleeps();
    const formed = formedHand(2, 9200);
    const t = buildHost(formed, [100, 100], {
      horses: new Set(formed.players),
      deps: { sleep: s.sleep, now: () => 7_000_000 },
    });
    try {
      await t.host.start();
      await flush();
      expect(s.asked.map((a) => a.ms)).toEqual([lightningDealPresentationMs(2)]);
      expect(t.horseLane.raw.decideFast).not.toHaveBeenCalled();
      s.asked[0].release();
      await flush();
      expect(t.horseLane.raw.decideFast).toHaveBeenCalledTimes(1);
    } finally {
      for (const a of s.asked) a.release();
      await t.host.abort('test_cleanup');
    }
  });

  it('a later street keeps its ordinary beat (the wait is the deal, not every turn)', async () => {
    const waits: number[] = [];
    const now = { v: 9_000_000 };
    const t = buildHost(formedHand(2, 9300), [100, 100], {
      deps: {
        now: () => now.v,
        sleep: async (ms) => {
          waits.push(ms);
          now.v += ms;
        },
      },
    });
    try {
      await t.host.start();
      await flush();
      expect(waits[0]).toBe(lightningDealPresentationMs(2));
      now.v += 5_000; // the deal is long over
      await playOut(
        t.host,
        () => 0.5,
        (_id, legal) => (legal.includes('check') ? 'check' : 'call')
      );
      // Every later turn settle is the physical one (0 or the 500 ms street beat).
      expect(waits.slice(1).every((ms) => ms <= 500 || ms > 1_000)).toBe(true);
      expect(waits.slice(1).filter((ms) => ms === lightningDealPresentationMs(2))).toEqual([]);
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('the engine numbers are the client deal numbers (a change on either side fails here)', () => {
    // vitest runs from server/ (theSuiteRunsFromTheServerDirectory).
    const deal = readFileSync(
      resolve(process.cwd(), '../src/components/table/DealAnimation.tsx'),
      'utf8'
    );
    const num = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(deal)?.[1]);
    expect(num('CARD_STAGGER_MS')).toBe(LIGHTNING_DEAL_CARD_STAGGER_MS);
    expect(num('MIN_CARD_STAGGER_MS')).toBe(LIGHTNING_DEAL_MIN_CARD_STAGGER_MS);
    expect(num('SETTLE_BUFFER_MS')).toBe(LIGHTNING_DEAL_SETTLE_MS);
    expect(num('MAX_DEAL_MS')).toBe(LIGHTNING_DEAL_MAX_MS);
    expect(deal).toMatch(new RegExp(`let base = ${LIGHTNING_DEAL_FLIGHT_MS};`));
    expect(deal).toMatch(/const cardCount = seats\.length \* 2;/);
    const page = readFileSync(resolve(process.cwd(), '../src/pages/TablePage.tsx'), 'utf8');
    const hold = sliceCall(page, 'const beginDealHold = useCallback(');
    expect(hold).toMatch(new RegExp(`\\}, ${LIGHTNING_DEAL_HOLD_CEILING_MS}\\);`));
    expect(page).toMatch(/Math\.round\(HAND_COMPLETION\.BUTTON_MOVE_MS \* getAnimationSpeed\(\)\)/);
    // A full ring never runs into the client's own ceiling at speed 1.
    for (let n = 2; n <= 10; n++)
      expect(lightningDealPresentationMs(n)).toBeLessThan(LIGHTNING_DEAL_HOLD_CEILING_MS);
  });
});

// ─── THE START PATH ───────────────────────────────────────────────────────

describe('start(): the host rules ride alongside begin_dealing', () => {
  it('reads the front table the supervisor named before begin_dealing has answered', async () => {
    const formed = { ...formedHand(2, 9400), hostTableHint: HOST_TABLE };
    let answer!: () => void;
    const t = buildHost(formed, [100, 100]);
    const begin = t.backend.beginDealing as ReturnType<typeof vi.fn>;
    begin.mockImplementationOnce(
      () =>
        new Promise((r) => {
          answer = () => r({ ok: true, value: { handId: formed.handId } });
        })
    );
    try {
      const starting = t.host.start();
      await flush();
      expect(t.backend.loadHostRules).toHaveBeenCalledWith(HOST_TABLE);
      expect(t.backend.bindHandNumber).not.toHaveBeenCalled();
      answer();
      await starting;
      expect(t.host.lifecycle).toBe('dealing');
      // The bind confirmed the hint: one rules read, not two.
      expect(t.backend.loadHostRules).toHaveBeenCalledTimes(1);
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('a hint the bind does not confirm is discarded, and the bound table is read', async () => {
    const stale = uid(9999);
    const formed = { ...formedHand(2, 9500), hostTableHint: stale };
    const t = buildHost(formed, [100, 100]);
    try {
      await t.host.start();
      expect(t.host.lifecycle).toBe('dealing');
      const reads = (t.backend.loadHostRules as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0]
      );
      expect(reads).toEqual([stale, HOST_TABLE]);
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('no hint: the rules are read for the bound table, as before', async () => {
    const t = buildHost(formedHand(2, 9600), [100, 100]);
    try {
      await t.host.start();
      expect(
        (t.backend.loadHostRules as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
      ).toEqual([HOST_TABLE]);
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('marks every step of start() and closes the span once', async () => {
    const marks: string[] = [];
    const outcomes: string[] = [];
    const t = buildHost(formedHand(2, 9700), [100, 100], {
      deps: {
        startTiming: () => ({
          mark: (s: string) => void marks.push(s),
          finish: (o: string) => void outcomes.push(o),
        }),
      },
    });
    try {
      await t.host.start();
      expect(marks).toEqual([
        'begin_dealing',
        'hand_number',
        'bind',
        'participants',
        'rules',
        'time_banks',
        'dealt',
      ]);
      // finish() is idempotent in the real span; the host calls it at the
      // deal and again in its finally.
      expect(new Set(outcomes)).toEqual(new Set(['dealt']));
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('a refused start is marked with its reason', async () => {
    const outcomes: string[] = [];
    const t = buildHost(formedHand(2, 9800), [100, 100], {
      lease: () => null,
      deps: {
        startTiming: () => ({
          mark: () => undefined,
          finish: (o: string) => void outcomes.push(o),
        }),
      },
    });
    await t.host.start();
    expect(t.calls.abandon).toEqual(['host_lease_not_held']);
    expect(outcomes[0]).toBe('host_lease_not_held');
  });

  it('the timing line names steps and the event-loop delay, and nothing of the hand', () => {
    const lines: string[] = [];
    let clock = 0;
    const timing = createLightningStartTiming({
      now: () => clock,
      wallNow: () => 10_000,
      log: (l) => lines.push(l),
    });
    const span = timing.begin(uid(1), 10_000 - 400);
    clock = 300;
    span.mark('begin_dealing');
    clock = 900;
    span.mark('bind');
    span.finish('dealt');
    span.finish('dealt');
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0].slice('[LightningStartTiming] '.length));
    expect(report).toMatchObject({
      handId: uid(1),
      outcome: 'dealt',
      formedToStartMs: 400,
      startMs: 900,
      steps: { begin_dealing: 300, bind: 900 },
    });
    expect(typeof report.timerLateMs).toBe('number');
    // A fast start is not logged at all.
    const quick = timing.begin(uid(2), 10_000);
    clock += 10;
    quick.finish('dealt');
    expect(lines).toHaveLength(1);
  });
});

// ─── SETTLED IS FREE ──────────────────────────────────────────────────────

describe('the committed settlement frees its players and wakes the Cluster before the drain', () => {
  it('order: receipt -> boundary asks answered -> players released -> wake -> post-commit drain', async () => {
    const order: string[] = [];
    let drainAnswer!: () => void;
    const t = buildHost(formedHand(3, 9900), [100, 100, 100], {
      deps: {
        onHandSettled: async () => {
          order.push('boundary');
        },
        onPlayerReleased: (_p, why) => {
          if (why === 'hand_end') order.push('released');
        },
        onSettled: () => {
          order.push('wake');
        },
      },
    });
    const emit = t.hub.emitEvent.bind(t.hub);
    t.hub.emitEvent = (room: string, payload: Record<string, unknown>) => {
      if (payload.type === 'hand_history_saved') order.push(`receipt:${String(payload.player_id)}`);
      emit(room, payload);
    };
    (t.backend.postCommit as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('drain');
      return new Promise((r) => {
        drainAnswer = () => r({ ok: true });
      });
    });
    try {
      await t.host.start();
      await playOut(
        t.host,
        () => 0.5,
        (_id, legal) => (legal.includes('check') ? 'check' : 'call')
      );
      await flush();
      expect(t.calls.settle).toHaveLength(1);
      // A PERSON'S INPUT-DEVICE MOMENT: every participant's receipt (the frame
      // a person's client sends its Auto Top Up on) goes out at the commit,
      // before the boundary (where a horse's top-up is sent) and before
      // anyone is released, so the two requests are in flight together.
      const receipts = order.filter((o) => o.startsWith('receipt:'));
      expect(receipts.sort()).toEqual(
        formedHand(3, 9900)
          .players.map((p) => `receipt:${p}`)
          .sort()
      );
      const lastReceipt = Math.max(...receipts.map((r) => order.indexOf(r)));
      expect(lastReceipt).toBeLessThan(order.indexOf('boundary'));
      expect(lastReceipt).toBeLessThan(order.indexOf('released'));
      // Then: boundary answered -> released -> wake -> drain (not yet answered).
      const rest = order.filter((o) => !o.startsWith('receipt:'));
      expect(rest.slice(0, 2)).toEqual(['boundary', 'released']);
      expect(rest.indexOf('wake')).toBeGreaterThan(rest.indexOf('released'));
      expect(rest.indexOf('drain')).toBeGreaterThan(rest.indexOf('wake'));
      drainAnswer();
      await t.host.whenFinished();
      // Released once each, at the commit; finish() frees nobody a second time.
      expect(order.filter((o) => o === 'released')).toHaveLength(3);
      expect(order.filter((o) => o === 'wake')).toHaveLength(1);
      expect(receipts).toHaveLength(3);
    } finally {
      drainAnswer?.();
      await t.host.abort('test_cleanup');
    }
  });

  it('their banks are back in the ledger before they are released', async () => {
    const formed = formedHand(2, 9910);
    const t = buildHost(formed, [100, 100]);
    const recorded: string[] = [];
    const ledger = (t.host as any).deps.timeBanks;
    const record = ledger.record.bind(ledger);
    ledger.record = (u: string, ...rest: unknown[]) => {
      recorded.push(u);
      return record(u, ...rest);
    };
    const seenAtRelease: number[] = [];
    (t.host as any).deps.onPlayerReleased = () => seenAtRelease.push(recorded.length);
    try {
      await t.host.start();
      await playOut(
        t.host,
        () => 0.5,
        (_id, legal) => (legal.includes('check') ? 'check' : 'call')
      );
      await t.host.whenFinished();
      expect(seenAtRelease.length).toBe(2);
      expect(seenAtRelease.every((n) => n === 2)).toBe(true);
    } finally {
      await t.host.abort('test_cleanup');
    }
  });

  it('an abandoned hand never wakes the Cluster', async () => {
    const wake = vi.fn();
    const t = buildHost(formedHand(2, 9920), [100, 100], {
      lease: () => null,
      deps: { onSettled: wake },
    });
    await t.host.start();
    await t.host.whenFinished();
    expect(t.calls.abandon).toEqual(['host_lease_not_held']);
    expect(wake).not.toHaveBeenCalled();
  });
});

// ─── A NEW PLAYER'S FIRST HAND: THE BANK READS GO TOGETHER ───────────────

describe('a new player time bank is read in one round trip', () => {
  it('asks the allowance and the durable bank together, each with its own fallback', async () => {
    const P = uid(42);
    let allowanceAnswer!: (m: Map<string, unknown>) => void;
    let durableAnswer!: (m: Map<string, unknown>) => void;
    const backend = {
      timeBankAllowance: vi.fn(
        () =>
          new Promise<Map<string, any>>((r) => {
            allowanceAnswer = r as never;
          })
      ),
      durableTimeBanks: vi.fn(
        () =>
          new Promise<Map<string, any>>((r) => {
            durableAnswer = r as never;
          })
      ),
      consumeTimeBank: vi.fn(async () => undefined),
    };
    const ledger = new LightningTimeBankLedger(backend as any, uid(1), () => Promise.resolve(), {
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    const ensured = ledger.ensure([P]);
    await flush();
    // Both are in flight before either has answered.
    expect(backend.timeBankAllowance).toHaveBeenCalledWith([P]);
    expect(backend.durableTimeBanks).toHaveBeenCalledWith(uid(1), [P]);
    durableAnswer(new Map([[P, { remainingSeconds: 30, usesRemaining: 2 }]]));
    allowanceAnswer(new Map([[P, { extraSeconds: 20, unlimitedActivations: false }]]));
    await ensured;
    expect(ledger.get(P)).toMatchObject({
      remainingSeconds: 30,
      usesRemaining: 2,
      initialSeconds: 60,
    });
  });

  it('a failed allowance still seeds from the durable bank, and a failed durable read from the allowance', async () => {
    const P = uid(43);
    const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const a = new LightningTimeBankLedger(
      {
        timeBankAllowance: vi.fn(async () => {
          throw new Error('down');
        }),
        durableTimeBanks: vi.fn(
          async () => new Map([[P, { remainingSeconds: 12, usesRemaining: 1 }]])
        ),
        consumeTimeBank: vi.fn(),
      } as any,
      uid(1),
      () => Promise.resolve(),
      quiet
    );
    await a.ensure([P]);
    expect(a.get(P)).toMatchObject({ remainingSeconds: 12, initialSeconds: 40 });
    const b = new LightningTimeBankLedger(
      {
        timeBankAllowance: vi.fn(async () => new Map([[P, { extraSeconds: 20 }]])),
        durableTimeBanks: vi.fn(async () => {
          throw new Error('down');
        }),
        consumeTimeBank: vi.fn(),
      } as any,
      uid(1),
      () => Promise.resolve(),
      quiet
    );
    await b.ensure([P]);
    expect(b.get(P)).toMatchObject({ remainingSeconds: 60, initialSeconds: 60 });
  });
});
