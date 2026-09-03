/**
 * THE CLIENT MAY NOT INVENT A DEADLINE, AND MAY NOT MISS ONE.
 *
 * `src/lib/sitOutDeadline.ts` is a MIRROR of `DisconnectEngine`'s eviction
 * limits. It has to be a copy rather than an import: `server/tsconfig.json` sets
 * `rootDir: ./src`, so nothing under `server/` can reach the app's `src/` and
 * nothing in `src/` may import from `server/` in a shipped bundle. The same
 * arrangement already exists for cash buy-in limits, pinned by
 * `cashBuyInMirror.test.ts`.
 *
 * WHY THIS ONE MATTERS MORE THAN MOST
 *
 * This countdown is shown to a player whose SEAT AND STACK are on the line. The
 * component that used to render one was deleted on 2026-08-16 for exactly this
 * reason: it counted down from a hardcoded 300 against a deadline that did not
 * exist anywhere in the system, and threatened a player with losing a seat that
 * was never at risk. The deadline is real now — but a client number that drifts
 * from the engine's is the same lie with a different value, and the player has
 * no way to tell.
 *
 * So: if `SITOUT_MAX_MS` ever changes on one side, this goes red.
 */
import { describe, it, expect } from 'vitest';
import {
  SITOUT_MAX_MS,
  SITOUT_MAX_ORBITS,
  CLOCK_SKEW_TOLERANCE_MS,
  sitOutMsRemaining,
  formatSitOutRemaining,
  sitOutBadgeLabel,
  isSitOutUrgent,
} from '../../src/lib/sitOutDeadline';
import { DisconnectEngine } from '../../server/src/engine/DisconnectEngine';

describe('the client deadline is the engine deadline', () => {
  it('SITOUT_MAX_MS agrees with DisconnectEngine', () => {
    expect(SITOUT_MAX_MS).toBe(DisconnectEngine.SITOUT_MAX_MS);
  });

  it('SITOUT_MAX_ORBITS agrees with DisconnectEngine', () => {
    /* Reported, never counted client-side — a client cannot see orbits. It is
       mirrored so that a surface which wants to EXPLAIN the rule quotes the
       real number. */
    expect(SITOUT_MAX_ORBITS).toBe(DisconnectEngine.SITOUT_MAX_ORBITS);
  });

  it('is five minutes, stated once here so a silent change to both is still visible', () => {
    expect(SITOUT_MAX_MS).toBe(5 * 60 * 1000);
  });
});

describe('no deadline is invented where none exists', () => {
  const now = 1_000_000_000_000;

  it('a tournament player is never on a clock', () => {
    /* Dan 2026-08-28: "AS LONG AS THEY WANT IN A MTT, SPIN OR HEADS UP (BUT
       THEY WILL BE BLINDED OFF)." Null, not a large number — a caller must be
       able to render nothing rather than a countdown that never fires. */
    expect(sitOutMsRemaining({ sitOutSince: now - 60_000, isTournament: true, now })).toBeNull();
  });

  it('an unknown start time yields no countdown rather than a guess', () => {
    expect(sitOutMsRemaining({ sitOutSince: null, isTournament: false, now })).toBeNull();
    expect(sitOutMsRemaining({ sitOutSince: undefined, isTournament: false, now })).toBeNull();
    expect(sitOutMsRemaining({ sitOutSince: NaN, isTournament: false, now })).toBeNull();
  });

  it('a stamp slightly in the future is clock skew, and still counts down', () => {
    /* CHANGED 2026-08-29 (round 4). This used to assert `null` for ANY negative
       elapsed. `sit_out_at` is `now()` on the DATABASE, so a device whose clock
       runs behind real time makes EVERY server stamp look future-dated — and
       that device then lost the countdown entirely and silently: no badge
       clock, no line in the modal, nothing on the footer, while a real eviction
       timer ran against them. Saying nothing is right for a value we cannot
       trust; it was wrong for one that is merely a few seconds off.

       Inside the tolerance the clock is treated as just-started, so the
       deadline is at worst a few seconds LATE — under-promising, which is the
       safe direction on a seat about to be reclaimed. */
    expect(sitOutMsRemaining({ sitOutSince: now + 30_000, isTournament: false, now })).toBe(
      SITOUT_MAX_MS
    );
  });

  it('but a stamp far in the future means the clock is unusable, so say nothing', () => {
    expect(
      sitOutMsRemaining({
        sitOutSince: now + CLOCK_SKEW_TOLERANCE_MS + 1_000,
        isTournament: false,
        now,
      })
    ).toBeNull();
  });

  it('counts down on cash and floors at zero rather than going negative', () => {
    expect(sitOutMsRemaining({ sitOutSince: now, isTournament: false, now })).toBe(SITOUT_MAX_MS);
    expect(sitOutMsRemaining({ sitOutSince: now - 60_000, isTournament: false, now })).toBe(
      SITOUT_MAX_MS - 60_000
    );
    expect(sitOutMsRemaining({ sitOutSince: now - 60 * 60_000, isTournament: false, now })).toBe(0);
  });
});

describe('what the player reads', () => {
  it('formats as m:ss, floored', () => {
    expect(formatSitOutRemaining(300_000)).toBe('5:00');
    expect(formatSitOutRemaining(65_000)).toBe('1:05');
    expect(formatSitOutRemaining(5_400)).toBe('0:05');
    expect(formatSitOutRemaining(0)).toBe('0:00');
    expect(formatSitOutRemaining(-1)).toBe('0:00');
  });

  it('says plain "Sitting Out" when there is no deadline', () => {
    expect(sitOutBadgeLabel(null)).toBe('Sitting Out');
  });

  it('never claims time that has run out', () => {
    expect(sitOutBadgeLabel(0)).toBe('Sitting Out. Seat At Risk');
  });

  it('is Title Case and carries no em dash, like every popup in this product', () => {
    /* Dan 2026-08-20, binding. These strings are rendered outside the Toast
       layer that applies the transform, so they have to be written correct. */
    for (const label of [sitOutBadgeLabel(null), sitOutBadgeLabel(0), sitOutBadgeLabel(90_000)]) {
      expect(label).not.toMatch(/[—–]/);
      for (const word of label.split(/[\s.]+/).filter(Boolean)) {
        if (/^\d/.test(word)) continue; // "1:30"
        expect(word[0], `"${word}" in "${label}" must start with a capital`).toBe(
          word[0].toUpperCase()
        );
      }
    }
  });

  it('flags the last minute as urgent, and never flags a player who has no clock', () => {
    expect(isSitOutUrgent(59_000)).toBe(true);
    expect(isSitOutUrgent(60_000)).toBe(true);
    expect(isSitOutUrgent(61_000)).toBe(false);
    expect(isSitOutUrgent(null)).toBe(false);
  });
});
