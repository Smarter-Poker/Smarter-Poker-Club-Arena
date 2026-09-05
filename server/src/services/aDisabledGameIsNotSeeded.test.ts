/**
 * THE FLEET DOES NOT SEAT A DISABLED GAME (2026-09-05).
 *
 * `cash_games.enabled = false` is the operator's switch (OPORD 1.4 18.4: "no
 * seeding, no opening; empties close"). The seeding loop skipped a cluster
 * table only when its lifecycle was 'breaking' or 'closed' and never asked
 * whether the game was enabled.
 *
 * Measured (production, read 2026-09-05 03:45 CDT): "NLH 0.05/0.10 Classic"
 * (37ac7634-69dd-434c-b947-bfcf8941ecf4) was disabled by an operator at 16:47
 * CDT on 2026-09-04; between 01:10 and 03:41 the next morning the fleet
 * seated five horses onto its feeder (dbbc148e-384a-4c38-abb6-833b2d2847ff)
 * and it dealt 76 hands in the last hour. 30 games were disabled at the time.
 *
 * Two halves, in the style of aBarredHorseIsNotABuyer.test.ts: the RULE is
 * proven behaviourally against the pure module, and the SEEDING PATH is
 * proven wired to it by source contract, because seatHorse ends in
 * atomic_table_buyin against production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDisabledGameIds, isTableOfDisabledGame } from './HorseDisabledGames.js';

const DISABLED_GAME = '37ac7634-69dd-434c-b947-bfcf8941ecf4';
const ENABLED_GAME = '0d4b4fd0-1d5e-4b3c-9c1e-6a9a5d2f1b11';

describe('the rule: a table of a disabled game is skipped, its neighbour is not', () => {
  const disabled = buildDisabledGameIds([{ id: DISABLED_GAME }]);

  it('the disabled game feeder is skipped, lifecycle notwithstanding', () => {
    const feeder = {
      id: 'dbbc148e-384a-4c38-abb6-833b2d2847ff',
      cluster_id: DISABLED_GAME,
      lifecycle: 'live',
      role: 'feeder',
    };
    expect(isTableOfDisabledGame(feeder, disabled)).toBe(true);
    // an 'opening' feeder of the same game is skipped just the same - 18.4 is
    // "no seeding, no opening", not "no seeding once it is live"
    const opening = { ...feeder, lifecycle: 'opening' };
    expect(isTableOfDisabledGame(opening, disabled)).toBe(true);
  });

  it('an enabled game beside it is unaffected', () => {
    const neighbour = {
      id: 'main-1-of-an-enabled-game',
      cluster_id: ENABLED_GAME,
      lifecycle: 'live',
    };
    expect(isTableOfDisabledGame(neighbour, disabled)).toBe(false);
  });

  it('a legacy (non-cluster) table is never "of a disabled game"', () => {
    expect(isTableOfDisabledGame({ cluster_id: null }, disabled)).toBe(false);
    expect(isTableOfDisabledGame({}, disabled)).toBe(false);
  });

  it('a failed read (empty set) disables NOTHING - fail open, never fail closed', () => {
    const none = buildDisabledGameIds([]);
    expect(none.size).toBe(0);
    expect(isTableOfDisabledGame({ cluster_id: DISABLED_GAME }, none)).toBe(false);
  });

  it('the set is built from what the page returned, as strings, ignoring blanks', () => {
    const set = buildDisabledGameIds([
      { id: DISABLED_GAME },
      { id: ENABLED_GAME },
      { id: '' },
      { id: null as unknown as string },
    ]);
    expect(set.size).toBe(2);
    expect(set.has(DISABLED_GAME)).toBe(true);
    expect(set.has(ENABLED_GAME)).toBe(true);
  });

  it('thirty disabled games skip thirty tables and leave the thirty-first alone', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    const set = buildDisabledGameIds(rows);
    const tables = [
      ...rows.map((r, i) => ({ id: `t${i}`, cluster_id: r.id })),
      { id: 't30', cluster_id: ENABLED_GAME },
    ];
    const skipped = tables.filter((t) => isTableOfDisabledGame(t, set));
    expect(skipped.length).toBe(30);
    expect(skipped.find((t) => t.id === 't30')).toBeUndefined();
  });
});

const SRC = readFileSync(join(process.cwd(), 'src/services/HorseFleetManager.ts'), 'utf8');

/** seedAllTables itself, without the helpers that follow it. */
const SEED = SRC.slice(
  SRC.indexOf('private async seedAllTables('),
  SRC.indexOf('\n  private async ', SRC.indexOf('private async seedAllTables(') + 1)
);
const LOOP = SEED.slice(SEED.indexOf('for (const table of tablesToSeed)'));
const CLAIM = SRC.slice(
  SRC.indexOf('private async claimOfferedSeats('),
  SRC.indexOf('private computeHorseBuyIn(')
);

