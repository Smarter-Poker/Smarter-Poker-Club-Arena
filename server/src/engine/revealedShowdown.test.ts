import { describe, it, expect } from 'vitest';
import { selectRevealedShowdownResults } from './revealedShowdown.js';

const WINNER = { userId: 'winner' };
const MUCKER = { userId: 'mucker' };
const SHOWER = { userId: 'shower' };
const ALL = [WINNER, MUCKER, SHOWER];

const ids = (rs: { userId: string }[]) => rs.map((r) => r.userId).sort();

describe('selectRevealedShowdownResults', () => {
  it('stores the winner’s holding', () => {
    const out = selectRevealedShowdownResults(ALL, new Set(['winner']), null, true);
    expect(ids(out)).toContain('winner');
  });

  it('does NOT store a holding that was mucked', () => {
    const out = selectRevealedShowdownResults(ALL, new Set(['winner']), null, true);
    expect(ids(out)).not.toContain('mucker');
  });

  it('stores a holding the player voluntarily showed', () => {
    const out = selectRevealedShowdownResults(ALL, new Set(['winner']), new Set(['shower']), true);
    expect(ids(out)).toEqual(['shower', 'winner']);
  });

  it('stores every holding when the table has auto-muck off', () => {
    const out = selectRevealedShowdownResults(ALL, new Set(['winner']), null, false);
    expect(ids(out)).toEqual(['mucker', 'shower', 'winner']);
  });

  // Regression guard for the 2026-08-17 over-filter: an empty winner set must
  // not silently empty the column. If the caller ever again passes a list that
  // has already been cleared, this test still passes (correctly — nothing was
  // shown), so the REAL guard is the pair below: a non-empty winner set must
  // always yield the winner.
  it('yields nothing when nobody won and nobody showed', () => {
    expect(selectRevealedShowdownResults(ALL, new Set<string>(), null, true)).toEqual([]);
  });

  it('never drops a winner that is present in the winner set', () => {
    for (const w of ['winner', 'mucker', 'shower']) {
      const out = selectRevealedShowdownResults(ALL, new Set([w]), null, true);
      expect(ids(out)).toEqual([w]);
    }
  });

  it('splits pots: every winner is kept', () => {
    const out = selectRevealedShowdownResults(ALL, new Set(['winner', 'mucker']), null, true);
    expect(ids(out)).toEqual(['mucker', 'winner']);
  });

  it('does not mutate its input', () => {
    const input = [...ALL];
    selectRevealedShowdownResults(input, new Set(['winner']), null, false);
    expect(input).toHaveLength(3);
  });
});
