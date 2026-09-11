/**
 * The sweep must order a bust by the same knockout generation the door records
 * it under: the LATEST one. See bustOrder.ts for the 798866ae case.
 */
import { describe, expect, it } from 'vitest';
import { bindLatestKnockoutCandidates, type KnockoutCandidateOrderRow } from './bustOrder.js';

const HAWK = '9bb330b7-a66a-4c52-b19c-d932ae07a354';
const SLY = '65f99ae2-cd2e-46a2-be72-c47361552350';

const row = (
  user: string,
  hand: number,
  stack: number,
  state = 'pending',
  id = `${hand}`.padStart(8, '0')
): KnockoutCandidateOrderRow => ({
  id,
  eliminated_user_id: user,
  hand_number: hand,
  stack_before: stack,
  state,
});

describe('the sweep binds the generation the door binds', () => {
  it('orders a player by their latest bust, not an older orphaned generation', () => {
    const bound = bindLatestKnockoutCandidates([
      // hawk_82: the orphan the rebuy chain left, then the real bust a day later
      row(HAWK, 8550341, 2220),
      row(HAWK, 9166239, 30000),
      row(SLY, 8584595, 2500),
    ]);
    expect(bound.get(HAWK)).toEqual({ handNumber: 9166239, stackBefore: 30000 });
    expect(bound.get(SLY)).toEqual({ handNumber: 8584595, stackBefore: 2500 });
    // and therefore SlyAnteDoc busted first, and takes the worse place
    expect(bound.get(SLY)!.handNumber).toBeLessThan(bound.get(HAWK)!.handNumber);
  });

  it('reads the order of the rows it is given as irrelevant', () => {
    const rows = [row(HAWK, 9166239, 30000), row(HAWK, 8550341, 2220)];
    expect(bindLatestKnockoutCandidates(rows)).toEqual(
      bindLatestKnockoutCandidates([...rows].reverse())
    );
    expect(bindLatestKnockoutCandidates(rows).get(HAWK)?.handNumber).toBe(9166239);
  });

  it('gives a player no order when the latest generation is not pending', () => {
    // bought back in (or already recorded): the door will not record the older
    // pending row, so the sweep must not order by it either
    for (const state of ['rebought', 'eliminated', 'winner']) {
      const bound = bindLatestKnockoutCandidates([
        row(HAWK, 8550341, 2220, 'pending'),
        row(HAWK, 9166239, 30000, state),
      ]);
      expect(bound.has(HAWK), state).toBe(false);
    }
  });

  it('keeps an older resolved generation out of the way of a pending latest one', () => {
    const bound = bindLatestKnockoutCandidates([
      row(HAWK, 8550341, 2220, 'rebought'),
      row(HAWK, 9166239, 30000, 'pending'),
    ]);
    expect(bound.get(HAWK)).toEqual({ handNumber: 9166239, stackBefore: 30000 });
  });

  it('breaks a same-hand tie the way the door does: the higher id', () => {
    const bound = bindLatestKnockoutCandidates([
      row(HAWK, 9166239, 100, 'rebought', 'aaaaaaaa-0000-4000-8000-000000000001'),
      row(HAWK, 9166239, 200, 'pending', 'bbbbbbbb-0000-4000-8000-000000000001'),
    ]);
    expect(bound.get(HAWK)).toEqual({ handNumber: 9166239, stackBefore: 200 });
  });

  it('fails closed on a row it cannot read rather than falling back to an older one', () => {
    const bound = bindLatestKnockoutCandidates([
      row(HAWK, 8550341, 2220),
      {
        id: 'x',
        eliminated_user_id: HAWK,
        hand_number: null,
        stack_before: 30000,
        state: 'pending',
      },
      row(SLY, 8584595, 2500),
    ]);
    expect(bound.has(HAWK)).toBe(false);
    expect(bound.get(SLY)).toEqual({ handNumber: 8584595, stackBefore: 2500 });
  });

  it('accepts the numeric strings PostgREST can return for bigint and numeric', () => {
    const bound = bindLatestKnockoutCandidates([
      {
        id: 'a',
        eliminated_user_id: HAWK,
        hand_number: '9166239',
        stack_before: '30000.00',
        state: 'pending',
      },
    ]);
    expect(bound.get(HAWK)).toEqual({ handNumber: 9166239, stackBefore: 30000 });
  });

  it('ignores a row with no player', () => {
    expect(
      bindLatestKnockoutCandidates([{ hand_number: 1, stack_before: 1, state: 'pending' }]).size
    ).toBe(0);
  });
});
