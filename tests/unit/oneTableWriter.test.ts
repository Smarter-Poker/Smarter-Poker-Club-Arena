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
  it('is the sanctioned two in src/, and nothing else', () => {
    expect(tableInserters()).toEqual(
      [
        // 2026-08-27: TableService left this list. Its createTable was the
        // Create Table modal's service, and the modal had zero imports — the
        // whole path was unreachable. Deleted, not preserved.
        //
        // 2026-09-04 (Operation Table Stakes, Slice 1): TableConfigPage left
        // it too. A cash game is created by fn_cash_game_create in SQL — the
        // cash_games row AND its Main 1 tables row in one function — and the
        // page's Regular tab renders CashGameCreateFlow, which calls that RPC
        // and never touches `tables`. The browser no longer has a column list
        // to get wrong.
        //
        // Tournament tables. Sized from the tournament's own structure, never
        // through the cash path.
        'src/services/TournamentService.ts',
        // The horse fleet's own tables.
        'src/services/HorseOrchestrator.ts',
      ].sort()
    );
  });

  it('the cash writer is the SQL function, reached by exactly one RPC call', () => {
    const flow = fs.readFileSync(path.join(SRC, 'components/cash/CashGameCreateFlow.tsx'), 'utf8');
    expect(flow.match(/supabase\.rpc\('fn_cash_game_create'/g)?.length).toBe(1);
    expect(flow).not.toMatch(/\.from\(\s*'tables'\s*\)/);
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20260904160500_cash_games_slice_1.sql'),
      'utf8'
    );
    expect(sql.match(/INSERT INTO public\.tables \(/g)?.length).toBe(1);
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

describe('Save and Start both create tables the engine can adopt', () => {
  const page = fs.readFileSync(path.join(SRC, 'pages/TableConfigPage.tsx'), 'utf8');
  const flow = fs.readFileSync(path.join(SRC, 'components/cash/CashGameCreateFlow.tsx'), 'utf8');
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20260904160500_cash_games_slice_1.sql'),
    'utf8'
  );

  it("neither writes status 'active', which no engine query matches", () => {
    // cash_tables_needing_engine selects status IN ('waiting','running').
    // 'active' is a legal value nothing reads: a table inserted with it sits
    // in the lobby forever and never deals. This test USED TO PIN that bug
    // ("Start writes status 'active'"); it now pins the fix.
    expect(page).not.toContain("status: 'active'");
    expect(sql).toMatch(/^\s*'waiting', 0, v_uid,\s*$/m);
  });

  it('neither writes is_template, which nothing anywhere reads', () => {
    expect(page).not.toContain('is_template: true');
    expect(sql).not.toMatch(/INSERT INTO public\.tables \([\s\S]*?is_template[\s\S]*?\) VALUES/);
  });

  it('both go through the SAME create, so a feature cannot reach one and not the other', () => {
    // One `create(mode)`; Save and Start differ only in where they go next.
    expect(flow.match(/void create\('save'\)/g)?.length).toBe(1);
    expect(flow.match(/void create\('start'\)/g)?.length).toBe(1);
    expect(flow.match(/supabase\.rpc\('fn_cash_game_create'/g)?.length).toBe(1);
  });

  it('the Cap is not offered, and not written, so the column default (false) holds', () => {
    // cap_enabled alone was never a cap: the engine computes the ceiling from
    // cap_bb and treats <= 0 as uncapped. OPORD 1.3 section 8 offers no cap
    // on any cash game; the row keeps 010_table_configuration.sql's default.
    expect(flow).not.toMatch(/label="Cap"/);
    expect(sql).not.toMatch(/INSERT INTO public\.tables \([\s\S]*?\bcap_bb\b[\s\S]*?\) VALUES/);
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
