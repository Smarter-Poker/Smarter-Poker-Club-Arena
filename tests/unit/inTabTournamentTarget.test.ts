/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DRILL-IN TARGET — behaviour, not source text
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `action-bar-never-leaves.law.test.ts` pins that the mechanism EXISTS. This
 * pins that it is CORRECT, because the round 1 bug was not a missing mechanism
 * — the interception worked perfectly and threw away the query string on the
 * way through. A source-shape assertion cannot see that; only running the
 * parser can.
 *
 * The one that matters: `/tournaments/<id>?watch=1` must come back with the
 * `?watch=1` intact, because TournamentDetails consumes exactly that parameter
 * to open the featured table. Lose it and the WATCH button opens a details page
 * and stops.
 */
import { describe, it, expect } from 'vitest';
import { tournamentTargetFromTo } from '../../src/context/InTabLobbyContext';

describe('tournamentTargetFromTo', () => {
  it('reads a plain tournament path', () => {
    expect(tournamentTargetFromTo('/tournaments/abc123')).toEqual({
      tournamentId: 'abc123',
      search: '',
    });
  });

  it('KEEPS the query string on a string path — the WATCH regression', () => {
    expect(tournamentTargetFromTo('/tournaments/abc123?watch=1')).toEqual({
      tournamentId: 'abc123',
      search: '?watch=1',
    });
  });

  it('keeps a multi-parameter query verbatim', () => {
    expect(tournamentTargetFromTo('/tournaments/x?watch=1&tab=ranking')).toEqual({
      tournamentId: 'x',
      search: '?watch=1&tab=ranking',
    });
  });

  it('reads a To object, normalising a missing leading ?', () => {
    expect(tournamentTargetFromTo({ pathname: '/tournaments/x', search: 'watch=1' })).toEqual({
      tournamentId: 'x',
      search: '?watch=1',
    });
    expect(tournamentTargetFromTo({ pathname: '/tournaments/x', search: '?watch=1' })).toEqual({
      tournamentId: 'x',
      search: '?watch=1',
    });
  });

  it('does not strip a hash into the id', () => {
    expect(tournamentTargetFromTo('/tournaments/abc#top')?.tournamentId).toBe('abc');
  });

  describe('what it must NOT claim', () => {
    it('ignores a search-only navigate — that is editing the current URL', () => {
      // TournamentDetails uses this shape to consume ?watch=1. Treating it as a
      // tournament destination would make the page re-drill into itself.
      expect(tournamentTargetFromTo({ search: '?tab=blinds' })).toBeNull();
    });

    it('ignores non-tournament routes', () => {
      for (const p of ['/table/abc', '/clubs/x', '/cashier', '/', '/tournamentsfoo']) {
        expect(tournamentTargetFromTo(p), p).toBeNull();
      }
    });

    it('ignores the bare list route', () => {
      // '/tournaments' has no id. It is handled by its own backstop effect,
      // NOT by pretending the list is a tournament.
      expect(tournamentTargetFromTo('/tournaments')).toBeNull();
      expect(tournamentTargetFromTo('/tournaments?type=spin')).toBeNull();
    });

    it('does not treat a deeper path segment as the id', () => {
      // /tournaments/:id/something is a different page; the regex stops at the
      // first slash so the id stays exactly one segment.
      expect(tournamentTargetFromTo('/tournaments/abc/play')?.tournamentId).toBe('abc');
    });
  });
});
