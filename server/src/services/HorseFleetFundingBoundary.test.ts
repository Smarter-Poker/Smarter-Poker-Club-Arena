import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fleetFundingFor,
  isDiamondArenaTable,
  isFleetTable,
  wholeDiamondBuyIn,
} from './HorseFleetFundingBoundary.js';

/**
 * Dan 2026-09-10: "start linking and giving all the horses across all clubs
 * access to the diamond arena. they need to be able to fully play in the
 * diamond arena, just like they can in the club arena."
 *
 * Before that ruling this file pinned the fleet OUT of diamond tables. The
 * boundary that survives is the wallet: a chip seat is paid from the club,
 * a diamond seat from the horse's own diamonds, and a table whose arena
 * cannot be read gets no horse at all.
 */
describe('the fleet sits in chip arenas and in the platform Diamond Arena', () => {
  const rows = [
    { club_id: 'chips', arena: { id: 'chips', asset: 'chips', is_platform: false } },
    { club_id: null, union_id: 'union', arena: null },
    {
      club_id: 'diamond',
      arena: { id: 'diamond', asset: 'diamonds', is_platform: true, union_id: null },
    },
    { club_id: 'missing' },
    { club_id: 'wrong', arena: { id: 'chips', asset: 'chips', is_platform: false } },
    {
      club_id: 'rogue',
      arena: { id: 'rogue', asset: 'diamonds', is_platform: false, union_id: null },
    },
  ];

  it('keeps chip clubs, union tables and the platform arena; refuses unknown scope and a non-platform diamond club', () => {
    expect(rows.filter(isFleetTable)).toEqual(rows.slice(0, 3));
    expect(rows.map(fleetFundingFor)).toEqual(['chips', 'chips', 'diamonds', null, null, null]);
    expect(rows.filter(isDiamondArenaTable)).toEqual([rows[2]]);
  });

  it('is the filter the seeding cycle applies before candidate allocation', () => {
    const source = readFileSync('src/services/HorseFleetManager.ts', 'utf8');
    expect(source).toContain('arena:clubs!fk_tables_club_id(id, asset, is_platform, union_id)');
    expect(source).toContain('const tables = tablePage.rows.filter(isFleetTable);');
    // The arena roll is the horse's own diamonds, never a club_members row.
    expect(source).toContain('bankrolls.set(`${arena}:${h.id}`, Number.isFinite(diamonds) ? diamonds : 0)');
    // A diamond door needs a receipt key; the chip door keeps its old call.
    expect(source).toContain("p_idempotency_key: funding === 'diamonds' ? randomUUID() : null");
  });

  it('sizes a diamond buy-in to a whole number inside the table limits', () => {
    expect(wholeDiamondBuyIn(227.4, 80, 400)).toBe(227);
    expect(wholeDiamondBuyIn(79.6, 80, 400)).toBe(80);
    expect(wholeDiamondBuyIn(900, 80, 400)).toBe(400);
    expect(wholeDiamondBuyIn(0, 80, 400)).toBe(0);
    expect(wholeDiamondBuyIn(Number.NaN, 80, 400)).toBe(0);
    expect(wholeDiamondBuyIn(100, 400, 80)).toBe(0);
  });
});
