/**
 * THE GAME RULES MODAL MUST STATE THE RAKE THAT IS ACTUALLY TAKEN (2026-08-19).
 *
 * History this file exists to stop repeating:
 *
 *   1. The modal used to fall back to a hard-coded "5% (Cap $3)" when it did not
 *      know the real numbers — a confident lie.
 *   2. Owner-facing rake controls were then made real, so a table or club can
 *      set its own rate. The modal was taught the same precedence.
 *   3. That wiring lived inline in TablePage.tsx and was lost when that file was
 *      rewritten — the page reverted to a plain schedule lookup and stopped
 *      reading the override columns entirely. Silent, because no club had an
 *      override set at the time.
 *
 * So the precedence is pinned here, in a file that does not depend on
 * TablePage. The rule must match server/src/engine/ServerTableEngineBase
 * getRakeOverride exactly — if the screen and the engine disagree, the screen is
 * lying about money.
 */
import { describe, it, expect } from 'vitest';
import { resolveRakeOverride, parseBlinds } from '../../src/lib/rakeOverride';
import { getRakeConfig, RAKE_INHERIT } from '../../src/config/RakeConfig';

describe('parseBlinds', () => {
  it('reads a normal stakes string', () => {
    expect(parseBlinds('1/2')).toEqual({ sb: 1, bb: 2 });
    expect(parseBlinds('0.05/0.1')).toEqual({ sb: 0.05, bb: 0.1 });
  });

  it.each([undefined, null, '', '2', 'abc', '/', '1/', 'x/y', '1/0'])(
    'refuses to guess from %p',
    (v) => {
      expect(parseBlinds(v as string | null)).toBeNull();
    }
  );
});

describe('resolveRakeOverride — precedence must match the server', () => {
  it('prefers the table over the club', () => {
    expect(
      resolveRakeOverride(
        { rake_percent: 4, rake_cap_bb: 2 },
        { default_rake_percent: 7, rake_cap: 9 }
      )
    ).toEqual({ rakePercent: 4, rakeCapBB: 2 });
  });

  it('falls back to the club when the table inherits', () => {
    expect(
      resolveRakeOverride(
        { rake_percent: RAKE_INHERIT, rake_cap_bb: RAKE_INHERIT },
        { default_rake_percent: 7, rake_cap: 9 }
      )
    ).toEqual({ rakePercent: 7, rakeCapBB: 9 });
  });

  it('mixes: table sets the percent, club sets the cap', () => {
    expect(
      resolveRakeOverride(
        { rake_percent: 4, rake_cap_bb: RAKE_INHERIT },
        { default_rake_percent: 7, rake_cap: 9 }
      )
    ).toEqual({ rakePercent: 4, rakeCapBB: 9 });
  });

  it('returns undefined — meaning "use the schedule" — when nothing is set', () => {
    expect(
      resolveRakeOverride(
        { rake_percent: RAKE_INHERIT, rake_cap_bb: RAKE_INHERIT },
        { default_rake_percent: RAKE_INHERIT, rake_cap: RAKE_INHERIT }
      )
    ).toBeUndefined();
    expect(resolveRakeOverride(null, null)).toBeUndefined();
    expect(resolveRakeOverride({}, {})).toBeUndefined();
  });

  it('treats NULL (never configured) as inherit, not as zero rake', () => {
    // A NULL read as 0 would tell the player the house takes nothing.
    expect(
      resolveRakeOverride(
        { rake_percent: null, rake_cap_bb: null },
        { default_rake_percent: null, rake_cap: null }
      )
    ).toBeUndefined();
  });

  it('accepts a deliberate zero — a genuinely rake-free table', () => {
    expect(resolveRakeOverride({ rake_percent: 0, rake_cap_bb: 0 }, null)).toEqual({
      rakePercent: 0,
      rakeCapBB: 0,
    });
  });

  it('reads the club columns the ENGINE reads, not the legacy duplicates', () => {
    // clubs.rake_percent / clubs.rake_cap_bb are a second, unused pair that
    // still carry their original column defaults (5 and 3). Showing those would
    // state a rate nothing ever takes.
    const legacyShaped = { rake_percent: 5, rake_cap_bb: 3 } as unknown as {
      default_rake_percent?: number | null;
      rake_cap?: number | null;
    };
    expect(resolveRakeOverride(null, legacyShaped)).toBeUndefined();
  });
});

describe('the number that reaches the modal', () => {
  const scheduleAt = (bb: number) => getRakeConfig(bb, 'nlh', bb / 2);

  it('a club override changes what the modal shows', () => {
    const bb = 2;
    const schedule = scheduleAt(bb);
    const withClub = getRakeConfig(
      bb,
      'nlh',
      1,
      resolveRakeOverride(null, { default_rake_percent: 3, rake_cap: 1 })
    );
    expect(withClub.rakePercent).toBe(3);
    expect(withClub.rakeCap).toBe(2); // 1 BB at 1/2 = $2
    expect(withClub.rakeCap).not.toBe(schedule.rakeCap);
  });

  it('the cap is converted from big blinds to dollars, like the server', () => {
    // 1 BB at 2/5 is $5, not $1. (3 BB would convert to $15, but 2/5 is
    // capped at $7.50, so it would no longer isolate the conversion.)
    const cfg = getRakeConfig(5, 'nlh', 2, { rakePercent: 5, rakeCapBB: 1 });
    expect(cfg.rakeCap).toBe(5);
  });

  it('an owner cannot rake above the published ceiling', () => {
    // The ceiling is the SCHEDULE for the stake, not MAX_RAKE_CAP_BB: at 1/2
    // the published cap is $5, and 99 BB (or 10 BB, or 3 BB) may not beat it.
    const cfg = getRakeConfig(2, 'nlh', 1, { rakePercent: 99, rakeCapBB: 99 });
    expect(cfg.rakePercent).toBeLessThanOrEqual(10);
    expect(cfg.rakeCap).toBe(5);
    expect(getRakeConfig(5, 'nlh', 2, { rakeCapBB: 3 }).rakeCap).toBe(7.5);
  });

  it('with no override at all, the modal shows exactly the schedule', () => {
    const bb = 2;
    const a = scheduleAt(bb);
    const b = getRakeConfig(bb, 'nlh', 1, resolveRakeOverride(null, null));
    expect(b.rakePercent).toBe(a.rakePercent);
    expect(b.rakeCap).toBe(a.rakeCap);
  });
});
