import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderboardProgramHistoryEntry } from '../../src/services/LeaderboardService';

const db = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'in']) {
        chain[method] = (...args: unknown[]) => {
          db.calls.push({ table, method, args });
          return chain;
        };
      }
      chain.then = (resolve: (value: unknown) => void) =>
        resolve(db.tables[table] ?? { data: null, error: null });
      return chain;
    },
    rpc: vi.fn(),
  },
}));

import { LeaderboardService } from '../../src/services/LeaderboardService';
import { describeProgramChanges } from '../../src/utils/leaderboardProgramHistory';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'program-3',
  club_id: 'club-1',
  version: 3,
  published_at: '2026-09-18T15:42:00+00:00',
  published_by: 'owner-1',
  rewards_enabled: true,
  payout_metric: 'profit',
  suggestion_key: 'balanced',
  weekly_prizes: [
    { rank: 1, amount: 250 },
    { rank: 2, amount: 150 },
    { rank: 3, amount: 100 },
  ],
  monthly_prizes: [{ rank: 1, amount: 2000 }],
  weekly_effective_from: '2026-09-20',
  monthly_effective_from: '2026-10-01',
  funding_owner_type: 'union',
  ...overrides,
});

const entry = (overrides: Partial<LeaderboardProgramHistoryEntry> = {}) =>
  ({
    ...row(),
    publisher_name: 'KingFish',
    ...overrides,
  }) as LeaderboardProgramHistoryEntry;

describe('describeProgramChanges', () => {
  it('calls version 1 the first plan, and says nothing about an older version it never read', () => {
    expect(describeProgramChanges(entry({ version: 1 }), undefined)).toEqual([
      'First Published Plan',
    ]);
    expect(describeProgramChanges(entry({ version: 3 }), undefined)).toEqual([]);
  });

  it('names what an owner changed against the version it superseded', () => {
    const before = entry({
      version: 2,
      rewards_enabled: false,
      payout_metric: 'roi',
      weekly_prizes: [],
    });
    expect(describeProgramChanges(entry(), before)).toEqual([
      'Prizes Enabled',
      'Ranked By Profit (Was ROI)',
      'Weekly 0 To 500 Chips',
    ]);
    expect(
      describeProgramChanges(entry({ suggestion_key: 'top_heavy' }), entry({ version: 2 }))
    ).toEqual(['Top Heavy Split (Was Balanced Podium)']);
  });

  it('never prints a total change that reads as no change', () => {
    // 1,290 and 1,250 both print 1.2K in the house compact format.
    const before = entry({ version: 2, monthly_prizes: [{ rank: 1, amount: 1250 }] });
    const after = entry({ monthly_prizes: [{ rank: 1, amount: 1290 }] });
    expect(describeProgramChanges(after, before)).toEqual(['Monthly Prizes Adjusted']);
  });

  it('tells a rearrangement from a republish', () => {
    const before = entry({ version: 2 });
    const moved = entry({
      weekly_prizes: [
        { rank: 1, amount: 300 },
        { rank: 2, amount: 100 },
        { rank: 3, amount: 100 },
      ],
    });
    expect(describeProgramChanges(moved, before)).toEqual(['Prize Places Rearranged']);
    expect(describeProgramChanges(entry(), before)).toEqual(['Republished Without Changes']);
  });
});

describe('LeaderboardService.getRewardProgramHistory', () => {
  beforeEach(() => {
    db.tables = {};
    db.calls = [];
  });

  it('reads the club versions newest first and names each publisher once', async () => {
    db.tables.leaderboard_reward_program_versions = {
      data: [row(), row({ id: 'program-2', version: 2, published_by: 'owner-1' })],
      error: null,
    };
    db.tables.profiles = { data: [{ id: 'owner-1', username: 'KingFish' }], error: null };

    const history = await LeaderboardService.getRewardProgramHistory('club-1', 7);

    expect(history.map((item) => [item.version, item.publisher_name])).toEqual([
      [3, 'KingFish'],
      [2, 'KingFish'],
    ]);
    const versionsRead = db.calls.filter(
      (call) => call.table === 'leaderboard_reward_program_versions'
    );
    expect(versionsRead).toContainEqual({
      table: 'leaderboard_reward_program_versions',
      method: 'eq',
      args: ['club_id', 'club-1'],
    });
    expect(versionsRead).toContainEqual({
      table: 'leaderboard_reward_program_versions',
      method: 'order',
      args: ['version', { ascending: false }],
    });
    expect(versionsRead).toContainEqual({
      table: 'leaderboard_reward_program_versions',
      method: 'limit',
      args: [7],
    });
    expect(db.calls).toContainEqual({ table: 'profiles', method: 'in', args: ['id', ['owner-1']] });
  });

  it('keeps the history when publisher names cannot be read', async () => {
    db.tables.leaderboard_reward_program_versions = { data: [row()], error: null };
    db.tables.profiles = { data: null, error: { message: 'profiles unavailable' } };

    const history = await LeaderboardService.getRewardProgramHistory('club-1', 7);

    expect(history).toHaveLength(1);
    expect(history[0].publisher_name).toBeNull();
  });

  it('fails the read instead of painting a malformed or foreign version', async () => {
    db.tables.leaderboard_reward_program_versions = {
      data: [row({ weekly_prizes: [{ rank: 0, amount: 5 }] })],
      error: null,
    };
    await expect(LeaderboardService.getRewardProgramHistory('club-1', 7)).rejects.toThrow(
      'Program History Returned Invalid Data'
    );

    db.tables.leaderboard_reward_program_versions = {
      data: [row({ club_id: 'club-9' })],
      error: null,
    };
    await expect(LeaderboardService.getRewardProgramHistory('club-1', 7)).rejects.toThrow(
      'Program History Returned Invalid Data'
    );
  });

  it('surfaces a failed read', async () => {
    db.tables.leaderboard_reward_program_versions = {
      data: null,
      error: { message: 'permission denied' },
    };
    await expect(LeaderboardService.getRewardProgramHistory('club-1', 7)).rejects.toBeTruthy();
  });
});
