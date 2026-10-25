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

function setup(opts: { horses?: string[]; offers?: string[]; purchase?: Purchase } = {}) {
  const horses = opts.horses ?? ids;
  const offers = opts.offers ?? ids;
  const purchase = opts.purchase ?? 'ok';
  const manager = Object.assign(Object.create(TournamentManagerEliminations.prototype), {
    tournamentId: event,
    tournamentCache: { is_rebuy: true, is_reentry: true, free_buy: false },
    currentLevel: 3,
    running: true,
    // The sweep's own budget is long spent: the horse must not depend on it.
    eliminationSweepDeadlineAt: 1,
    eliminationMutationBatchOpen: false,
    requestEliminationSweep: vi.fn(),
    requestUrgentEliminationSweepAfter: vi.fn(),
  });
  fixture.from.mockImplementation((table: string) => {
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
      q.eq = vi.fn(async () => ({
        data: asked.filter((id) => horses.includes(id)).map((id) => ({ id })),
        error: null,
      }));
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  fixture.rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_ca_tournament_rebuy_window') return { data: { open: true }, error: null };
    if (name === 'process_tournament_rebuy') {
      return purchase === 'ok'
        ? { data: { success: true }, error: null }
        : { data: null, error: { message: 'fetch failed' } };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return manager;
}

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

  it('asks again while a willing horse is unanswered, and not for a human', async () => {
    expect(await setup({ purchase: 'transport' }).answerOpenHorseRebuyOffers()).toBe(true);
    vi.clearAllMocks();
    const humansOnly = setup({ horses: [], purchase: 'transport' });
    expect(await humansOnly.answerOpenHorseRebuyOffers()).toBe(false);
    expect(purchases()).toEqual([]);
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
