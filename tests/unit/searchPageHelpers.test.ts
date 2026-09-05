import { describe, expect, it } from 'vitest';
import {
  asPayload,
  clubDestination,
  clubMembershipLabel,
  formatCount,
  formatStartTime,
  getSearchCategory,
  indexesForScope,
  initialsOf,
  tournamentStatusLabel,
  variantLabel,
} from '../../src/pages/SearchPage';

describe('SearchPage helpers', () => {
  it('resolves a scope from the URL and falls back to the whole network', () => {
    expect(getSearchCategory('clubs')).toBe('clubs');
    expect(getSearchCategory('tab')).toBe('all');
    expect(getSearchCategory(null)).toBe('all');
  });

  it('knows which indexes each scope consults', () => {
    expect(indexesForScope('all')).toEqual(['clubs', 'players', 'tables', 'tournaments']);
    expect(indexesForScope('players')).toEqual(['players']);
    expect(indexesForScope('tournaments')).toEqual(['tournaments']);
  });

  it('formats counts with separators and never with padStart', () => {
    expect(formatCount(1177)).toBe((1177).toLocaleString());
    expect(formatCount(null)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
  });

  it('labels variants the way the lobby does', () => {
    expect(variantLabel('nlh')).toBe('NLH');
    expect(variantLabel('plo6')).toBe('PLO6');
    expect(variantLabel('short_deck')).toBe('Short Deck');
    expect(variantLabel(null)).toBe('Poker');
  });

  it('title-cases tournament statuses for the pill', () => {
    expect(tournamentStatusLabel('RUNNING')).toBe('Running');
    expect(tournamentStatusLabel('REGISTERING')).toBe('Registering');
    expect(tournamentStatusLabel('ANNOUNCED')).toBe('Announced');
  });

  it('describes a start time relative to now, then as a date', () => {
    const now = Date.parse('2026-09-05T00:00:00Z');
    expect(formatStartTime(null, now)).toBe('Start TBA');
    expect(formatStartTime('2026-09-04T23:00:00Z', now)).toBe('Started');
    expect(formatStartTime('2026-09-05T00:25:00Z', now)).toBe('Starts In 25m');
    expect(formatStartTime('2026-09-05T02:10:00Z', now)).toBe('Starts In 2h 10m');
    expect(formatStartTime('2026-09-05T03:00:00Z', now)).toBe('Starts In 3h');
    expect(formatStartTime('2026-09-07T23:00:00Z', now)).not.toContain('Starts In');
  });

  it('routes a club by slug when it has one, else by id', () => {
    expect(clubDestination({ id: 'abc', slug: 'midway-union' })).toBe('/clubs/midway-union');
    expect(clubDestination({ id: 'abc', slug: null })).toBe('/clubs/abc');
  });

  it('turns the viewer membership row into a pill', () => {
    expect(clubMembershipLabel({ viewer_status: 'approved', requires_approval: true })).toEqual({
      label: 'Member',
      tone: 'member',
    });
    expect(clubMembershipLabel({ viewer_status: 'active', requires_approval: false }).tone).toBe(
      'member'
    );
    expect(clubMembershipLabel({ viewer_status: 'pending', requires_approval: true }).label).toBe(
      'Pending'
    );
    expect(clubMembershipLabel({ viewer_status: null, requires_approval: true }).label).toBe(
      'Apply'
    );
    expect(clubMembershipLabel({ viewer_status: null, requires_approval: false }).label).toBe(
      'Open'
    );
  });

  it('builds initials for a club with no logo', () => {
    expect(initialsOf('Midway Union')).toBe('MU');
    expect(initialsOf('shark')).toBe('S');
    expect(initialsOf('   ')).toBe('?');
  });

  it('normalises the RPC payload and never trusts a missing field', () => {
    const payload = asPayload({
      clubs: [{ id: 'c1', name: 'Midway Union', is_union: true, member_count: 1177 }],
      totals: { clubs: 1, tables: '84' },
      index_health: { clubs: 4, players: 1310, tables: 187, tournaments: 369 },
      fuzzy: true,
    });
    expect(payload.clubs).toHaveLength(1);
    expect(payload.tables).toEqual([]);
    expect(payload.totals).toEqual({ clubs: 1, tables: 84, tournaments: 0 });
    expect(payload.index_health.players).toBe(1310);
    expect(payload.fuzzy).toBe(true);

    const empty = asPayload(null);
    expect(empty.clubs).toEqual([]);
    expect(empty.totals.clubs).toBe(0);
    expect(empty.index_health.clubs).toBe(0);
    expect(empty.fuzzy).toBe(false);
  });
});
