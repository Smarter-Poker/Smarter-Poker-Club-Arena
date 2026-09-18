import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Result = {
    data: unknown;
    error: { message: string } | null;
    count?: number | null;
  };
  const responses = new Map<string, Result | PromiseLike<Result>>();
  const rangeResponses = new Map<string, Result | PromiseLike<Result>>();
  const calls: string[] = [];
  const admission = { abi: 'legacy-capacity-v1', cap: undefined as number | null | undefined };
  const reportError = vi.fn();
  const from = vi.fn((table: string) => {
    calls.push(table);
    let requestedRange: string | null = null;
    const result = async (): Promise<Result> => {
      const resolved = await ((requestedRange
        ? rangeResponses.get(`${table}:${requestedRange}`)
        : undefined) ??
        responses.get(table) ?? { data: [], error: null });
      return table === 'tournament_players' && resolved.count === undefined
        ? {
            ...resolved,
            count: Array.isArray(resolved.data) ? resolved.data.length : null,
          }
        : resolved;
    };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'in']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.range = vi.fn((from: number, to: number) => {
      requestedRange = `${from}-${to}`;
      return chain;
    });
    chain.maybeSingle = vi.fn(() => result());
    chain.then = (
      resolve: (value: Result) => unknown,
      reject: (reason: unknown) => unknown
    ): Promise<unknown> => result().then(resolve, reject);
    return chain;
  });
  return { responses, rangeResponses, calls, reportError, from, admission };
});

vi.mock('./supabase.js', () => ({
  supabase: {
    from: h.from,
    rpc: vi.fn(async (name, args) => {
      if (name !== 'fn_ca_tournament_admission_snapshot') throw new Error(`Unexpected RPC ${name}`);
      const result = await h.responses.get('tournaments');
      const row = result?.data as any;
      return {
        error: null,
        data: {
          ok: true,
          admission_abi: h.admission.abi,
          entries: args.p_tournament_ids.map((id: string) => ({
            tournament_id: id,
            format_contract: row.format_contract,
            effective_max_players:
              h.admission.cap === undefined ? row.max_players : h.admission.cap,
          })),
        },
      };
    }),
  },
}));
vi.mock('./errorReporter.js', () => ({ reportError: h.reportError }));

import {
  __clearTournamentBrainCache,
  getTournamentBrainContextSnapshot,
  refreshTournamentBrainContext,
} from './TournamentBrainContext.js';
import { TOURNAMENT_CONTEXT_INCOMPLETE } from '../engine/HorseTournamentPreflop.js';
import { horseRebuyAllowance } from './FreeBuy.js';

const NOW = Date.parse('2026-09-09T18:00:00.000Z');

