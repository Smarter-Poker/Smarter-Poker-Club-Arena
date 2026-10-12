/**
 * The tile-view action band sends the raise its button names (launch audit
 * 2026-10-05). Every amount is a raise-TO absolute.
 *
 * Before: "All In" sent the stack BEHIND (not a raise-to), and the pot buttons
 * sent `toCall + (pot + 2 * toCall) * f` capped at the stack behind, which
 * lands under the minimum raise from the small blind and in most re-raise
 * spots, so the engine refused it.
 */
import { describe, expect, it } from 'vitest';
import { parseTileRaiseBounds, tileAllInTo, tilePotRaiseTo } from '../../src/utils/tileRaiseSizing';
import { potSizedRaiseTo } from '../../src/components/table/ActionPanel';

describe('parseTileRaiseBounds', () => {
  it('reads "minTo:maxTo:bb"', () => {
    expect(parseTileRaiseBounds('4:200:2')).toEqual({ minTo: 4, maxTo: 200, bb: 2 });
  });
  it.each([undefined, '', '4:200', 'a:b:c', '0:200:2', '10:4:2'])(
    'no legal raise for %j',
    (raw) => {
      expect(parseTileRaiseBounds(raw)).toBeNull();
    }
  );
});

describe('the pot buttons send a raise-to the engine will accept', () => {
  // 1/2 no-limit, hero is the small blind (1 in front), folded to hero.
  const sbSpot = { pot: 3, toCall: 1, currentBet: 2 };
  const sbBounds = parseTileRaiseBounds('4:200:2');

  it('half pot from the small blind is a legal raise (the old formula sent 3.5, under the minimum 4)', () => {
    const old = Math.round((sbSpot.toCall + (sbSpot.pot + sbSpot.toCall * 2) * 0.5) * 100) / 100;
    expect(old).toBe(3.5);
    expect(old).toBeLessThan(sbBounds!.minTo);
    expect(tilePotRaiseTo(0.5, sbSpot, sbBounds)).toBe(4);
  });

  it('pot is exactly the single-table pot raise', () => {
    expect(tilePotRaiseTo(1, sbSpot, sbBounds)).toBe(
      potSizedRaiseTo(sbSpot.currentBet, sbSpot.pot, sbSpot.toCall)
    );
    // Facing a bet of 10 into 15 (pot now 25): call 10, raise the 35 that makes.
    const facing = { pot: 25, toCall: 10, currentBet: 10 };
    expect(tilePotRaiseTo(1, facing, parseTileRaiseBounds('20:500:2'))).toBe(45);
    expect(tilePotRaiseTo(0.5, facing, parseTileRaiseBounds('20:500:2'))).toBe(27.5);
  });

  it('is to the cent, never rounded to a chip', () => {
    const micro = { pot: 0.15, toCall: 0.05, currentBet: 0.1 };
    expect(tilePotRaiseTo(1, micro, parseTileRaiseBounds('0.2:20:0.1'))).toBe(0.3);
    expect(tilePotRaiseTo(0.5, micro, parseTileRaiseBounds('0.2:20:0.1'))).toBe(0.2);
  });

  it('never leaves the bounds the engine reported', () => {
    const spot = { pot: 400, toCall: 50, currentBet: 100 };
    const bounds = parseTileRaiseBounds('150:180:2');
    expect(tilePotRaiseTo(1, spot, bounds)).toBe(180);
    expect(tilePotRaiseTo(0.01, spot, bounds)).toBe(150);
  });

  it('offers nothing when no raise is legal', () => {
    expect(tilePotRaiseTo(1, sbSpot, null)).toBeNull();
  });
});

describe('All In sends the whole stack as a raise-to', () => {
  it('includes the chips already in front (the old button sent 199 here, leaving 1 behind)', () => {
    // Small blind: 199 behind + 1 in front.
    expect(tileAllInTo(200, parseTileRaiseBounds('4:200:2'))).toBe(200);
  });

  it('a short stack below a full raise still goes all in at the engine ceiling', () => {
    // 28 total facing 100: the engine reports minTo = maxTo = the all-in.
    expect(tileAllInTo(28, parseTileRaiseBounds('28:28:2'))).toBe(28);
  });

  it('is not offered when the engine caps the raise under the stack (pot-limit, fixed-limit)', () => {
    expect(tileAllInTo(500, parseTileRaiseBounds('20:45:2'))).toBeNull();
  });

  it('is not offered when no raise is legal or the stack is unknown', () => {
    expect(tileAllInTo(200, null)).toBeNull();
    expect(tileAllInTo(undefined, parseTileRaiseBounds('4:200:2'))).toBeNull();
    expect(tileAllInTo(0, parseTileRaiseBounds('4:200:2'))).toBeNull();
  });
});

describe('the band uses these and nothing else', () => {
  it('MultiTablePage no longer sizes a raise from the stack behind', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'pages', 'MultiTablePage.tsx'),
      'utf8'
    );
    expect(src).not.toContain("handleTileAction(table.id, 'raise', table.heroStack)");
    expect(src).not.toContain('(pot + toCall * 2) * frac');
    expect(src).toContain('tilePotRaiseTo(');
    expect(src).toContain("handleTileAction(table.id, 'raise', tileAllIn)");
  });
});
