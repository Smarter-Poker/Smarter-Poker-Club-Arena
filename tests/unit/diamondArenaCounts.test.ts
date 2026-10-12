/**
 * The Diamond Arena's four figures and its roster rows, as the Players page
 * reads them (src/lib/diamondArenaCounts.ts, src/services/
 * DiamondArenaRosterService.ts). A figure is a number, "not yet asked", or
 * "could not tell"; nothing the page cannot read is ever printed as 0, and no
 * chip or horse field survives the trip from the server to a row.
 */
import { describe, expect, it } from 'vitest';
import { COUNT_UNKNOWN, COUNT_UNKNOWN_TEXT } from '../../src/lib/countFigure';
import {
  DIAMOND_ARENA_COUNTS_PENDING,
  DIAMOND_ARENA_COUNTS_UNKNOWN,
  DIAMOND_FIGURE_LOADING_TEXT,
  diamondCountsStatus,
  diamondFigureText,
  parseDiamondArenaCounts,
} from '../../src/lib/diamondArenaCounts';
import {
  DiamondRosterShapeError,
  toDiamondRosterPage,
  toDiamondRosterPlayer,
} from '../../src/services/DiamondArenaRosterService';

describe('the four figures', () => {
  it('reads numbers as figures and a NULL as the server saying it could not tell', () => {
    expect(
      parseDiamondArenaCounts({
        members: 1149,
        online: null,
        seated: 0,
        tables: 17,
        unknown: { online: 'presence_not_reported' },
      })
    ).toEqual({ members: 1149, online: COUNT_UNKNOWN, seated: 0, tables: 17 });
  });

  it('never turns something it cannot read into a zero', () => {
    expect(parseDiamondArenaCounts({ members: '12', online: -1, seated: 1.5 })).toEqual({
      members: 12,
      online: COUNT_UNKNOWN,
      seated: COUNT_UNKNOWN,
      tables: COUNT_UNKNOWN,
    });
    for (const nothing of [null, undefined, 'x', 7, [], [1149]]) {
      expect(parseDiamondArenaCounts(nothing)).toEqual(DIAMOND_ARENA_COUNTS_UNKNOWN);
    }
  });

  it('prints loading, a real zero and unknown three different ways', () => {
    expect(diamondFigureText(null)).toBe(DIAMOND_FIGURE_LOADING_TEXT);
    expect(diamondFigureText(undefined)).toBe(DIAMOND_FIGURE_LOADING_TEXT);
    expect(diamondFigureText(0)).toBe('0');
    expect(diamondFigureText(1149)).toBe((1149).toLocaleString());
    expect(diamondFigureText(COUNT_UNKNOWN)).toBe(COUNT_UNKNOWN_TEXT);
    expect(new Set([DIAMOND_FIGURE_LOADING_TEXT, '0', COUNT_UNKNOWN_TEXT]).size).toBe(3);
    expect(COUNT_UNKNOWN_TEXT).not.toMatch(/\d/);
    expect(DIAMOND_FIGURE_LOADING_TEXT).not.toMatch(/\d/);
  });

  it('says why a figure is missing, and says nothing when every figure is a number', () => {
    expect(diamondCountsStatus('loading', DIAMOND_ARENA_COUNTS_PENDING)).toBe(
      'Counting The Arena.'
    );
    expect(diamondCountsStatus('failed', DIAMOND_ARENA_COUNTS_UNKNOWN)).toMatch(
      /Could Not Be Read/
    );
    expect(
      diamondCountsStatus('ready', { members: 1149, online: COUNT_UNKNOWN, seated: 0, tables: 17 })
    ).toMatch(/Could Not Tell, Not That The Figure Is Zero/);
    expect(diamondCountsStatus('ready', { members: 1149, online: 3, seated: 0, tables: 17 })).toBe(
      null
    );
  });
});

describe('a roster row', () => {
  it('keeps the seven fields the arena shows and drops every chip, hierarchy and horse field', () => {
    const row = toDiamondRosterPlayer({
      user_id: 'u-1',
      alias: 'River Rat',
      username: 'riverrat',
      avatar_url: 'https://x/y.png',
      player_number: '100231',
      is_seated: false,
      is_online: true,
      role: 'super_agent',
      upline_name: 'Boss',
      downline_total: 40,
      total_fees: 900,
      chip_balance: 12345,
      player_wallet: 10,
      agent_wallet: 20,
      is_horse: true,
    });
    expect(row).toEqual({
      user_id: 'u-1',
      alias: 'River Rat',
      username: 'riverrat',
      avatar_url: 'https://x/y.png',
      player_number: '100231',
      is_seated: false,
      is_online: true,
    });
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'alias',
        'avatar_url',
        'is_online',
        'is_seated',
        'player_number',
        'user_id',
        'username',
      ].sort()
    );
  });

  it('claims presence only when the server says so', () => {
    expect(toDiamondRosterPlayer({ user_id: 'u-2', is_seated: 'yes', is_online: 1 })).toMatchObject(
      {
        alias: 'Unknown',
        is_seated: false,
        is_online: false,
        avatar_url: null,
        player_number: null,
      }
    );
    expect(toDiamondRosterPlayer({ alias: 'no id' })).toBeNull();
  });

  it('a page without items or a total is unreadable, not empty', () => {
    expect(() => toDiamondRosterPage({ items: [] })).toThrow(DiamondRosterShapeError);
    expect(() => toDiamondRosterPage({ filtered_total: 3 })).toThrow(DiamondRosterShapeError);
    expect(() => toDiamondRosterPage(null)).toThrow(DiamondRosterShapeError);
    const page = toDiamondRosterPage({
      items: [{ user_id: 'u-1', alias: 'A' }, { nope: true }],
      has_more: true,
      next_cursor: null,
      filtered_total: 0,
    });
    expect(page.items.map((row) => row.user_id)).toEqual(['u-1']);
    expect(page.has_more, 'more is only offered with a cursor to fetch it').toBe(false);
    expect(page.filtered_total).toBe(0);
  });
});
