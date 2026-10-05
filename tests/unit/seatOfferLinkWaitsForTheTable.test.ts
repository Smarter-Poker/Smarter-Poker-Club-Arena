/**
 * The waitlist seat-offer deep link (?buyin=1) opens the buy-in once the table
 * can act on it (launch audit 2026-10-05).
 *
 * The seat array paints before the table's asset is read. `handleSeatClick`
 * answers a tap in that gap with "Verifying Table Funding" and returns. The
 * deep-link effect latched `autoBuyInFiredRef` on that first render, so its one
 * automatic tap was spent on the refusal and never repeated: a waitlisted
 * player holding a 60-second seat offer landed on the table with no buy-in
 * sheet.
 *
 * TablePage cannot be mounted in a unit test, so this pins the order the
 * effect does things in: it must wait for the asset BEFORE it latches, and it
 * must re-run when the asset arrives.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');

function deepLinkEffect(): string {
  const start = SOURCE.indexOf('const autoBuyInFiredRef = useRef(false);');
  expect(start, 'the ?buyin=1 deep-link effect is gone').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('}, [', start);
  const closing = SOURCE.indexOf(']);', end);
  return SOURCE.slice(start, closing + 3);
}

describe('the ?buyin=1 seat-offer link waits for the table before it spends its one tap', () => {
  it('handleSeatClick still refuses a tap while the table asset is unread', () => {
    const handler = SOURCE.slice(
      SOURCE.indexOf('const handleSeatClick = (seatNumber: number) => {')
    );
    expect(handler.slice(0, 200)).toContain('if (!tableState.arenaAsset) {');
  });

  it('waits for the asset before latching, so the tap is not spent on that refusal', () => {
    const effect = deepLinkEffect();
    const wait = effect.indexOf('if (!tableState.arenaAsset) return;');
    const painted = effect.indexOf('if (!tableState.players.length) return;');
    // The latch that follows the waits (the first one belongs to the "no ?buyin=1" exit).
    const latch = effect.indexOf('autoBuyInFiredRef.current = true;', painted);
    const tap = effect.indexOf('handleSeatClick(openIdx + 1);');
    expect(painted).toBeGreaterThan(-1);
    expect(wait, 'the effect no longer waits for the table asset').toBeGreaterThan(painted);
    expect(latch).toBeGreaterThan(wait);
    expect(tap).toBeGreaterThan(latch);
  });

  it('re-runs when the asset arrives', () => {
    const effect = deepLinkEffect();
    const deps = effect.slice(effect.lastIndexOf('}, ['));
    expect(deps).toContain('tableState.arenaAsset');
    expect(deps).toContain('tableState.players');
    expect(deps).toContain('tableState.heroSeat');
  });
});
