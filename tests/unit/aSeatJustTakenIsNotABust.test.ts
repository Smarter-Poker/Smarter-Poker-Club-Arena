import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRESH_SEAT_SETTLE_MS, bustPromptMustWait } from '../../src/utils/bustPromptGate';

const T0 = 1_800_000_000_000;

describe('a seat just taken is not a bust', () => {
  it('six seconds after buying in, a zero never preceded by chips waits', () => {
    // The production case: buy-in 19:40:05, "rebuy" 19:40:11.
    expect(
      bustPromptMustWait({ seatAcquiredAtMs: T0, chipsSeenSinceSeat: false, nowMs: T0 + 6_000 })
    ).toBe(FRESH_SEAT_SETTLE_MS - 6_000);
  });

  it('a real bust is prompted at once: chips were seen for this seat', () => {
    expect(
      bustPromptMustWait({ seatAcquiredAtMs: T0, chipsSeenSinceSeat: true, nowMs: T0 + 6_000 })
    ).toBe(0);
  });

  it('after the settling window a zero is prompted even if no chips were ever seen', () => {
    expect(
      bustPromptMustWait({
        seatAcquiredAtMs: T0,
        chipsSeenSinceSeat: false,
        nowMs: T0 + FRESH_SEAT_SETTLE_MS,
      })
    ).toBe(0);
  });

  it('a seat this tab did not take (a reload onto a bust) is prompted at once', () => {
    expect(
      bustPromptMustWait({ seatAcquiredAtMs: null, chipsSeenSinceSeat: false, nowMs: T0 })
    ).toBe(0);
  });

  it('a clock that ran backwards never holds the prompt', () => {
    expect(
      bustPromptMustWait({ seatAcquiredAtMs: T0, chipsSeenSinceSeat: false, nowMs: T0 - 5 })
    ).toBe(0);
  });

  it('the bust watch asks the gate before it opens the prompt, and looks again', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    const gate = src.indexOf('const waitMs = bustPromptMustWait({');
    const fire = src.indexOf('bustPromptFiredRef.current = true;', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(fire).toBeGreaterThan(gate);
    expect(src).toContain('setTimeout(() => setBustRecheckTick((n) => n + 1), waitMs + 50)');
    expect(src).toContain('chipsSeenForSeatAtRef.current = seatAcquiredAtRef.current;');
  });
});
