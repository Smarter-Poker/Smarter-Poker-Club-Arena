/**
 * THE RAKE THE MODAL SHOWS WHEN NOBODY HAS OVERRIDDEN IT (2026-08-19).
 *
 * resolveDisplayRake is the fallback path of the Game Rules modal: no table
 * override, no club override, just the published schedule. It matters because
 * of what it replaced — for a long time the modal told every player, at every
 * stake, "Rake 5% (Cap $3)" while the server took 10% with caps up to $15.
 *
 * A wrong number here is not a crash. It is a player being quietly misinformed
 * about what the house is taking out of their pot, which is the worst kind of
 * bug this product can ship. So the tests pin actual dollar figures rather than
 * shapes, and they pin the "we don't know yet" case just as hard: an unloaded
 * table must return undefined so the modal shows a placeholder, never a
 * confident wrong answer.
 */
import { describe, it, expect } from 'vitest';
import { resolveDisplayRake } from '../../src/lib/rakeOverride';
import { getRakeConfig, RAKE_SCHEDULE } from '../../src/config/RakeConfig';

describe('the published schedule comes through intact', () => {
  it('1/2 is 10% capped at $5', () => {
    expect(resolveDisplayRake('1/2', 'nlh')).toEqual({ rakePercent: 10, rakeCap: 5 });
  });

  it('10/25 is 10% capped at $15 — the five-fold understatement that started this', () => {
    expect(resolveDisplayRake('10/25', 'nlh')).toEqual({ rakePercent: 10, rakeCap: 15 });
  });

  it('0.1/0.2 is 10% capped at $3', () => {
    expect(resolveDisplayRake('0.1/0.2', 'nlh')).toEqual({ rakePercent: 10, rakeCap: 3 });
  });

  it('agrees with getRakeConfig for every row of the schedule', () => {
    for (const row of RAKE_SCHEDULE) {
      const direct = getRakeConfig(row.bb, 'nlh', row.sb);
      expect(resolveDisplayRake(`${row.sb}/${row.bb}`, 'nlh')).toEqual({
        rakePercent: direct.rakePercent,
        rakeCap: direct.rakeCap,
      });
    }
  });

  it('tells the two 5-big-blind stakes apart — 2/5 and 5/5 are different rows', () => {
    // Both have bb=5, so dropping the small blind would silently collapse them.
    const a = resolveDisplayRake('2/5', 'nlh');
    const b = resolveDisplayRake('5/5', 'nlh');
    expect(a.rakeCap).toBe(getRakeConfig(5, 'nlh', 2).rakeCap);
    expect(b.rakeCap).toBe(getRakeConfig(5, 'nlh', 5).rakeCap);
  });
});

describe('when the table has not loaded, say nothing rather than something wrong', () => {
  it.each([undefined, null, '', '?/?', 'abc', '2', '0/0', '1/0', '1/-2'])(
    'returns undefined for both on %p',
    (blinds) => {
      expect(resolveDisplayRake(blinds as string | null | undefined, 'nlh')).toEqual({
        rakePercent: undefined,
        rakeCap: undefined,
      });
    }
  );

  it('never returns NaN', () => {
    for (const b of ['', '?/?', 'x/y', '1/2', '10/25', undefined]) {
      const out = resolveDisplayRake(b as string | undefined, 'nlh');
      expect(Number.isNaN(out.rakePercent as number)).toBe(false);
      expect(Number.isNaN(out.rakeCap as number)).toBe(false);
    }
  });
});

describe('the awkward inputs behave the way the modal has always behaved', () => {
  it('an unreadable SMALL blind still yields a rake from the big blind', () => {
    // Deliberate: parseBlinds() in the same module would reject this outright.
    // Changing that would change a number shown to players, so it is pinned
    // here rather than quietly unified. See the note on resolveDisplayRake.
    const out = resolveDisplayRake('x/2', 'nlh');
    expect(out.rakePercent).toBe(10);
    expect(out.rakeCap).toBe(getRakeConfig(2, 'nlh', null).rakeCap);
  });

  it('ignores anything past the big blind', () => {
    expect(resolveDisplayRake('1/2/3', 'nlh')).toEqual(resolveDisplayRake('1/2', 'nlh'));
  });

  it('treats a missing game type as hold’em', () => {
    expect(resolveDisplayRake('1/2', undefined)).toEqual(resolveDisplayRake('1/2', 'nlh'));
    expect(resolveDisplayRake('1/2', '')).toEqual(resolveDisplayRake('1/2', 'nlh'));
  });

  it('does not blow up on a variant it has never heard of', () => {
    const out = resolveDisplayRake('1/2', 'some_new_game');
    expect(out.rakePercent).toBe(10);
    expect(out.rakeCap).toBeGreaterThan(0);
  });

  it('falls back to a tier for a stake that is not on the schedule', () => {
    const out = resolveDisplayRake('7/14', 'nlh');
    expect(out.rakePercent).toBeGreaterThan(0);
    expect(out.rakeCap).toBeGreaterThan(0);
  });
});
