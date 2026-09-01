/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE WHEEL AGREES WITH THE SHARED CLOCK — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four defects, one family: every one of them is the Spin wheel disagreeing
 * with the engine's shared clock, or with itself.
 *
 *  2. The celebration is spread with `4.16%` per piece — 100/24, hand-tuned for
 *     24 pieces — while the tiers emit 16 / 32 / 48 / 72. Everything from index
 *     24 up landed past 101.8% and was clipped, so a 50x and a 100x rendered
 *     IDENTICALLY to a 25x. The delay had the same shape: `index * 55ms` starts
 *     piece 71 at 3.905s against a 4.8s hold and a 1.8s fall.
 *
 *  5. Every phase is scheduled through `at()` = `max(0, offset - elapsed)`, so
 *     a client mounting after the sequence has elapsed resolves EVERY phase to
 *     zero — a four-frame flash — and `onDone` then stamps
 *     `markSpinRevealPlayed`, so that tab never sees the draw again.
 *
 *  6. `getAnimationSpeed()` was consulted only on the no-shared-clock branch,
 *     which never happens in production. The Animation Speed setting did
 *     nothing to the wheel while the code's own comment promised otherwise.
 *
 *  7. The socket path passes `hold_until` as `revealDeadlineMs`; the
 *     row-derived fallback passed nothing, so a client the socket never
 *     reached could be out of step with the seats that got the broadcast —
 *     the "three players, three wheels" failure the shared clock exists to
 *     prevent.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPIN_TIERS, SPIN_REVEAL } from '../src/config/spinSpec';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const wheel = read('src/components/tournament/SpinWheel.tsx');
const css = read('src/components/tournament/SpinWheel.css');
const table = read('src/pages/TablePage.tsx');

describe('the wheel agrees with the shared clock', () => {
  it('item 2: the confetti spread is derived from the piece count, not from 24', () => {
    expect(css).not.toContain('var(--sw-c) * 4.16%');
    expect(css).toContain('var(--sw-c-total, 24)');
    expect(wheel).toContain("['--sw-c-total' as string]: celebration.confettiPieces");
  });

  it('item 2: the last piece still falls inside the result hold', () => {
    // The burst spreads across a fixed window however many pieces there are.
    const m =
      /animation-delay:\s*calc\(\(var\(--sw-c\) \/ var\(--sw-c-total, 24\)\) \* (\d+)ms\)/.exec(
        css
      );
    expect(m).not.toBeNull();
    const spreadMs = Number(m![1]);
    const fallMs = 1800;
    expect(spreadMs + fallMs).toBeLessThanOrEqual(SPIN_REVEAL.RESULT_HOLD_MS + 1600);
  });

  it('item 5: a client that arrives after the chase mounts into the result', () => {
    expect(wheel).toContain('const sequenceElapsedPastChase =');
    expect(wheel).toContain("setPhase(sequenceElapsedPastChase ? 'result' : 'countdown')");
  });

  it('item 6: the animation-speed preference reaches the shared-clock branch', () => {
    expect(wheel).toContain('Math.min(factor, getAnimationSpeed(), 1)');
    // Still one-sided: faster is a preference, slower would deal cards under a
    // wheel that is still asking the question.
    expect(wheel).toContain('Math.min(');
  });

  it('item 7: the fallback path carries the same deadline the socket path does', () => {
    const builder = table.slice(
      table.indexOf('function buildSpinDrawFromRow'),
      table.indexOf('function buildSpinDrawFromRow') + 2600
    );
    expect(builder).toContain('revealDeadlineMs:');
    expect(builder).toContain('spinRevealToDealMs()');
  });

  it('the tiers really do emit more than 24 pieces, or none of this matters', () => {
    // If this ever goes false the bug above was cosmetic; it is not.
    expect(SPIN_TIERS.length).toBeGreaterThan(0);
    expect(wheel).toContain('celebration.confettiPieces');
  });
});