describe('the seeding path reads the switch once per cycle', () => {
  it('loads cash_games where enabled = false through fetchAllRows, keyset on id', () => {
    expect(SEED).toContain("from('cash_games')");
    const from = SEED.indexOf("from('cash_games')");
    const to = SEED.indexOf("label: 'HorseFleet.disabledGames'");
    expect(to).toBeGreaterThan(from);
    const read = SEED.slice(from, to);
    expect(read).toMatch(/\.eq\('enabled',\s*false\)/);
    expect(read).toMatch(/\.order\('id',\s*\{\s*ascending:\s*true\s*\}\)/);
    expect(read).toContain('.limit(want)');
    expect(read).toMatch(/q\.gt\('id',\s*cursor\)/);
    expect(read).not.toContain('.range(');
  });

  it('ONCE - beside the rejoin loader, before the table loop', () => {
    expect((SRC.match(/HorseFleet\.disabledGames/g) || []).length).toBe(1);
    const loaderAt = SEED.indexOf("from('cash_games')");
    expect(loaderAt).toBeGreaterThan(SEED.indexOf("from('cash_rejoin_constraints')"));
    expect(loaderAt).toBeLessThan(SEED.indexOf('for (const table of tablesToSeed)'));
  });

  it('fails OPEN and says so: a failed or short read counts, and the set stays empty', () => {
    expect(SEED).toContain('let disabledGameIds = new Set<string>();');
    expect(SEED).toMatch(
      /if \(disabledPage\.complete\) \{\s*disabledGameIds = buildDisabledGameIds\(disabledPage\.rows\);\s*\} else \{\s*beat\.disabledGamesReadFailed = 1;/
    );
    expect(SEED).toMatch(
      /catch \(err\) \{\s*beat\.disabledGamesReadFailed = 1;\s*reportError\(err, 'HorseFleet\.disabled_games_load_failed'\);/
    );
    // and nowhere does a failed read become "everything is disabled"
    expect(SEED).not.toMatch(/disabledGameIds\s*=\s*new Set\(\s*tables/);
  });
});

describe('the seeding loop', () => {
  it('skips a disabled game table exactly like a breaking one: before seat arithmetic, before nextEligible, counted', () => {
    const skipAt = LOOP.indexOf('if (isTableOfDisabledGame(table, disabledGameIds)) {');
    expect(skipAt).toBeGreaterThan(0);
    expect(LOOP.slice(skipAt)).toMatch(
      /^if \(isTableOfDisabledGame\(table, disabledGameIds\)\) \{\s*disabledGameTables\+\+;\s*continue;\s*\}/
    );
    // right after the lifecycle skip, before the first seat is counted
    expect(skipAt).toBeGreaterThan(
      LOOP.indexOf("if (table.lifecycle === 'breaking' || table.lifecycle === 'closed') continue;")
    );
    expect(skipAt).toBeLessThan(LOOP.indexOf('const tableOccupiedSeats'));
    expect(skipAt).toBeLessThan(LOOP.indexOf('const currentCount'));
    // and before anything that would give the game a buyer count: a skipped
    // table has no pool and no nextEligible entry, so eligibleHorseCount is 0
    expect(skipAt).toBeLessThan(LOOP.indexOf('clusterPools.push('));
    expect(skipAt).toBeLessThan(LOOP.indexOf('nextEligible.set('));
    expect(SRC).toMatch(
      /eligibleHorseCount\(tableId: string\): number \{\s*return this\.lastEligibleByTable\.get\(tableId\) \?\? 0;/
    );
  });

  it('the count reaches the beat and the cycle summary line, and a failed read is named there', () => {
    expect(SEED).toContain('let disabledGameTables = 0;');
    expect(SEED).toContain('beat.disabledGameTables = disabledGameTables;');
    expect(SEED).toContain('table(s) of disabled games skipped');
    expect(SEED).toContain('disabled games: READ FAILED, none skipped (fail open)');
    expect(SEED).toMatch(/Seeding cycle took \$\{cycleSeconds\}s\$\{disabledNote\}/);
    // the pulse carries both numbers
    expect(SRC).toContain('disabled_game_tables: beat.disabledGameTables,');
    expect(SRC).toContain('disabled_games_read_failed: beat.disabledGamesReadFailed,');
  });
});

describe('a seat call on a disabled game is not answered', () => {
  it('claimOfferedSeats takes the same set and asks the same predicate, before the hold is read', () => {
    expect(CLAIM).toMatch(/disabledGameIds: ReadonlySet<string> = new Set<string>\(\)/);
    const skipAt = CLAIM.indexOf('if (isTableOfDisabledGame(table, disabledGameIds)) continue;');
    expect(skipAt).toBeGreaterThan(
      CLAIM.indexOf('if (surplusTableIds.has(String(offer.table_id))) continue;')
    );
    expect(skipAt).toBeLessThan(CLAIM.indexOf('const expiresAt'));
    expect(skipAt).toBeLessThan(CLAIM.indexOf('await this.seatHorse('));
    // and the cycle passes what it read
    expect(SEED).toMatch(/surplusTableIds,\s*seatBudget,\s*rejoin,\s*disabledGameIds\s*\)/);
  });

  it('one predicate, two callers - no second copy of the rule', () => {
    expect((SRC.match(/isTableOfDisabledGame\(/g) || []).length).toBe(2);
    expect(SRC).not.toMatch(/disabledGameIds\.has\(/);
  });
});
