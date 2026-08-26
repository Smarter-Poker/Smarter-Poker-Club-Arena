/**
 * The fleet can retire a table, not only create one.
 *
 * spawnOverflowTables() capped creation at MAX_TABLES_PER_CONFIG and left a
 * comment saying "the stale-table lifecycle owns closing". No such lifecycle
 * was ever written — nothing anywhere closed an idle cash table. So when
 * ensureAllTablesExist() began duplicating rows on every boot, the count only
 * went one way: 121 rows named 'NLH 1.00/2.00', 495 fleet tables in all.
 *
 * These tests pin the two halves that make it converge:
 *   - a surplus table is not seeded, so it can empty;
 *   - once empty it is closed, and while occupied it is not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

type Table = { id: string; name: string; created_at: string; current_players?: number };

/** The surplus computation, exactly as seedAllTables performs it. */
function surplusOf(tables: Table[], configNames: string[], cap: number): Set<string> {
  const surplus = new Set<string>();
  for (const name of configNames) {
    const family = tables
      .filter((t) => t.name === name || t.name.startsWith(`${name} #`))
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    for (const t of family.slice(cap)) surplus.add(t.id);
  }
  return surplus;
}

const mk = (n: number, name: string): Table[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${name}-${i}`,
    name,
    created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    current_players: 0,
  }));

describe('surplus identification', () => {
  it('keeps the three OLDEST and marks the rest surplus', () => {
    const tables = mk(121, 'NLH 1.00/2.00');
    const surplus = surplusOf(tables, ['NLH 1.00/2.00'], 3);
    expect(surplus.size).toBe(118);
    expect(surplus.has('NLH 1.00/2.00-0')).toBe(false);
    expect(surplus.has('NLH 1.00/2.00-1')).toBe(false);
    expect(surplus.has('NLH 1.00/2.00-2')).toBe(false);
    expect(surplus.has('NLH 1.00/2.00-3')).toBe(true);
  });

  it('keeps the canonical row ensureAllTablesExist would pick (the oldest)', () => {
    const tables = mk(5, 'PLO6 1.00/2.00');
    const surplus = surplusOf(tables, ['PLO6 1.00/2.00'], 3);
    expect(surplus.has('PLO6 1.00/2.00-0')).toBe(false); // oldest — the canonical one
  });

  it('marks nothing surplus when a config is at or under the cap', () => {
    expect(surplusOf(mk(3, 'PLO8 1.00/2.00'), ['PLO8 1.00/2.00'], 3).size).toBe(0);
    expect(surplusOf(mk(1, 'PLO8 1.00/2.00'), ['PLO8 1.00/2.00'], 3).size).toBe(0);
  });

  it('counts the "#2"/"#3" overflow names as part of the same family', () => {
    const tables: Table[] = [
      { id: 'a', name: 'PLO4 1.00/2.00', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', name: 'PLO4 1.00/2.00 #2', created_at: '2026-01-02T00:00:00Z' },
      { id: 'c', name: 'PLO4 1.00/2.00 #3', created_at: '2026-01-03T00:00:00Z' },
      { id: 'd', name: 'PLO4 1.00/2.00 #4', created_at: '2026-01-04T00:00:00Z' },
    ];
    const surplus = surplusOf(tables, ['PLO4 1.00/2.00'], 3);
    expect([...surplus]).toEqual(['d']);
  });

  it('does not sweep a DIFFERENT config into the family', () => {
    const tables: Table[] = [...mk(4, 'NLH 1.00/2.00'), ...mk(4, 'NLH 2.00/5.00')];
    // Each family is capped independently: 1 surplus each, not 5.
    expect(surplusOf(tables, ['NLH 1.00/2.00', 'NLH 2.00/5.00'], 3).size).toBe(2);
  });
});

describe('retirement safety', () => {
  /** The filter retireSurplusTables applies before closing anything. */
  const retirable = (tables: Table[], surplus: Set<string>, seats: Array<{ table_id: string }>) => {
    const occupied = new Set(seats.map((s) => s.table_id));
    return tables.filter(
      (t) => surplus.has(t.id) && !occupied.has(t.id) && Number(t.current_players ?? 0) === 0
    );
  };

  it('retires an empty surplus table', () => {
    const tables = mk(5, 'PLO5 1.00/2.00');
    const surplus = surplusOf(tables, ['PLO5 1.00/2.00'], 3);
    expect(retirable(tables, surplus, []).map((t) => t.id)).toEqual([
      'PLO5 1.00/2.00-3',
      'PLO5 1.00/2.00-4',
    ]);
  });

  it('leaves a surplus table alone while ANYONE is seated at it', () => {
    const tables = mk(5, 'PLO5 1.00/2.00');
    const surplus = surplusOf(tables, ['PLO5 1.00/2.00'], 3);
    const seats = [{ table_id: 'PLO5 1.00/2.00-3' }];
    expect(retirable(tables, surplus, seats).map((t) => t.id)).toEqual(['PLO5 1.00/2.00-4']);
  });

  it('trusts current_players too, not only the seat rows', () => {
    const tables = mk(5, 'PLO5 1.00/2.00');
    tables[4].current_players = 2; // counter says occupied, seat fetch missed it
    const surplus = surplusOf(tables, ['PLO5 1.00/2.00'], 3);
    expect(retirable(tables, surplus, []).map((t) => t.id)).toEqual(['PLO5 1.00/2.00-3']);
  });

  it('never touches a table inside the cap, empty or not', () => {
    const tables = mk(3, 'PLO5 1.00/2.00');
    expect(retirable(tables, surplusOf(tables, ['PLO5 1.00/2.00'], 3), [])).toEqual([]);
  });
});

describe('the shipped wiring', () => {
  it('spawning and retiring share ONE cap constant', () => {
    // Two different numbers would make the fleet spawn and retire forever.
    expect(SRC).toMatch(/^const MAX_TABLES_PER_CONFIG = 3;$/m);
    expect(SRC).not.toMatch(/\s{4}const MAX_TABLES_PER_CONFIG/); // no local shadow
  });

  it('surplus tables are skipped by the seeding loop', () => {
    expect(SRC).toContain('if (surplusTableIds.has(table.id)) continue;');
  });

  it('retireSurplusTables is actually called from the cycle', () => {
    expect(SRC).toContain('await this.retireSurplusTables(');
  });

  it('closes rather than deletes, and only cash tables', () => {
    const m = /private async retireSurplusTables[\s\S]*?\n {2}}\n/.exec(SRC);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("status: 'closed'");
    expect(m![0]).toContain("is('tournament_id', null)");
    expect(m![0]).not.toContain('.delete(');
  });

  it('selects created_at, without which the family order is undefined', () => {
    expect(SRC).toContain('current_players, created_at');
  });
});
