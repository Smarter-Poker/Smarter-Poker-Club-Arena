import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A HORSE ANSWERS ITS REBUY OFFER LIKE A CLICK (2026-10-24).
 *
 * A human's rebuy answer goes straight to process_tournament_rebuy. A horse's
 * answer used to be given only inside the elimination sweep, which waits for
 * a shared four-slot scheduler and stops at a five-second work budget, so on a
 * busy engine the horse answered after its 30 second offer had expired (160
 * refusals in six hours; a freeroll with 85 horses choosing to rebuy got 19).
 * These pins keep the horse's answer on its own immediate path.
 */

const fixture = vi.hoisted(() => ({ frozen: false, rpc: vi.fn(), from: vi.fn() }));
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

const here = dirname(fileURLToPath(import.meta.url));
const event = 'bbbbbbbb-0000-4000-8000-000000000001';
const ids = Array.from(
  { length: 12 },
  (_, i) => `bbbbbbbb-0000-4000-8000-${String(i + 2).padStart(12, '0')}`
);
const HAND = 777;
const willing = ids.filter((id) => horseChoosesTournamentRebuy(event, id, HAND));
const declining = ids.filter((id) => !willing.includes(id));

type Purchase = 'ok' | 'transport';

function setup(
  opts: {
    horses?: string[];
    offers?: string[];
    purchase?: Purchase;
    freeBuyUsed?: number;
    profileFailure?: 'error' | 'throw' | 'null';
  } = {}
) {
  const horses = opts.horses ?? ids;
  const offers = opts.offers ?? ids;
  const purchase = opts.purchase ?? 'ok';
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: event,
    lifecycleJobs: new Set(),
    tournamentCache: { is_rebuy: true, is_reentry: true, free_buy: opts.freeBuyUsed !== undefined },
    currentLevel: 3,
    running: true,
    // The sweep's own budget is long spent: the horse must not depend on it.
    eliminationSweepDeadlineAt: 1,
    eliminationMutationBatchOpen: false,
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
  });
  fixture.from.mockImplementation((table: string) => {
    if (table === 'tournament_players') {
      const q: Record<string, unknown> = {};
      q.select = vi.fn(() => q);
      q.eq = vi.fn(() => q);
      q.in = vi.fn(async (_column: string, users: string[]) => ({
        data: users.map((user_id) => ({ user_id, rebuys: opts.freeBuyUsed })),
        error: null,
      }));
      return q;
    }
    if (table === 'tournament_knockout_candidates') {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gt', 'order']) q[m] = vi.fn(() => q);
      q.limit = vi.fn(async () => ({
        data: offers.map((id) => ({
          eliminated_user_id: id,
          hand_number: HAND,
          // Busted 20 s ago in a 30 s offer: every willing horse's human think
          // time (2026-10-24, aHorseTakesAHumanMomentToRebuy) has passed.
          created_at: new Date(Date.now() - 20_000).toISOString(),
          rebuy_prompt_until: new Date(Date.now() + 10_000).toISOString(),
        })),
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
      q.eq = vi.fn(async () => {
        if (opts.profileFailure === 'throw') throw new Error('profile transport lost');
        if (opts.profileFailure)
          return {
            data: null,
            error: opts.profileFailure === 'error' ? { message: 'profile unavailable' } : null,
          };
        return {
          data: asked.filter((id) => horses.includes(id)).map((id) => ({ id })),
          error: null,
        };
      });
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  fixture.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
    if (name === 'fn_decline_tournament_rebuy')
      return { data: { ok: true, declined: true }, error: null };
    if (name === 'process_tournament_rebuy') {
      return purchase === 'ok'
        ? { data: { success: true }, error: null }
        : { data: null, error: { message: 'fetch failed' } };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return manager;
}

const declines = () =>
  fixture.rpc.mock.calls
    .filter((call) => call[0] === 'fn_decline_tournament_rebuy')
    .map((call) => call[1] as { p_tournament_id: string; p_user_id: string });

const purchases = () =>
  fixture.rpc.mock.calls
    .filter((call) => call[0] === 'process_tournament_rebuy')
    .map((call) => (call[1] as { p_user_id: string }).p_user_id);

beforeEach(() => {
  fixture.frozen = false;
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('a horse answers its rebuy offer like a click', () => {
  it('the fixture holds both answers', () => {
    expect(willing.length).toBeGreaterThan(0);
    expect(declining.length).toBeGreaterThan(0);
  });

  it('buys back in for every willing horse with an open offer, even after the sweep budget is spent', async () => {
    const manager = setup();
    const again = await manager.answerOpenHorseRebuyOffers();
    expect(purchases().sort()).toEqual([...willing].sort());
    expect(again).toBe(false);
  });

  it('sends nothing for a declining horse and nothing on behalf of a human', async () => {
    const human = willing[0];
    const manager = setup({ horses: ids.filter((id) => id !== human) });
    await manager.answerOpenHorseRebuyOffers();
    expect(purchases()).not.toContain(human);
    for (const id of declining) expect(purchases()).not.toContain(id);
  });

  it('tells the database a declining horse said no, as a human click does, and nothing else', async () => {
    const human = declining[0];
    await setup({ horses: ids.filter((id) => id !== human) }).answerOpenHorseRebuyOffers();
    const told = declines();
    expect(told.every((d) => d.p_tournament_id === event)).toBe(true);
    expect(told.map((d) => d.p_user_id).sort()).toEqual(
      declining.filter((id) => id !== human).sort()
    );
    for (const id of willing) expect(told.map((d) => d.p_user_id)).not.toContain(id);
    // Never sent while frozen.
    vi.clearAllMocks();
    fixture.frozen = true;
    await setup().answerOpenHorseRebuyOffers();
    expect(declines()).toEqual([]);
  });

  it('a refused decline leaves the offer to its own deadline and asks nothing again', async () => {
    const manager = setup();
    fixture.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
      if (name === 'fn_decline_tournament_rebuy')
        return { data: null, error: { message: 'refused' } };
      if (name === 'process_tournament_rebuy') return { data: { success: true }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    expect(await manager.answerOpenHorseRebuyOffers()).toBe(false);
    expect(purchases().sort()).toEqual([...willing].sort());
  });

  it('does not let one slow purchase response consume another ready offer deadline', async () => {
    vi.useFakeTimers();
    try {
      const users = willing.slice(0, 2);
      const manager = setup({ offers: users });
      const deadline = Date.now() + 10_000;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const completed: string[] = [];
      fixture.rpc.mockImplementation(async (name: string, args: { p_user_id: string }) => {
        if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
        if (name === 'process_tournament_rebuy') {
          if (args.p_user_id === users[0]) await held;
          if (Date.now() >= deadline)
            return {
              data: null,
              error: { code: '55000', message: 'Rebuy or re-entry decision window has closed' },
            };
          completed.push(args.p_user_id);
          return { data: { success: true }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      });
      const pass = manager.answerOpenHorseRebuyOffers();
      await vi.advanceTimersByTimeAsync(10_001);
      release();
      await pass;
      expect(completed).toContain(users[1]);
      expect(completed).not.toContain(users[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['null', 'false', 'throw'])(
    'retains an unproven %s purchase for the original bounded input',
    async (kind) => {
      const user = willing[0];
      const manager = setup({ offers: [user] });
      const normal = fixture.rpc.getMockImplementation()!;
      fixture.rpc.mockImplementation(async (name: string, args: unknown) => {
        if (name !== 'process_tournament_rebuy') return normal(name, args);
        if (kind === 'throw') throw new Error('network response lost');
        return { data: kind === 'null' ? null : { success: false }, error: null };
      });
      expect(await manager.answerOpenHorseRebuyOffers()).toBe(true);
      expect(declines()).toEqual([]);
      fixture.rpc.mockImplementation(normal);
      expect(await manager.answerOpenHorseRebuyOffers()).toBe(false);
    }
  );

  it('bounds independent purchase inputs to four without losing the rest of the batch', async () => {
    const manager = setup({ offers: willing });
    const normal = fixture.rpc.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0,
      peak = 0;
    fixture.rpc.mockImplementation(async (name: string, args: unknown) => {
      if (name !== 'process_tournament_rebuy') return normal(name, args);
      active++;
      peak = Math.max(peak, active);
      await held;
      active--;
      return { data: { success: true }, error: null };
    });
    const pass = manager.answerOpenHorseRebuyOffers();
    try {
      await vi.waitFor(() => expect(active).toBe(4));
      expect(peak).toBe(4);
    } finally {
      release();
      await pass;
    }
    expect(peak).toBeLessThanOrEqual(4);
    expect(purchases().sort()).toEqual([...willing].sort());
  });

  it('submits an already-due answer just before cutoff, never a new input at or after cutoff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const user = willing[0];
    const manager = setup({ offers: [user] });
    const now = Date.now();
    const hands = new Map([[user, HAND]]);
    const timing = (until: number) =>
      new Map([[user, { handNumber: HAND, bustAtMs: now - 29_900, promptUntilMs: until }]]);
    const before = await manager.tryTournamentRebuys([user], hands, timing(now + 100), () => true);
    expect(before.rebought.has(user)).toBe(true);
    const count = purchases().length;
    for (const until of [now - 1, now]) {
      const expired = await manager.tryTournamentRebuys([user], hands, timing(until), () => true);
      expect(expired.rebought.size).toBe(0);
    }
    expect(purchases()).toHaveLength(count);
  });

  it.each(['stop', 'freeze', 'cutoff'])(
    'rechecks %s after reserving a queued input and releases the reservation',
    async (change) => {
      vi.useFakeTimers();
      try {
        const user = willing[0];
        const manager = setup({ offers: [user] });
        const pending = new Map<string, Promise<void>>();
        manager.horseRebuyPending = pending;
        manager.running = true;
        const now = Date.now();
        vi.spyOn(pending, 'set').mockImplementation((key, promise) => {
          Map.prototype.set.call(pending, key, promise);
          if (change === 'stop') manager.running = false;
          if (change === 'freeze') fixture.frozen = true;
          if (change === 'cutoff') vi.setSystemTime(now + 10_000);
          return pending;
        });
        const result = await manager.tryTournamentRebuys(
          [user],
          new Map([[user, HAND]]),
          new Map([
            [user, { handNumber: HAND, bustAtMs: now - 20_000, promptUntilMs: now + 10_000 }],
          ]),
          () => manager.running
        );
        expect(purchases()).toEqual([]);
        expect(result.rebought.size).toBe(0);
        expect(pending.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('the existing lifecycle drain waits for the retained physical purchase response', async () => {
    const user = willing[0];
    const manager = setup({ offers: [user] });
    const normal = fixture.rpc.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.rpc.mockImplementation(async (name: string, args: unknown) => {
      if (name === 'process_tournament_rebuy') await held;
      return normal(name, args);
    });
    await manager.answerOpenHorseRebuyOffers(false);
    expect(manager.lifecycleJobs.size).toBe(1);
    expect(manager.horseRebuyPending.size).toBe(1);
    let drained = false;
    const drain = manager.drainLifecycleJobs().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    manager.running = false; // stop fences fresh input; it still owes the original response
    release();
    await drain;
    expect(manager.lifecycleJobs.size).toBe(0);
    expect(manager.horseRebuyPending.size).toBe(0);
    expect(purchases()).toEqual([user]);
  });

  it('closes a spent free-buy offer without submitting a new purchase', async () => {
    const userId = willing[0]!;
    await setup({ offers: [userId], freeBuyUsed: 100 }).answerOpenHorseRebuyOffers();
    expect(declines()).toEqual([{ p_tournament_id: event, p_user_id: userId }]);
    expect(purchases()).toEqual([]);
  });

  it('persists an earlier decline before waiting on a later purchase in the same batch', async () => {
    const no = declining[0]!;
    const yes = willing[0]!;
    const manager = setup({ offers: [no, yes] });
    let release!: () => void;
    fixture.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
      if (name === 'fn_decline_tournament_rebuy') return { data: { ok: true }, error: null };
      if (name === 'process_tournament_rebuy') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { data: { success: true }, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const answering = manager.answerOpenHorseRebuyOffers();
    await vi.waitFor(() => expect(purchases()).toEqual([yes]));
    try {
      expect(declines()).toEqual([{ p_tournament_id: event, p_user_id: no }]);
    } finally {
      release();
      await answering;
    }
  });

  it('does not turn a lost decline response into a purchase or a new retry loop', async () => {
    const manager = setup({ offers: [declining[0]!] });
    fixture.rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
      if (name === 'fn_decline_tournament_rebuy') throw new Error('response lost');
      throw new Error(`unexpected rpc ${name}`);
    });
    expect(await manager.answerOpenHorseRebuyOffers()).toBe(false);
    expect(declines()).toHaveLength(1);
    expect(purchases()).toEqual([]);
    expect(manager.requestUrgentEliminationSweepAfter).not.toHaveBeenCalled();
    const { reportError } = await import('../services/errorReporter.js');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'Tournament.horse_rebuy_decline_threw'
    );
  });

  it.each(['freeze', 'stop'] as const)(
    'does not start a later purchase when %s wins during a decline',
    async (mode) => {
      const manager = setup({ offers: [declining[0]!, willing[0]!] });
      fixture.rpc.mockImplementation(async (name: string) => {
        if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
        if (name === 'fn_decline_tournament_rebuy') {
          if (mode === 'freeze') fixture.frozen = true;
          else manager.running = false;
          return { data: { ok: true }, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      });
      await manager.answerOpenHorseRebuyOffers();
      expect(declines()).toHaveLength(1);
      expect(purchases()).toEqual([]);
    }
  );

  it('asks again while a willing horse is unanswered, and not for a human', async () => {
    expect(await setup({ purchase: 'transport' }).answerOpenHorseRebuyOffers()).toBe(true);
    vi.clearAllMocks();
    const humansOnly = setup({ horses: [], purchase: 'transport' });
    expect(await humansOnly.answerOpenHorseRebuyOffers()).toBe(false);
    expect(purchases()).toEqual([]);
  });

  it.each(['error', 'throw', 'null'] as const)(
    'keeps the existing bounded input continuation when profile identification returns %s',
    async (profileFailure) => {
      vi.useFakeTimers();
      try {
        const options = {
          offers: [willing[0]!],
          profileFailure: profileFailure as typeof profileFailure | undefined,
        };
        const manager = setup(options);
        manager.horseRebuyOfferMayHaveOpened();
        await vi.advanceTimersByTimeAsync(0);
        expect(purchases()).toEqual([]);
        expect(declines()).toEqual([]);
        options.profileFailure = undefined;
        await vi.advanceTimersByTimeAsync(2_000);
        expect(purchases()).toEqual([willing[0]!]);
        expect(manager.horseRebuyInputTimer).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('bounds persistent profile failures without purchasing or declining', async () => {
    vi.useFakeTimers();
    try {
      const manager = setup({ profileFailure: 'error' });
      manager.horseRebuyOfferMayHaveOpened();
      await vi.advanceTimersByTimeAsync(40_000);
      const reads = fixture.from.mock.calls.filter(([table]) => table === 'profiles');
      expect(reads).toHaveLength(TournamentManagerEliminations.HORSE_REBUY_INPUT_MAX_PASSES);
      expect(manager.horseRebuyInputTimer).toBeNull();
      expect(purchases()).toEqual([]);
      expect(declines()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers to the maintenance freeze and to manager stop', async () => {
    fixture.frozen = true;
    expect(await setup().answerOpenHorseRebuyOffers()).toBe(false);
    fixture.frozen = false;
    const stopped = setup();
    stopped.running = false;
    expect(await stopped.answerOpenHorseRebuyOffers()).toBe(false);
    expect(purchases()).toEqual([]);
  });

  it('does nothing for an event without rebuys or with no open offer', async () => {
    const noRebuy = setup();
    noRebuy.tournamentCache = { is_rebuy: false, is_reentry: false };
    expect(await noRebuy.answerOpenHorseRebuyOffers()).toBe(false);
    expect(await setup({ offers: [] }).answerOpenHorseRebuyOffers()).toBe(false);
    expect(purchases()).toEqual([]);
  });

  it('re-asks every two seconds while unanswered and stops within the offer lifetime', async () => {
    vi.useFakeTimers();
    try {
      const manager = setup({ purchase: 'transport' });
      manager.horseRebuyOfferMayHaveOpened();
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(1_000);
      const passes = fixture.rpc.mock.calls.filter(
        (call) => call[0] === 'fn_ca_tournament_rebuy_window'
      ).length;
      expect(TournamentManagerEliminations.HORSE_REBUY_INPUT_RETRY_MS).toBe(2_000);
      expect(passes).toBe(TournamentManagerEliminations.HORSE_REBUY_INPUT_MAX_PASSES);
      expect(
        TournamentManagerEliminations.HORSE_REBUY_INPUT_MAX_PASSES *
          TournamentManagerEliminations.HORSE_REBUY_INPUT_RETRY_MS
      ).toBeLessThanOrEqual(32_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of busts into one pass at a time', async () => {
    const manager = setup();
    manager.horseRebuyOfferMayHaveOpened();
    manager.horseRebuyOfferMayHaveOpened();
    manager.horseRebuyOfferMayHaveOpened();
    await vi.waitFor(() => expect(manager.horseRebuyInputInFlight).toBe(false));
    const windowReads = fixture.rpc.mock.calls.filter(
      (call) => call[0] === 'fn_ca_tournament_rebuy_window'
    ).length;
    expect(windowReads).toBe(2); // the first pass, then one coalesced re-run
  });

  it('is woken by the zero-stack hand itself, before the sweep is requested', () => {
    const base = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
    expect(base).toMatch(
      /this\.bustAwaitsItsStage\(\);\s*this\.horseRebuyOfferMayHaveOpened\(\);\s*this\.requestEliminationSweep\(\);/
    );
    const elim = readFileSync(join(here, 'TournamentManagerEliminations.ts'), 'utf8');
    expect(elim).toContain('protected override horseRebuyOfferMayHaveOpened(): void {');
    // The input device is never admitted through the elimination scheduler.
    const device = elim.slice(
      elim.indexOf('private answerHorseRebuyOffersNow('),
      elim.indexOf('private async tryTournamentRebuys(')
    );
    expect(device).not.toMatch(/tournamentEliminationScheduler|eliminationMutationAllowed\(\)/);
    expect(device).toContain('const mayAnswer = () => this.running && !isMaintenanceFrozen();');
  });
});
