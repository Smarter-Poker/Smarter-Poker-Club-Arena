import { describe, expect, it } from 'vitest';
import {
  CLUB_GAMES_UNAVAILABLE_COPY,
  clubDataListState,
  clubDataReadFailure,
} from '../../src/pages/club/clubDataReadOutcome';

/**
 * COULD NOT LOAD IS NOT EMPTY (CLAUDE.md 10.86 rule 1).
 *
 * A failed Club Data read with nothing verified on screen used to clear its
 * own error and leave an empty Games list with no message and no Try Again.
 * Every case below is paired: the unknown outcome and the genuinely empty one
 * must never render the same way.
 */
describe('a Club Data read that could not complete is never shown as empty', () => {
  it('a failed read with nothing held says so, even when asked to preserve', () => {
    const outcome = clubDataReadFailure({
      preserveOnError: true,
      holdingVerifiedData: false,
      message: CLUB_GAMES_UNAVAILABLE_COPY,
    });
    expect(outcome).toEqual({
      error: 'Could Not Load Club Data.',
      degraded: false,
      clearData: true,
    });
    expect(clubDataListState({ loading: false, error: outcome.error, rowCount: null })).toBe(
      'unavailable'
    );
  });

  it('a failed background read keeps a held verified ledger and marks it delayed', () => {
    const outcome = clubDataReadFailure({
      preserveOnError: true,
      holdingVerifiedData: true,
      message: CLUB_GAMES_UNAVAILABLE_COPY,
    });
    expect(outcome).toEqual({ error: null, degraded: true, clearData: false });
    expect(clubDataListState({ loading: false, error: null, rowCount: 3 })).toBe('rows');
  });

  it('a foreground failure that was not asked to preserve always speaks', () => {
    for (const holdingVerifiedData of [true, false]) {
      expect(
        clubDataReadFailure({
          preserveOnError: false,
          holdingVerifiedData,
          message: 'Club Data Took Too Long To Respond. Try Again.',
        }).error
      ).toBe('Club Data Took Too Long To Respond. Try Again.');
    }
  });

  it('pairs the unknown list with the genuinely empty one', () => {
    // Unknown: no verified payload, nothing in flight, and (the old defect)
    // no error string either. That is still unavailable, never empty.
    expect(clubDataListState({ loading: false, error: null, rowCount: null })).toBe('unavailable');
    // Genuinely empty: a verified payload that holds zero rows.
    expect(clubDataListState({ loading: false, error: null, rowCount: 0 })).toBe('empty');
  });

  it('loading is only the skeleton while nothing is held', () => {
    expect(clubDataListState({ loading: true, error: null, rowCount: null })).toBe('loading');
    // A held verified payload stays put during a refresh rather than flashing.
    expect(clubDataListState({ loading: true, error: null, rowCount: 0 })).toBe('rows');
    expect(clubDataListState({ loading: true, error: null, rowCount: 4 })).toBe('rows');
  });

  it('an error always wins over a stale count', () => {
    expect(clubDataListState({ loading: false, error: 'X', rowCount: 0 })).toBe('unavailable');
    expect(clubDataListState({ loading: true, error: 'X', rowCount: null })).toBe('unavailable');
  });

  it('the copy is Title Case with no em dash', () => {
    expect(CLUB_GAMES_UNAVAILABLE_COPY).not.toContain(String.fromCharCode(0x2014));
    for (const word of CLUB_GAMES_UNAVAILABLE_COPY.replace(/\.$/, '').split(' ')) {
      expect(word[0]).toBe(word[0].toUpperCase());
    }
  });
});
