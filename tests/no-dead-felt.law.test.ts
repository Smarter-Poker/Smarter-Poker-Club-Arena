/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO DEAD FELT — LAW (Dan 2026-09-01, binding)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verbatim: "THERE SHOULD NEVER BE THIS 14 SECONDS OR 10 SECONDS OF DEAD
 * ANYTHING ANYWHERE."
 *
 * WHAT HE WAS LOOKING AT. The Spin wheel scheduled its own exit off its own
 * sequence, and under reduced motion that sequence is about 2.4 seconds
 * (lead-in 0, countdown 200ms, chase 400ms, result 1800ms) while the engine
 * holds the deal for `spinRevealToDealMs()` regardless. So the wheel unmounted
 * and handed back an EMPTY table - zero-chip seats, no cards, nothing on
 * screen saying why - for roughly fourteen seconds. The same gap opens for a
 * fast animation-speed setting, and it opens fully for a client that joins
 * late and finds every phase already elapsed.
 *
 * THE RULE. A wait the player can see must be filled. Not with a spinner
 * standing in for information, but with what is actually happening and how
 * long is left. Speeding an ANIMATION up is a preference and is honoured;
 * being shown nothing is not a preference, it is an empty screen.
 *
 * This is the same law CLAUDE.md 10.6 already states from the other side -
 * reduced motion collapses MOTION, never MEANING. A collapsed animation that
 * leaves the player staring at felt has thrown away the meaning too.
 *
 * If a pin below goes red you have re-opened a hole the player looks straight
 * into. Fill the wait; do not shorten the pin.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('no dead felt', () => {
  const wheel = read('src/components/tournament/SpinWheel.tsx');

  it('holds the felt until the engine is ready to use it', () => {
    // The exit is the LATER of this component's own sequence and the moment
    // the engine deals. Either half alone is the bug: the sequence alone
    // leaves an empty table, the deal moment alone would cut a full-length
    // wheel short.
    expect(wheel).toContain('Math.max(at(ownEndMs), dealAtMs - Date.now())');
  });

  it('takes the deal moment from the shared clock and the spec, not from a field the fallback never sets', () => {
    // `revealDeadlineMs` is set by the socket path and NOT by the fallback
    // row-derived path, so a client the socket never reached would have had no
    // deadline to hold for at all.
    expect(wheel).toContain('spinRevealToDealMs()');
    expect(wheel).toMatch(/const dealAtMs = sharedClock \? revealAt \+ spinRevealToDealMs\(\)/);
  });

  it('tells the player what the wait is for, with a live count', () => {
    expect(wheel).toContain('dealInSec');
    expect(wheel).toContain('Dealing In {dealInSec}');
    // Rendered inside the result card, which is only up while the draw's
    // outcome is on screen - so the countdown never appears over nothing.
    const resultCard = wheel.slice(wheel.indexOf("{phase === 'result' && ("));
    expect(resultCard).toContain('sw__dealing');
  });

  it('does not let reduced motion or a speed preference shorten the wait', () => {
    // `ownEndMs` is scaled by `speed` and by `reduced`; `dealAtMs` must not be.
    const dealAt = wheel.slice(
      wheel.indexOf('const dealAtMs ='),
      wheel.indexOf('const dealTicker')
    );
    expect(dealAt).not.toContain('speed');
    expect(dealAt).not.toContain('reduced');
  });

  it('marks the countdown as duration-carrying, per CLAUDE.md 10.6', () => {
    expect(wheel).toContain('data-motion="keep"');
  });

  it('stops its ticker with clearInterval, not clearTimeout', () => {
    // An interval is not a timeout. Clearing one with clearTimeout is not
    // reliable outside a browser, and a ticker that outlives the wheel would
    // set state on an unmounted component every 250ms.
    expect(wheel).toContain('clearInterval(dealTickerRef.current)');
    expect(wheel).not.toContain('as unknown as ReturnType<typeof setTimeout>');
  });
});