function tournamentRow() {
  return {
    format_contract: 'mtt-v1',
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
  h.rangeResponses.clear();
  h.calls.length = 0;
  h.admission.abi = 'legacy-capacity-v1';
  h.admission.cap = undefined;
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

  it.each([
    ['legacy-capacity-v1', 3, false],
    ['unlimited-mtt-v2', null, true],
  ] as const)(
    'uses the %s admission projection for a full recorded MTT',
    async (abi, cap, open) => {
      successfulResponses();
      h.responses.set('tournaments', {
        data: { ...tournamentRow(), max_players: 3 },
        error: null,
      });
      h.admission.abi = abi;
      h.admission.cap = cap;
      refreshTournamentBrainContext('t-authoritative-capacity');
      await settleRefresh();
      const snapshot = getTournamentBrainContextSnapshot('t-authoritative-capacity');
      expect(snapshot.status).toBe('complete');
      expect(snapshot.context?.lateRegistrationOpen).toBe(open);
    }
  );

  it('does not count a zero-chip playing row as a live ICM stack while elimination status catches up', async () => {
    successfulResponses();
    h.responses.set('tournament_players', {
      data: [
        { user_id: 'horse-1', chips: 1500, status: 'playing', current_bounty: 12.34 },
        { user_id: 'horse-2', chips: 2500, status: 'playing', current_bounty: 5 },
        {
          user_id: 'busted-status-lag',
          chips: 0,
          status: 'playing',
          current_bounty: 99,
          rebuys: 1,
          add_on: true,
          rebuy_prompt_until: new Date(NOW - 1).toISOString(),
        },
      ],
      error: null,
    });

    refreshTournamentBrainContext('t-zero-chip-status-lag');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-zero-chip-status-lag');
    expect(snapshot.status).toBe('complete');
    expect(snapshot.context).toMatchObject({
      entrants: 3,
      playersLeft: 2,
      avgStackChips: 2000,
      stacks: [2500, 1500],
      stackByUser: { 'horse-1': 1500, 'horse-2': 2500 },
      meanBountyCents: 867,
      bountyByUser: { 'horse-1': 1234, 'horse-2': 500 },
      reloadsByUser: { 'horse-1': 0, 'horse-2': 0, 'busted-status-lag': 1 },
      addOnTakenByUser: {
        'horse-1': false,
        'horse-2': false,
        'busted-status-lag': true,
      },
    });
    expect(snapshot.context?.stackByUser).not.toHaveProperty('busted-status-lag');
    expect(snapshot.context?.bountyByUser).not.toHaveProperty('busted-status-lag');
    expect(snapshot.context?.stacks).toHaveLength(snapshot.context?.playersLeft ?? -1);

    // The same durable roster row becomes live again as soon as the atomic
    // recovery transaction credits its stack; no status transition is needed
    // for the field cache to reconcile the player back into Phase 7.
    vi.setSystemTime(NOW + 20_001);
    h.responses.set('tournament_players', {
      data: [
        { user_id: 'horse-1', chips: 1500, status: 'playing', current_bounty: 12.34 },
        { user_id: 'horse-2', chips: 2500, status: 'playing', current_bounty: 5 },
        {
          user_id: 'busted-status-lag',
          chips: 1000,
          status: 'playing',
          current_bounty: 99,
          rebuys: 2,
          add_on: true,
        },
      ],
      error: null,
    });
    refreshTournamentBrainContext('t-zero-chip-status-lag');
    await settleRefresh();

    expect(
      getTournamentBrainContextSnapshot('t-zero-chip-status-lag', NOW + 20_001).context
    ).toMatchObject({
      playersLeft: 3,
      avgStackChips: 5000 / 3,
      stacks: [2500, 1500, 1000],
      stackByUser: {
        'horse-1': 1500,
        'horse-2': 2500,
        'busted-status-lag': 1000,
      },
      reloadsByUser: { 'horse-1': 0, 'horse-2': 0, 'busted-status-lag': 2 },
      bountyByUser: { 'horse-1': 1234, 'horse-2': 500, 'busted-status-lag': 9900 },
    });
  });

  it('fails closed while a zero-stack player still owns an unexpired recovery decision', async () => {
    successfulResponses();
    h.responses.set('tournaments', {
      data: {
        ...tournamentRow(),
        buy_in_amount: 10,
        starting_chips: 1_000,
        rebuy_cost: 10,
        rebuy_chips: 1_000,
        is_rebuy: true,
        rebuy_levels: 2,
        max_rebuys: 2,
      },
      error: null,
    });
    h.responses.set('tournament_players', {
      data: [
        { user_id: 'horse-1', chips: 1500, status: 'playing', current_bounty: 12.34 },
        { user_id: 'horse-2', chips: 2500, status: 'playing', current_bounty: 5 },
        {
          user_id: 'recovery-pending',
          chips: 0,
          status: 'playing',
          current_bounty: 99,
          rebuys: 1,
          add_on: false,
          rebuy_prompt_until: new Date(NOW + 30_000).toISOString(),
        },
      ],
      error: null,
    });

    refreshTournamentBrainContext('t-open-recovery');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-open-recovery');
    expect(snapshot.status).toBe('incomplete');
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'live_field_recovery_pending',
        'live_field_stack_cardinality_mismatch',
      ])
    );
    expect(snapshot.context).toMatchObject({
      contextStatus: 'incomplete',
      playersLeft: 3,
      stacks: [2500, 1500],
      stackByUser: { 'horse-1': 1500, 'horse-2': 2500 },
      reloadsByUser: { 'horse-1': 0, 'horse-2': 0, 'recovery-pending': 1 },
    });
    expect(snapshot.context?.stackByUser).not.toHaveProperty('recovery-pending');
  });

  it('fails closed instead of inventing an ICM field when every nonterminal row is zero', async () => {
    successfulResponses();
    h.responses.set('tournament_players', {
      data: [
        { user_id: 'zero-1', chips: 0, status: 'playing', current_bounty: 0 },
        { user_id: 'zero-2', chips: -1, status: 'registered', current_bounty: 0 },
      ],
      error: null,
    });

    refreshTournamentBrainContext('t-all-zero');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-all-zero');
    expect(snapshot.status).toBe('incomplete');
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        TOURNAMENT_CONTEXT_INCOMPLETE,
        'player_population_invalid',
        'live_stack_distribution_missing',
      ])
    );
    expect(snapshot.context).toMatchObject({
      contextStatus: 'incomplete',
      entrants: 2,
      playersLeft: 0,
      avgStackChips: 0,
      stacks: [],
      stackByUser: {},
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

  it('pages the complete roster instead of truncating a field at the first 1,000 rows', async () => {
    h.responses.set('tournaments', {
      data: { ...tournamentRow(), max_players: 2_000 },
      error: null,
    });
    const players = Array.from({ length: 1_001 }, (_, index) => ({
      user_id: `player-${String(index).padStart(4, '0')}`,
      chips: 1_000,
      status: 'active',
      current_bounty: 0,
    }));
    h.rangeResponses.set('tournament_players:0-999', {
      data: players.slice(0, 1_000),
      error: null,
      count: players.length,
    });
    h.rangeResponses.set('tournament_players:1000-1999', {
      data: players.slice(1_000),
      error: null,
    });
    h.responses.set('tournament_bounty_chests', { data: [], error: null });
    h.responses.set('tournament_satellite_entitlements', { data: [], error: null });

    refreshTournamentBrainContext('t-large');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-large');
    expect(snapshot.status).toBe('complete');
    expect(snapshot.context?.entrants).toBe(1_001);
    expect(snapshot.context?.playersLeft).toBe(1_001);
    expect(snapshot.context?.stacks).toHaveLength(1_001);
    expect(Object.keys(snapshot.context?.stackByUser ?? {})).toHaveLength(1_001);
    expect(snapshot.context?.stackByUser['player-1000']).toBe(1_000);
    expect(h.calls.filter((table) => table === 'tournament_players')).toHaveLength(2);
  });

  it('caches exact recovery affordability from each player funding club off the action clock', async () => {
    const row = {
      ...tournamentRow(),
      buy_in_amount: 90,
      buy_in_fee: 10,
      starting_chips: 1_000,
      rebuy_cost: 100,
      rebuy_chips: 1_000,
      // The canonical RPC preserves the head to cents after rounding the total charge.
      bounty_amount: 40.5,
      is_rebuy: true,
      rebuy_levels: 2,
      max_rebuys: 2,
      add_on_available: true,
      addon_cost: 50,
      addon_chips: 500,
      addon_levels: 1,
      addon_period_triggered: true,
      addon_period_started_at: new Date(NOW - 60_000).toISOString(),
      addon_period_ends_at: new Date(NOW + 60_000).toISOString(),
    };
    h.responses.set('tournaments', { data: row, error: null });
    h.responses.set('tournament_players', {
      data: [
        {
          user_id: 'horse-funded',
          club_id: 'club-a',
          chips: 1_500,
          status: 'active',
          current_bounty: 40,
          rebuys: 1,
          add_on: false,
        },
        {
          user_id: 'horse-short',
          club_id: 'club-a',
          chips: 1_000,
          status: 'active',
          current_bounty: 40,
          rebuys: 0,
          add_on: false,
        },
      ],
      error: null,
    });
    h.responses.set('tournament_bounty_chests', { data: [], error: null });
    h.responses.set('tournament_satellite_entitlements', { data: [], error: null });
    h.responses.set('club_members', {
      data: [
        { user_id: 'horse-funded', club_id: 'club-a', chip_balance: 100 },
        { user_id: 'horse-short', club_id: 'club-a', chip_balance: 49 },
      ],
      error: null,
    });

    refreshTournamentBrainContext('t-funded');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-funded');
    expect(snapshot.status).toBe('complete');
    expect(snapshot.context).toMatchObject({
      rebuyCostCents: 10_000,
      rebuyPrizeContributionCents: 4_950,
      rebuyBountyContributionCents: 4_050,
      rebuyAffordableByUser: { 'horse-funded': true, 'horse-short': false },
      addOnAffordableByUser: { 'horse-funded': true, 'horse-short': false },
    });
    expect(h.calls).toContain('club_members');
  });

  it('mirrors the purchase authority when zero chip grants fall back to the starting stack', async () => {
    const row = {
      ...tournamentRow(),
      free_buy: true,
      buy_in_amount: 90,
      buy_in_fee: 10,
      starting_chips: 1_000,
      rebuy_cost: 0,
      rebuy_chips: 0,
      is_rebuy: true,
      rebuy_levels: 2,
      max_rebuys: 2,
      add_on_available: true,
      addon_cost: 0,
      addon_chips: 0,
      addon_levels: 1,
    };
    h.responses.set('tournaments', { data: row, error: null });
    h.responses.set('tournament_players', {
      data: [
        {
          user_id: 'horse-funded',
          club_id: 'club-a',
          chips: 1_000,
          status: 'active',
          current_bounty: 0,
          rebuys: 0,
          add_on: false,
        },
      ],
      error: null,
    });
    h.responses.set('tournament_bounty_chests', { data: [], error: null });
    h.responses.set('tournament_satellite_entitlements', { data: [], error: null });
    h.responses.set('club_members', {
      data: [{ user_id: 'horse-funded', club_id: 'club-a', chip_balance: 100 }],
      error: null,
    });

    refreshTournamentBrainContext('t-zero-fallback');
    await settleRefresh();

    expect(getTournamentBrainContextSnapshot('t-zero-fallback').context).toMatchObject({
      rebuyCostCents: 9_000,
      rebuyChips: 1_000,
      addOnCost: 90,
      addOnChips: 1_000,
      horseRebuyCapByUser: {
        'horse-funded': Math.min(2, horseRebuyAllowance('horse-funded', 't-zero-fallback')),
      },
    });
  });

  it('applies the deterministic Free Buy cap to a re-entry-only product', async () => {
    const row = {
      ...tournamentRow(),
      free_buy: true,
      buy_in_amount: 10,
      buy_in_fee: 0,
      starting_chips: 1_000,
      rebuy_cost: 10,
      rebuy_chips: 1_000,
      is_rebuy: false,
      max_rebuys: 0,
      is_reentry: true,
      max_reentries: 3,
    };
    h.responses.set('tournaments', { data: row, error: null });
    h.responses.set('tournament_players', {
      data: [
        {
          user_id: 'horse-reentry',
          club_id: 'club-a',
          chips: 1_000,
          status: 'active',
          current_bounty: 0,
          rebuys: 0,
          add_on: false,
        },
      ],
      error: null,
    });
    h.responses.set('tournament_bounty_chests', { data: [], error: null });
    h.responses.set('tournament_satellite_entitlements', { data: [], error: null });
    h.responses.set('club_members', {
      data: [{ user_id: 'horse-reentry', club_id: 'club-a', chip_balance: 10 }],
      error: null,
    });

    refreshTournamentBrainContext('t-reentry-only');
    await settleRefresh();

    expect(getTournamentBrainContextSnapshot('t-reentry-only').context).toMatchObject({
      horseRebuyCapByUser: {
        'horse-reentry': Math.min(3, horseRebuyAllowance('horse-reentry', 't-reentry-only')),
      },
    });
  });

  it('invalidates affordability on a funding failure without discarding fresh ICM context', async () => {
    const row = {
      ...tournamentRow(),
      buy_in_amount: 100,
      starting_chips: 1_000,
      rebuy_cost: 100,
      rebuy_chips: 1_000,
      is_rebuy: true,
      rebuy_levels: 2,
      max_rebuys: 2,
    };
    h.responses.set('tournaments', { data: row, error: null });
    h.responses.set('tournament_players', {
      data: [
        {
          user_id: 'horse-1',
          club_id: 'club-a',
          chips: 1_000,
          status: 'active',
          current_bounty: 0,
          rebuys: 0,
          add_on: false,
        },
        {
          user_id: 'horse-2',
          club_id: 'club-a',
          chips: 2_000,
          status: 'active',
          current_bounty: 0,
          rebuys: 0,
          add_on: false,
        },
      ],
      error: null,
    });
    h.responses.set('tournament_bounty_chests', { data: [], error: null });
    h.responses.set('tournament_satellite_entitlements', { data: [], error: null });
    h.responses.set('club_members', {
      data: [
        { user_id: 'horse-1', club_id: 'club-a', chip_balance: 100 },
        { user_id: 'horse-2', club_id: 'club-a', chip_balance: 100 },
      ],
      error: null,
    });
    refreshTournamentBrainContext('t-funding-failure');
    await settleRefresh();
    expect(
      getTournamentBrainContextSnapshot('t-funding-failure').context?.rebuyAffordableByUser
    ).toEqual({ 'horse-1': true, 'horse-2': true });

    vi.setSystemTime(NOW + 20_001);
    h.responses.set('club_members', {
      data: null,
      error: { message: 'wallet read failed' },
    });
    refreshTournamentBrainContext('t-funding-failure');
    await settleRefresh();

    const snapshot = getTournamentBrainContextSnapshot('t-funding-failure', NOW + 20_001);
    expect(snapshot.status).toBe('complete');
    expect(snapshot.context?.stacks).toEqual([2_000, 1_000]);
    expect(snapshot.context?.rebuyAffordableByUser).toEqual({});
    expect(snapshot.context?.addOnAffordableByUser).toEqual({});
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'TournamentBrainContext.recovery_funding_unavailable'
    );
  });
});
