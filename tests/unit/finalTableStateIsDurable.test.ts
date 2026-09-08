/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A ONE-SHOT BROADCAST IS NOT A STATE (Dan 2026-08-28, bug 7)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE FINAL TABLE ... YOU CAN NOT SEE THE FINAL TABLE
 * BACKGROUND EITHER."
 *
 * `TournamentManager.isFinalTable` is an in-memory flag on one process, and
 * the `final_table` announcement is sent ONCE. Anyone not listening at that
 * instant never learns the tournament reached its final table: a player who
 * reconnects (which is exactly what happened, see bug 1), a second device, a
 * spectator arriving later, or every client at once if the engine restarts.
 *
 * The client's fallback was A REGEX ON THE TABLE NAME —
 * `/\bfinal table\b/i.test(table.name)` — on the stated grounds that
 * "TournamentService canonically names the consolidated table 'Final Table'".
 * Production disagrees: 4f42d847's final table is named "Union PKO Afternoon
 * (PLO4) - Table 2". The fallback matched nothing and the background never
 * loaded.
 *
 * Meanwhile `tournaments.final_table_triggered` had existed as a column the
 * whole time and NOTHING EVER WROTE IT: measured on production, 0 of 1,286
 * completed MTTs in thirty days had it set.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MANAGER = read('server/src/tournament/TournamentManager.ts');
const TABLEPAGE = read('src/pages/TablePage.tsx');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('the engine persists the final table, not just announces it', () => {
  const M = code(MANAGER);

  it('writes final_table_triggered when it declares', () => {
    expect(M).toMatch(/\.update\(\{ final_table_triggered: true \}\)/);
  });

  it('scopes the write to this tournament', () => {
    expect(M).toMatch(
      /update\(\{ final_table_triggered: true \}\)[\s\S]{0,120}?\.eq\('id', this\.tournamentId\)/
    );
  });

  it('is idempotent, so an engine restart cannot re-announce forever', () => {
    expect(M).toMatch(/\.eq\('final_table_triggered', false\)/);
  });

  it('still broadcasts — the write is additional, not a replacement', () => {
    expect(M).toMatch(/this\.broadcast\('final_table'/);
  });

  it('reports a failed write instead of swallowing it', () => {
    expect(M).toMatch(/final_table_flag_write_failed/);
  });

  it('still requires ONE live table, not just a headcount', () => {
    // Guarding the 2026-08-27 P0: nine players across three felts is not a
    // final table, and fn_final_table_deal would have chopped between them.
    expect(M).toMatch(/liveTables === 1/);
  });
});

describe('the client asks for the final table instead of inferring it', () => {
  const C = code(TABLEPAGE);

  it('selects final_table_triggered from the tournament row', () => {
    expect(C).toMatch(/final_table_triggered/);
    expect(C).toMatch(/\.select\(\s*'[^']*tournament_type[^']*final_table_triggered[^']*'\s*\)/);
  });

  it('turns the theme on when the tournament says so', () => {
    expect(C).toMatch(/if \(tournData\?\.final_table_triggered\)/);
    expect(C).toMatch(/isFinalTable: true/);
  });

  it('only ever turns it ON, never off', () => {
    // The live broadcast and the name regex stay as they were; an unreadable
    // row must leave whatever they decided rather than clearing the theme.
    expect(C).toMatch(/prev\.isFinalTable \? prev : \{ \.\.\.prev, isFinalTable: true \}/);
  });

  it('still applies the final-table background off that state', () => {
    expect(C).toMatch(/isFinalTable \? 'final_table_broadcast'/);
  });
});
