/**
 * A FULLER TABLE FILLS FIRST (Dan 2026-10-23, PLO).
 *
 * Measured 15:00 CDT: 71 players on 22 of 36 PLO tables, because the seeding
 * walk went by table id inside a rank and a scarce pool landed two horses on
 * every table. The walk now ranks the table with more players first inside
 * the same rank. The comparator is pure and tested directly; its place in the
 * walk is pinned against the shipped source (the walk needs a live database).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillFirstRank } from './HorseLoneTable.js';

const FLEET = readFileSync(resolve(__dirname, 'HorseFleetManager.ts'), 'utf8');

describe('a fuller table fills first', () => {
  it('sorts the table with more seated players ahead', () => {
    const tables = [
      { id: 'a', seated: 0 },
      { id: 'b', seated: 3 },
      { id: 'c', seated: 1 },
      { id: 'd', seated: 3 },
    ];
    const order = [...tables]
      .sort((x, y) => fillFirstRank(x.seated, y.seated) || x.id.localeCompare(y.id))
      .map((t) => t.id);
    expect(order).toEqual(['b', 'd', 'c', 'a']);
  });

  it('never lets an unreadable count jump the queue', () => {
    expect(fillFirstRank(Number.NaN, 2)).toBeGreaterThan(0);
    expect(fillFirstRank(2, Number.NaN)).toBeLessThan(0);
    expect(fillFirstRank(Number.NaN, Number.NaN)).toBe(0);
  });

  it('is wired into the seeding walk after the existing ranks and before the id', () => {
    expect(FLEET).toMatch(
      /clusterRank\(a\) - clusterRank\(b\) \|\|\s*compareCashPopulation\(\s*\{ \.\.\.a, occupied: seatsByTable\.get\(a\.id\)\?\.length \?\? 0 \},\s*\{ \.\.\.b, occupied: seatsByTable\.get\(b\.id\)\?\.length \?\? 0 \}\s*\) \|\|\s*fillFirstRank\(seatedAt\(a\), seatedAt\(b\)\) \|\|\s*String\(a\.id\)\.localeCompare\(String\(b\.id\)\)/
    );
    expect(FLEET).toContain(
      'const seatedAt = (t: { id: string }) => (seatsByTable.get(t.id) ?? []).length;'
    );
    // The short-handed human and the opening feeder still come first.
    const sort = FLEET.slice(
      FLEET.indexOf('const orderedTables'),
      FLEET.indexOf('fillFirstRank(seatedAt(a)')
    );
    expect(sort).toContain('Number(humanShort(b)) - Number(humanShort(a))');
    expect(sort).toContain('clusterRank(a) - clusterRank(b)');
  });
});
