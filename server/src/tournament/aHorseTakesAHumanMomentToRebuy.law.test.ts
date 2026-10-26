import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A HORSE TAKES A HUMAN MOMENT TO REBUY (2026-10-24, CLAUDE.md 10.5).
 *
 * "TIMING IS PART OF THE TREATMENT." A human answers a tournament rebuy offer
 * by clicking inside its 30 s window; every human rebuy ever recorded inside
 * the window took 9-15 s. The horse input device (#7911) answered within
 * milliseconds of the bust (horses: p50 2.3 s over 31,812 rebuys, mostly the
 * sweep's latency). A willing horse now answers a deterministic think time
 * after its bust - 3.5-16 s, never later than 8 s before its deadline - on
 * BOTH paths that answer for it. Until then it is not answered and keeps its
 * decision grace exactly like an undecided human.
 */

const fixture = vi.hoisted(() => ({
  frozen: false,
  rpc: vi.fn(),
  from: vi.fn(),
  offers: [] as Array<{
    eliminated_user_id: string;
    hand_number: number;
    created_at: string;
    rebuy_prompt_until: string;
  }>,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: { rpc: fixture.rpc, from: fixture.from },
  maintenanceSupabase: { rpc: fixture.rpc, from: fixture.from },
}));
vi.mock('../maintenance/freezeState.js', () => ({
  isMaintenanceFrozen: () => fixture.frozen,
  isTerminalSettlementFrozen: () => false,
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
const { TournamentManagerEliminations } = await import('./TournamentManagerEliminations.js');
const { horseChoosesTournamentRebuy } = await import('./horseTournamentRebuyChoice.js');
const {
  HORSE_REBUY_DECISION_MAX_MS,
  HORSE_REBUY_DECISION_MIN_MS,
  HORSE_REBUY_WINDOW_SAFETY_MARGIN_MS,
  horseRebuyAnswerDueAtMs,
  horseRebuyDecisionDelayMs,
} = await import('./horseTournamentRebuyTiming.js');

const here = dirname(fileURLToPath(import.meta.url));
const event = 'cccccccc-0000-4000-8000-000000000001';
const ids = Array.from(
  { length: 12 },
  (_, i) => `cccccccc-0000-4000-8000-${String(i + 2).padStart(12, '0')}`
);
const HAND = 4242;
const WINDOW_MS = 30_000;
const T0 = 1_800_000_000_000;
const willing = ids.filter((id) => horseChoosesTournamentRebuy(event, id, HAND));
const declining = ids.filter((id) => !willing.includes(id));
const dueOf = (id: string) => T0 + horseRebuyDecisionDelayMs(event, id, HAND);

/** When each purchase was sent, by horse. */
let purchasedAt = new Map<string, number>();

function setup() {
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: event,
    tournamentCache: { is_rebuy: true, is_reentry: true, free_buy: false },
    currentLevel: 3,
    running: true,
    eliminationSweepDeadlineAt: 1,
    eliminationMutationBatchOpen: false,
    eliminationMutationAllowed: () => true,
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
  });
  fixture.offers = ids.map((id) => ({
    eliminated_user_id: id,
    hand_number: HAND,
    created_at: new Date(T0).toISOString(),
    rebuy_prompt_until: new Date(T0 + WINDOW_MS).toISOString(),
  }));
  fixture.from.mockImplementation((table: string) => {
    if (table === 'tournament_knockout_candidates') {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gt', 'order']) q[m] = vi.fn(() => q);
      // The open, pending offers: a bought horse's row is no longer pending,
      // and an expired offer is no longer open.
      q.limit = vi.fn(async () => ({
        data: fixture.offers.filter(
          (o) =>
            !purchasedAt.has(o.eliminated_user_id) && Date.parse(o.rebuy_prompt_until) > Date.now()
        ),
        error: null,
      }));
      return q;
    }
    if (table === 'profiles') {
      let asked: string[] = [];
      const q: Record<string, unknown> = {};
      q.select = vi.fn(() => q);
      q.in = vi.fn((_c: string, list: string[]) => {
        asked = list;
        return q;
      });
      q.eq = vi.fn(async () => ({ data: asked.map((id) => ({ id })), error: null }));
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  fixture.rpc.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
    if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
    if (name === 'process_tournament_rebuy') {
      if (!purchasedAt.has(String(args.p_user_id)))
        purchasedAt.set(String(args.p_user_id), Date.now());
      return { data: { success: true }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return manager;
}

const windowReads = () =>
  fixture.rpc.mock.calls.filter((call) => call[0] === 'fn_ca_tournament_rebuy_window').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fixture.frozen = false;
  purchasedAt = new Map();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the think time', () => {
  it('the fixture holds both answers', () => {
    expect(willing.length).toBeGreaterThan(1);
    expect(declining.length).toBeGreaterThan(0);
  });

  it('is the same moment for the same tournament, horse and busting hand', () => {
    for (const id of ids) {
      expect(horseRebuyDecisionDelayMs(event, id, HAND)).toBe(
        horseRebuyDecisionDelayMs(event, id, HAND)
      );
    }
  });

  it('is drawn per bust, inside the human click range', () => {
    const draws: number[] = [];
    for (let hand = 1; hand <= 2_000; hand++) {
      const ms = horseRebuyDecisionDelayMs(event, ids[0], hand);
      expect(ms).toBeGreaterThanOrEqual(HORSE_REBUY_DECISION_MIN_MS);
      expect(ms).toBeLessThanOrEqual(HORSE_REBUY_DECISION_MAX_MS);
      draws.push(ms);
    }
    expect(new Set(draws).size).toBeGreaterThan(1_000);
    // Centred where the measured human clicks sit (9-15 s), not at the floor.
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeGreaterThan(9_000);
    expect(mean).toBeLessThan(10_500);
    expect(HORSE_REBUY_DECISION_MIN_MS).toBeGreaterThanOrEqual(2_500);
  });

  it('is never due before the bust nor after the window safety margin', () => {
    for (let hand = 1; hand <= 500; hand++) {
      for (const windowMs of [30_000, 20_000, 12_000, 4_000, 1_000, 0]) {
        const due = horseRebuyAnswerDueAtMs(event, ids[1], hand, T0, T0 + windowMs)!;
        expect(due).toBeGreaterThanOrEqual(T0);
        expect(due).toBeLessThanOrEqual(T0 + horseRebuyDecisionDelayMs(event, ids[1], hand));
        const margin = Math.min(HORSE_REBUY_WINDOW_SAFETY_MARGIN_MS, windowMs / 2);
        expect(due).toBeLessThanOrEqual(T0 + windowMs - margin);
      }
      // A 30 s offer: always at least 8 s of the window left.
      expect(horseRebuyAnswerDueAtMs(event, ids[1], hand, T0, T0 + 30_000)!).toBeLessThanOrEqual(
        T0 + 30_000 - 8_000
      );
    }
  });

  it('has no due moment when the bust moment is unknown', () => {
    expect(horseRebuyAnswerDueAtMs(event, ids[0], HAND, null, T0 + WINDOW_MS)).toBeNull();
    expect(horseRebuyAnswerDueAtMs(event, ids[0], HAND, Number.NaN, T0)).toBeNull();
  });
});

describe('the input device answers when the horse is due, not at the bust', () => {
  it('buys nothing before the delay, each willing horse after it, never past the margin', async () => {
    const manager = setup();
    manager.horseRebuyOfferMayHaveOpened();
    await vi.advanceTimersByTimeAsync(0);
    // The bust itself: no willing horse has thought yet.
    expect([...purchasedAt.keys()]).toEqual([]);

    for (let t = 0; t <= WINDOW_MS; t += 250) {
      await vi.advanceTimersByTimeAsync(250);
      for (const id of willing) {
        if (Date.now() < dueOf(id)) expect(purchasedAt.has(id)).toBe(false);
      }
    }
    expect([...purchasedAt.keys()].sort()).toEqual([...willing].sort());
    for (const id of willing) {
      const at = purchasedAt.get(id)!;
      expect(at).toBeGreaterThanOrEqual(dueOf(id));
      // Woken AT the due moment, not by a blind poll.
      expect(at - dueOf(id)).toBeLessThan(50);
      expect(at).toBeLessThanOrEqual(T0 + WINDOW_MS - HORSE_REBUY_WINDOW_SAFETY_MARGIN_MS);
    }
    for (const id of declining) expect(purchasedAt.has(id)).toBe(false);
    // One pass at the bust plus one per distinct due moment: no 2 s polling.
    expect(windowReads()).toBeLessThanOrEqual(1 + new Set(willing.map(dueOf)).size);
  });

  it('a horse that is not due is not "unanswered" and spends no retry pass', async () => {
    const manager = setup();
    expect(await manager.answerOpenHorseRebuyOffers()).toBe(false);
    expect(manager.horseRebuyInputNextDueAtMs).toBe(Math.min(...willing.map(dueOf)));
    expect(purchasedAt.size).toBe(0);
  });

  it('a restarted manager asks the same question and gets the same moment', async () => {
    const first = setup();
    await first.answerOpenHorseRebuyOffers();
    const second = setup();
    await second.answerOpenHorseRebuyOffers();
    expect(second.horseRebuyInputNextDueAtMs).toBe(first.horseRebuyInputNextDueAtMs);
  });
});

describe('the elimination sweep path obeys the same moment', () => {
  const timings = () =>
    new Map(
      ids.map((id) => [id, { handNumber: HAND, bustAtMs: T0, promptUntilMs: T0 + WINDOW_MS }])
    );
  const hands = () => new Map(ids.map((id) => [id, HAND]));

  it('defers every willing horse at the bust, keeping its grace, and declines as before', async () => {
    const manager = setup();
    const result = await manager.tryTournamentRebuys(ids, hands(), timings());
    expect(purchasedAt.size).toBe(0);
    expect([...result.deferredUntil.keys()].sort()).toEqual([...willing].sort());
    for (const id of willing) {
      expect(result.deferredUntil.get(id)).toBe(dueOf(id));
      expect(result.answered.has(id)).toBe(false);
    }
    // A decline is not visible (the window is waited out either way), so it
    // is recorded as before.
    for (const id of declining) expect(result.answered.has(id)).toBe(true);
  });

  it('buys after the delay', async () => {
    const manager = setup();
    vi.setSystemTime(Math.max(...willing.map(dueOf)));
    const result = await manager.tryTournamentRebuys(ids, hands(), timings());
    expect([...result.rebought].sort()).toEqual([...willing].sort());
    expect(result.deferredUntil.size).toBe(0);
  });

  it('never buys for a horse whose bust moment it cannot read', async () => {
    const manager = setup();
    vi.setSystemTime(T0 + 25_000);
    const result = await manager.tryTournamentRebuys(ids, hands(), new Map());
    expect(purchasedAt.size).toBe(0);
    for (const id of willing) expect(result.answered.has(id)).toBe(false);
    expect(manager.requestUrgentEliminationSweepAfter).toHaveBeenCalled();
  });

  it('reads the bust moment with the bust order and wakes the device when due', () => {
    const elim = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
    expect(elim).toMatch(
      /const \{ rebought, deferredUntil \} = await this\.tryTournamentRebuys\(\s*busted\.map\(\(b\) => b\.user_id\),\s*bustHandNumbers,\s*bustOfferTimings\s*\);/
    );
    expect(elim).toMatch(
      /if \(deferredUntil\.size > 0\) \{\s*this\.armHorseRebuyInput\(Math\.min\(\.\.\.deferredUntil\.values\(\)\), 0\);/
    );
    const rebuys = elim.slice(
      elim.indexOf('private async tryTournamentRebuys('),
      elim.indexOf('Load the one hand that is allowed to authorize a bounty elimination.')
    );
    const due = rebuys.indexOf('if (Date.now() < dueAtMs) {');
    expect(due).toBeGreaterThan(0);
    expect(due).toBeLessThan(rebuys.indexOf("supabase.rpc('process_tournament_rebuy'"));
  });
});
