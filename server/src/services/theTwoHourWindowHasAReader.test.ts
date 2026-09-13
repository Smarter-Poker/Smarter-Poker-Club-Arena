/**
 * THE TWO-HOUR WINDOW HAS A READER (2026-09-11).
 *
 * Section 9 of the OPORD: a horse that leaves a game does not buy straight back
 * into it, because that is what a reload looks like and not what a real player
 * does. Everything for that rule existed and none of it was connected. The
 * column `stable_hand_horse_state.two_hour_window` was written on every cycle
 * (4,894 entries live, 544 of them inside the window when this was found), the
 * helper `inTwoHourWindow` existed, the constant `TWO_HOUR_WINDOW_MS` existed,
 * and `mayRebuyInSeat` took the flag as an argument - and nothing anywhere ever
 * asked the question. Two audits in a row found it as "no live caller" and
 * offered "wire it, or delete the column write".
 *
 * A rule with no reader is not a rule. This gives it one, at the sit gate,
 * beside the rest day and the sit cap - the other two rules of the same kind.
 *
 * WHY THIS IS NOT A HORSE-ONLY RESTRICTION (CLAUDE.md 10.5). A human decides
 * when to sit down; a horse has no browser, so the Stable Hand decides for it.
 * That is the sanctioned horse branch: the input device, not a different deal.
 * Choosing not to re-enter a game you just left is the same class of choice as
 * a rest day, a daily cap and a persona's sit cap, all of which are already
 * live in this gate. Nothing a human is entitled to is being withheld.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSit, gameKey, TWO_HOUR_WINDOW_MS, type SitRequest } from './StableHand.js';
import { inTwoHourWindow } from './StableHandTags.js';

const MIDWAY = 'fade0000-0000-0000-0000-000000000001';
const JAQK = 'a0000000-0000-0000-0000-000000000001';

const base: SitRequest = {
  activeClubId: null,
  activeHostId: null,
  activeSeatCount: 0,
  maxTables: 4,
  clubId: JAQK,
  tableHostId: MIDWAY,
  bb: 2,
  available: 100_000,
  sessionStartBalance: 100_000,
  currentCommit: 0,
  buyIn: 200,
  persona: 'grinder',
  sitsOnKeyToday: 0,
  isRestDay: false,
  inTwoHourWindow: false,
  killed: false,
};

describe('the sit gate asks the question', () => {
  it('a horse inside the window on this key is refused, by its own name', () => {
    expect(evaluateSit(base)).toBe('ok');
    expect(evaluateSit({ ...base, inTwoHourWindow: true })).toBe('two_hour_window');
  });

  it('it is an identity check, not a money one: an unread roll still refuses', () => {
    // The money checks are skipped when the roll was not read (2026-08-31
    // doctrine). This rule is knowable without a wallet, so it still applies.
    expect(evaluateSit({ ...base, available: null })).toBe('ok');
    expect(evaluateSit({ ...base, available: null, inTwoHourWindow: true })).toBe(
      'two_hour_window'
    );
  });

  it('it is asked before the sit cap, so the more specific refusal is the one reported', () => {
    const capped = { ...base, sitsOnKeyToday: 99, inTwoHourWindow: true };
    expect(evaluateSit(capped)).toBe('two_hour_window');
    expect(evaluateSit({ ...capped, inTwoHourWindow: false })).toBe('sit_cap');
  });

  it('a killed controller and a wrong host still win, so the kill switch is absolute', () => {
    expect(evaluateSit({ ...base, inTwoHourWindow: true, killed: true })).toBe('killed');
    expect(evaluateSit({ ...base, inTwoHourWindow: true, clubId: 'somewhere-else' })).toBe(
      'other_host'
    );
  });
});

describe('the window itself is two hours from the moment the key was given up', () => {
  const key = gameKey({
    hostId: MIDWAY,
    template: 'classic',
    variant: 'nlh',
    sb: 1,
    bb: 2,
  });
  const at = Date.UTC(2026, 8, 11, 12, 0, 0);
  const state = { twoHourWindow: { [key]: at } } as Parameters<typeof inTwoHourWindow>[0];

  it('closed one minute ago: inside', () => {
    expect(inTwoHourWindow(state, key, at + 60_000, TWO_HOUR_WINDOW_MS)).toBe(true);
  });

  it('closed two hours and a second ago: outside', () => {
    expect(inTwoHourWindow(state, key, at + TWO_HOUR_WINDOW_MS + 1_000, TWO_HOUR_WINDOW_MS)).toBe(
      false
    );
  });

  it('a DIFFERENT game is never touched by it', () => {
    const other = gameKey({
      hostId: MIDWAY,
      template: 'classic',
      variant: 'plo4',
      sb: 1,
      bb: 2,
    });
    expect(other).not.toBe(key);
    expect(inTwoHourWindow(state, other, at + 60_000, TWO_HOUR_WINDOW_MS)).toBe(false);
  });

  it('a horse with no state row is never inside it', () => {
    expect(inTwoHourWindow(undefined, key, at + 60_000, TWO_HOUR_WINDOW_MS)).toBe(false);
  });

  it('the constant is two hours', () => {
    expect(TWO_HOUR_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });
});
