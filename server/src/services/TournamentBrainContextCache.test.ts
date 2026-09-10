import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Result = { data: unknown; error: { message: string } | null };
  const responses = new Map<string, Result | PromiseLike<Result>>();
  const calls: string[] = [];
  const reportError = vi.fn();
  const from = vi.fn((table: string) => {
    calls.push(table);
    const result = (): Result | PromiseLike<Result> =>
      responses.get(table) ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result()));
    chain.then = (
      resolve: (value: Result) => unknown,
      reject: (reason: unknown) => unknown
    ): Promise<unknown> => Promise.resolve(result()).then(resolve, reject);
    return chain;
  });
  return { responses, calls, reportError, from };
});

vi.mock('./supabase.js', () => ({ supabase: { from: h.from } }));
vi.mock('./errorReporter.js', () => ({ reportError: h.reportError }));

import {
  __clearTournamentBrainCache,
  getTournamentBrainContextSnapshot,
  refreshTournamentBrainContext,
} from './TournamentBrainContext.js';
import { TOURNAMENT_CONTEXT_INCOMPLETE } from '../engine/HorseTournamentPreflop.js';

const NOW = Date.parse('2026-09-09T18:00:00.000Z');

function tournamentRow() {
  return {
    tournament_type: 'MTT',
    status: 'RUNNING',
    game_type: 'NLH',
    variant: 'freezeout',
    max_players: 100,
    table_size: 6,
    payout_structure: [
      { place: 1, percentage: 50 },
      { place: 2, percentage: 30 },
      { place: 3, percentage: 20 },
    ],
    spin_multiplier: null,
    prize_pool: 10_000,
    prize_pool_finalized: false,
    bounty_pool: 1000,
    is_pko: true,
    is_bounty: true,
    is_mystery_bounty: false,
    blind_structure: JSON.stringify([
      { level: 1, smallBlind: 50, bigBlind: 100, ante: 100, durationMinutes: 10 },
      { level: 2, smallBlind: 100, bigBlind: 200, ante: 200, durationMinutes: 10 },
    ]),
    current_level: 0,
    level_started_at: new Date(NOW - 2 * 60_000).toISOString(),
    started_at: new Date(NOW - 8 * 60_000).toISOString(),
    late_reg_mins: 30,
    late_reg_levels: 2,
    is_reentry: false,
    max_reentries: 0,
    is_rebuy: false,
    rebuy_levels: 0,
    max_rebuys: 0,
    add_on_available: false,
    addon_cost: null,
    addon_chips: null,
    addon_levels: null,
    addon_period_triggered: false,
    addon_period_started_at: null,
    addon_period_ends_at: null,
    on_break: false,
    break_started_at: null,
    break_ends_at: null,
    accelerated_mtt: false,
    big_blind_ante: true,
    authorized_to_register: false,
    satellite_seats: 0,
    satellite_target_id: null,
    satellite_target: null,
  };
}

function successfulResponses(): void {
  h.responses.set('tournaments', { data: tournamentRow(), error: null });
  h.responses.set('tournament_players', {
    data: [
      { user_id: 'horse-1', chips: 1500, status: 'active', current_bounty: 12.34 },
      { user_id: 'horse-2', chips: 2500, status: 'active', current_bounty: 5 },
      { user_id: 'horse-3', chips: 0, status: 'eliminated', current_bounty: 99 },
    ],
    error: null,
  });
  h.responses.set('tournament_bounty_chests', { data: [], error: null });
  h.responses.set('tournament_satellite_entitlements', { data: [], error: null });
}

async function settleRefresh(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __clearTournamentBrainCache();
  h.responses.clear();
  h.calls.length = 0;
  h.from.mockClear();
  h.reportError.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TournamentBrainContext lifecycle cache', () => {
  it('keeps an action-clock snapshot pure and explicitly labels an unstarted refresh', () => {
    expect(getTournamentBrainContextSnapshot('t-1')).toEqual({
      context: null,
      status: 'incomplete',
      issues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_context_refresh_not_started'],
      ageMs: null,
    });
    expect(h.from).not.toHaveBeenCalled();
  });

  it('publishes one coherent four-read context and converts whole-unit bounties to cents', async () => {
    successfulResponses();
    expect(refreshTournamentBrainContext('t-2')).toBeNull();
    expect(getTournamentBrainContextSnapshot('t-2')).toMatchObject({
      context: null,
      status: 'warming',
      issues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_context_warming'],
    });

    await settleRefresh();
    const snapshot = getTournamentBrainContextSnapshot('t-2');
    expect(h.calls).toEqual([
      'tournaments',
      'tournament_players',
      'tournament_bounty_chests',
      'tournament_satellite_entitlements',
    ]);
    expect(snapshot.status).toBe('complete');
    expect(snapshot.context).toMatchObject({
      contextStatus: 'complete',
      entrants: 3,
      playersLeft: 2,
      avgStackChips: 2000,
      meanBountyCents: 867,
      bountyByUser: { 'horse-1': 1234, 'horse-2': 500 },
    });
  });

  it('turns a failed first read into an explicit incomplete state instead of warming forever', async () => {
    successfulResponses();
    h.responses.set('tournaments', {
      data: null,
      error: { message: 'database unavailable' },
    });
    refreshTournamentBrainContext('t-3');
    await settleRefresh();

    expect(getTournamentBrainContextSnapshot('t-3')).toEqual({
      context: null,
      status: 'incomplete',
      issues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_context_refresh_failed'],
      ageMs: null,
    });
    expect(h.reportError).toHaveBeenCalled();
  });

  it('times out the whole refresh and generation-fences its late result', async () => {
    successfulResponses();
    let resolveTournament!: (value: { data: unknown; error: null }) => void;
    const delayed = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveTournament = resolve;
    });
    h.responses.set('tournaments', delayed);
    refreshTournamentBrainContext('t-4');
    await vi.advanceTimersByTimeAsync(5000);
    await settleRefresh();
    expect(getTournamentBrainContextSnapshot('t-4').issues).toContain(
      'tournament_context_refresh_timed_out'
    );

    // A new lifecycle attempt owns a higher generation. The timed-out result
    // may settle later, but can no longer publish over the new snapshot.
    vi.setSystemTime(NOW + 61_001);
    successfulResponses();
    refreshTournamentBrainContext('t-4');
    await settleRefresh();
    const fresh = getTournamentBrainContextSnapshot('t-4', NOW + 61_001);
    expect(fresh.context?.bountyByUser).toEqual({ 'horse-1': 1234, 'horse-2': 500 });

    resolveTournament({ data: { ...tournamentRow(), game_type: 'PLO6' }, error: null });
    await settleRefresh();
    expect(getTournamentBrainContextSnapshot('t-4', NOW + 61_001).context?.gameVariant).toBe('nlh');
  });

  it('uses a strict greater-than stale boundary at 60 seconds', async () => {
    successfulResponses();
    refreshTournamentBrainContext('t-5');
    await settleRefresh();

    expect(getTournamentBrainContextSnapshot('t-5', NOW + 60_000).status).toBe('complete');
    const stale = getTournamentBrainContextSnapshot('t-5', NOW + 60_001);
    expect(stale.status).toBe('stale');
    expect(stale.issues).toContain('tournament_context_stale');
  });
});
