/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A DIAMOND MYSTERY CHEST HOLDS WHOLE DIAMONDS (Diamond Phase 9)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The chest inventory is built by the engine and sealed by the database
 * (`fn_mystery_bounty_seed`), which now refuses any chest that is not a whole
 * number of the event's units. `buildInventoryAtUnit` builds the same ladder
 * in units and scales back to cents: at a chip unit it is `buildInventory` to
 * the cent, by construction; at a Diamond unit every chest is a whole number
 * of Diamonds, the pool is spent exactly, and the ladder is the same shape.
 *
 * The manager no longer seeds with a unit it has not read: a null unit
 * (club not read) refuses to seed and reports, rather than building an
 * inventory the seed would refuse.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  assertInventory,
  buildInventory,
  buildInventoryAtUnit,
  summariseInventory,
} from './mysteryBountyPool.js';
import { CHIP_UNIT_CENTS, DIAMOND_UNIT_CENTS } from './tournamentUnit.js';

const manager = readFileSync(resolve(__dirname, 'TournamentManagerBase.ts'), 'utf8');

describe('a Diamond mystery chest holds whole Diamonds', () => {
  it('at the chip unit the inventory is the cent-exact inventory, by construction', () => {
    for (const [pool, draw] of [
      [1_833_00, 27],
      [12_345, 7],
      [100, 3],
    ] as const) {
      expect(buildInventoryAtUnit(pool, draw, 'classic', 20, CHIP_UNIT_CENTS)).toEqual(
        buildInventory(pool, draw, 'classic', 20)
      );
    }
  });

  it('at the Diamond unit every chest is a whole number of Diamonds and the pool is spent exactly', () => {
    for (const [poolDiamonds, draw, profile] of [
      [100, 3, 'classic'],
      [1_000, 27, 'classic'],
      [80, 2, 'balanced'],
      [12_345, 149, 'jackpot'],
      [7, 7, 'classic'],
    ] as const) {
      const poolCents = poolDiamonds * DIAMOND_UNIT_CENTS;
      const chests = buildInventoryAtUnit(poolCents, draw, profile, 20, DIAMOND_UNIT_CENTS);
      assertInventory(chests, poolCents, draw);
      for (const c of chests) {
        expect(c.amountCents % DIAMOND_UNIT_CENTS).toBe(0);
        expect(c.amountCents).toBeGreaterThanOrEqual(DIAMOND_UNIT_CENTS);
      }
      expect(chests.reduce((s, c) => s + c.amountCents, 0)).toBe(poolCents);
      // the same ladder as the unit ladder, scaled
      const units = buildInventory(poolDiamonds, draw, profile, 20);
      expect(chests.map((c) => c.amountCents)).toEqual(
        units.map((c) => c.amountCents * DIAMOND_UNIT_CENTS)
      );
      expect(summariseInventory(chests).length).toBe(summariseInventory(units).length);
    }
  });

  it('refuses a pool that is not on the unit, a draw the pool cannot fund in whole Diamonds, and a unit it cannot read', () => {
    expect(() => buildInventoryAtUnit(10_050, 3, 'classic', 20, DIAMOND_UNIT_CENTS)).toThrow(
      /whole number of units/
    );
    expect(() => buildInventoryAtUnit(300, 4, 'classic', 20, DIAMOND_UNIT_CENTS)).toThrow(
      /cannot fund/
    );
    expect(() => buildInventoryAtUnit(10_000, 3, 'classic', 20, 0)).toThrow(/unit must be/);
    expect(() => buildInventoryAtUnit(10_000, 3, 'classic', 20, Number.NaN)).toThrow(
      /unit must be/
    );
  });

  it('the manager seeds at the unit it read, and refuses to seed at one it has not', () => {
    const site = manager.slice(
      manager.indexOf('protected async maybeActivateMysteryBounty('),
      manager.indexOf("await this.broadcast('mystery_bounty_activated'")
    );
    expect(site).toContain('const unitCents = this.tournamentUnit();');
    expect(site).toContain('if (unitCents == null) {');
    expect(site).toContain("'Tournament.mystery_bounty_unit_unknown'");
    expect(site).toContain(
      'buildInventoryAtUnit(poolCents, decision.drawCount, profile, topPercent, unitCents)'
    );
    expect((site.match(/\bunitCents\n\s*\);/g) ?? []).length).toBe(2);
    expect(site).not.toContain('UNIT_CENTS_ASSET_NOT_READ');
    expect(manager).not.toMatch(
      /import \{[^}]*UNIT_CENTS_ASSET_NOT_READ[^}]*\} from '\.\/tournamentUnit\.js'/
    );
  });
});
