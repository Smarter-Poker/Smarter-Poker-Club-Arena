import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * WHO IS ALLOWED TO CREATE A CASH TABLE.
 *
 * A cash table has over a hundred columns and the engine reads a specific
 * subset of them by exact name. Every extra writer is a chance to write a
 * column that does not exist, or to omit one that does — and both fail
 * SILENTLY, because Postgres accepts an insert that simply does not mention a
 * column and PostgREST accepts one that names an unknown key only to error at
 * runtime in a path nobody watches.
 *
 * That is not hypothetical. `TableCreationPage` wrote `min_buyin` /
 * `max_buyin` — the LEGACY duplicate columns — while the engine and
 * atomic_table_buyin both read `min_buy_in` / `max_buy_in`. Every table built
 * there had NULL buy-in limits: no minimum enforced, no maximum enforced, and
 * a blank buy-in range on its lobby card. It also never wrote `game_variant`,
 * which is the column the lobby classifies on. The page had no inbound link
 * from anywhere in the app — a dead route, reachable only by typing the URL,
 * quietly producing broken tables. It was deleted on 2026-08-25.
 *
 * This test pins the surviving writers. Adding one is allowed; adding one
 * WITHOUT NOTICING is what this stops.
 */

const SRC = path.join(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(d.name) ? [full] : [];
  });
}

/** Files containing a `.from('tables')` chained to an `.insert(`. */
function tableInserters(): string[] {
  const out: string[] = [];
  for (const file of filesUnder(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    // The chain can span lines, so match across them and ignore doc comments.
    const code = text.replace(/^\s*\*.*$/gm, '');
    if (/\.from\(\s*'tables'\s*\)[\s\S]{0,120}?\.insert\(/.test(code)) {
      out.push(path.relative(process.cwd(), file));
    }
  }
  return out.sort();
}

describe('exactly one writer per kind of table', () => {
  it('is the sanctioned four, and nothing else', () => {
    expect(tableInserters()).toEqual(
      [
        // The host's own creation screen: Save writes is_template, Start writes
        // status 'active'. Both build their payload from ONE buildTableData().
        'src/pages/TableConfigPage.tsx',
        // The Create Table modal's service. Maps settings onto the exact columns
        // the engine reads, and is the only writer that enforces the per-variant
        // seat cap.
        'src/services/TableService.ts',
        // Tournament tables. Sized from the tournament's own structure, never
        // through the cash path.
        'src/services/TournamentService.ts',
        // The horse fleet's own tables.
        'src/services/HorseOrchestrator.ts',
      ].sort()
    );
  });

  it('nobody writes the legacy min_buyin / max_buyin spellings', () => {
    // 36 of 44 live rows have min_buyin DISAGREEING with min_buy_in: the
    // legacy pair is stale garbage that nothing reads. Writing it is how a
    // table ends up with no enforced buy-in range at all.
    for (const file of tableInserters()) {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(text, `${file} writes the legacy buy-in spelling`).not.toMatch(
        /^\s*(min|max)_buyin\s*:/m
      );
    }
  });

  it('the dead TableCreationPage route is gone, not just unlinked', () => {
    expect(fs.existsSync(path.join(SRC, 'pages/TableCreationPage.tsx'))).toBe(false);
    const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
    expect(app).not.toContain('TableCreationPage');
    expect(app).not.toContain('table-creation');
  });
});

describe('Save and Start are told apart', () => {
  const page = fs.readFileSync(path.join(SRC, 'pages/TableConfigPage.tsx'), 'utf8');

  it('Save writes a template, Start writes a live table', () => {
    expect(page).toContain('is_template: true');
    expect(page).toContain("status: 'active'");
  });

  it('both build the SAME payload, so a feature cannot reach one and not the other', () => {
    const uses = page.match(/\.\.\.buildTableData\(resolvedId\)/g) || [];
    expect(uses.length).toBe(2);
  });
});

describe('launching a template copies the whole row', () => {
  it('goes through the RPC, not a hand-written column list', () => {
    const admin = fs.readFileSync(path.join(SRC, 'pages/AdminDashboardPage.tsx'), 'utf8');
    expect(admin).toContain('fn_launch_table_from_template');
    // The old eight-field copy is gone. Its tell was a `.from('tables')`
    // insert in this file at all.
    expect(tableInserters()).not.toContain('src/pages/AdminDashboardPage.tsx');
  });
});
