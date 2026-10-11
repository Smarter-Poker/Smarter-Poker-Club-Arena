/**
 * THE CLUB ARENA SHOWS NO DOLLAR SIGN (2026-10-09).
 *
 * Dan: "you are forbidden from using $ the dollar sign anywhere in the club
 * arena. it just needs to say 100 Chip Guarantee".
 *
 * scripts/ci/check-ui-dollar.mjs is the gate. This law proves it by RUNNING it:
 * over a throwaway tree holding every shape a rendered "$" has taken in this
 * codebase (it must fail and name each one), over a tree holding only the
 * machinery that legitimately spells the character (it must pass), and over
 * the real tree (it must pass, because the sweep is done). A regex over the
 * gate's own source would pass on a line that is present and wrong.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const GATE = join(ROOT, 'scripts/ci/check-ui-dollar.mjs');
const made: string[] = [];

function runGate(files: Record<string, string> | null) {
  const env = { ...process.env };
  delete env.UI_DOLLAR_SOURCE_DIR;
  if (files) {
    const dir = mkdtempSync(join(tmpdir(), 'ui-dollar-'));
    made.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    env.UI_DOLLAR_SOURCE_DIR = dir;
  }
  const r = spawnSync(process.execPath, [GATE], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('the Club Arena shows no dollar sign', () => {
  it('fails a sample "$100" UI string and names it', () => {
    const r = runGate({
      'Lobby.tsx': 'export const Lobby = () => <span>$100 Chip Guarantee</span>;\n',
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('Lobby.tsx:1: $100 Chip Guarantee');
  });

  it('fails every shape a rendered dollar sign has taken here', () => {
    const r = runGate({
      'shapes.tsx': [
        'export const a = (n: number) => <span>${n}</span>;',
        'export const b = (n: number) => `Cashout Paid You $${n}`;',
        "export const c = (n: number) => '$' + n;",
        "export function d({ currency = '$' }: { currency?: string }) { return currency; }",
        'export const e = <input placeholder="$100" />;',
        'export const f = <b>&#36;5</b>;',
        "export const g = (s: string, n: number) => s.replace('{amount}', '$' + n);",
        "export const h = 'Pay $5'.replace('Pay', 'Owe');",
        "export const i = [{ name: '$100 Freeroll' }];",
        '',
      ].join('\n'),
      'coin.css': ".coin::before { content: '$'; }\n",
      'page.html': '<p>Win $50</p>\n',
    });
    expect(r.status).toBe(1);
    for (const line of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(r.out, `shapes.tsx line ${line}`).toContain(`shapes.tsx:${line}:`);
    }
    expect(r.out).toContain('coin.css:1:');
    expect(r.out).toContain('page.html:1:');
  });

  it('passes the machinery that spells the character without showing it', () => {
    const r = runGate({
      'machinery.ts': [
        'export const a = (x: number) => `${x} Chips`;',
        "export const b = (s: string) => s.replace(/(\\d+)/g, '$1 Chips');",
        "export const c = new RegExp('^\\\\$');",
        "export const d = (s: string) => s.replace('$', '');",
        'export const e = (n: number) => console.log(`paid $${n}`);',
        "export const f = 'SELECT id FROM public.t WHERE id = $1::uuid';",
        'export type G = `$${number}`;',
        "export const h = ['$.schema', '$.provenance'];",
        "export const i: Array<[RegExp, string]> = [[/(token=)\\w+/g, '$1[redacted]']];",
        '',
      ].join('\n'),
    });
    expect(r.out).not.toContain('FAILED');
    expect(r.status).toBe(0);
  });

  it('fails the copy a database function writes with a dollar sign', () => {
    /* 2026-10-11: the jackpot crossing notice, the player search labels and a
       new club's first schedule name were all PL/pgSQL, which the gate did not
       read. These are those three shapes, verbatim. */
    const r = runGate({
      'shapes.sql': [
        'CREATE OR REPLACE FUNCTION public.f() RETURNS jsonb LANGUAGE sql AS $fn$',
        "  SELECT jsonb_build_object('name','Daily $25 Freezeout')",
        '$fn$;',
        'DO $do$',
        'BEGIN',
        "  PERFORM 'The Bad Beat Jackpot Just Passed $' || 5;",
        "  PERFORM concat('$', 1, '/$', 2);",
        "  PERFORM format('Pays $%s', 5);",
        "  EXECUTE 'SELECT ''Win $50'' FROM public.t WHERE id = $1' USING 1;",
        'END',
        '$do$;',
        '',
      ].join('\n'),
    });
    expect(r.status).toBe(1);
    for (const line of [2, 6, 7, 8, 9]) {
      expect(r.out, `shapes.sql line ${line}`).toContain(`shapes.sql:${line}:`);
    }
  });

  it('passes the SQL machinery that spells the character without showing it', () => {
    const r = runGate({
      'machinery.sql': [
        '-- a comment may say $100 Freeroll',
        '/* and so may a block comment: $5 */',
        'CREATE OR REPLACE FUNCTION public.g(p text) RETURNS text LANGUAGE plpgsql AS $fn$',
        'BEGIN',
        "  IF p ~ ('^wallet:' || p || '$') THEN RETURN replace(p, '$', ''); END IF;",
        "  IF position('$' IN p) > 0 OR p LIKE '%$%' THEN RETURN NULL; END IF;",
        "  EXECUTE format('SELECT %1$s FROM public.t WHERE id = $1 AND k = $2::uuid', p) USING 1, 2;",
        "  PERFORM jsonb_path_query('{}'::jsonb, '$.a'), 'strict $.**'::jsonpath;",
        "  PERFORM public.fn_ca_text_without_dollar('$100 Freeroll');",
        "  PERFORM pg_temp.swap(p, $a$'Old copy said $5' ||$a$, $b$'New copy says 5 Chips' ||$b$);",
        '  RETURN p;',
        'END',
        '$fn$;',
        "COMMENT ON FUNCTION public.g(text) IS 'Was $5 once.';",
        '',
      ].join('\n'),
    });
    expect(r.out).not.toContain('FAILED');
    expect(r.status).toBe(0);
  });

  it('reads the estate digest and every migration from its first SQL version on', async () => {
    const gate = await import(GATE);
    expect(gate.sourceRoots()).toEqual(['src', 'server/src', '.github/scripts']);
    expect(gate.SQL_SINCE).toMatch(/^\d{14}$/);
    const fixed = readFileSync(
      join(
        ROOT,
        `supabase/migrations/${gate.SQL_SINCE}_the_jackpot_notice_and_search_show_no_dollar.sql`
      ),
      'utf8'
    );
    expect(gate.scanSql('m.sql', fixed)).toEqual([]);
    expect(gate.scanSql('old.sql', "SELECT 'The Bad Beat Jackpot Just Passed $' || 5;")).toEqual([
      'old.sql:1: The Bad Beat Jackpot Just Passed $',
    ]);
  });

  it('passes the swept tree', () => {
    const r = runGate(null);
    expect(r.out).toContain('check-ui-dollar: OK');
    expect(r.status).toBe(0);
  }, 120_000);

  it('exempts exactly one file, the tracker export, and says why', () => {
    const src = readFileSync(GATE, 'utf8');
    expect(src).toContain("const SKIP_FILES = new Set(['src/utils/pokerStarsExport.ts']);");
    expect(src).toMatch(/Hold'em Manager and PokerTracker/);
  });

  it('rides check-ui-text, so it runs wherever that gate runs: pre-push, CI and all-gates', () => {
    /* Behaviour, not text: check-ui-text over the real tree (no em dashes)
       must still fail when the dollar half it starts finds a "$100". */
    const dir = mkdtempSync(join(tmpdir(), 'ui-dollar-via-text-'));
    made.push(dir);
    writeFileSync(
      join(dir, 'Lobby.tsx'),
      'export const L = () => <span>$100 Chip Guarantee</span>;\n'
    );
    const env = { ...process.env, UI_DOLLAR_SOURCE_DIR: dir };
    delete env.UI_TEXT_SOURCE_DIR;
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ci/check-ui-text.mjs')], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    expect(`${r.stdout}${r.stderr}`).toContain('Lobby.tsx:1: $100 Chip Guarantee');
    expect(r.status).toBe(1);

    expect(readFileSync(join(ROOT, '.husky/pre-push'), 'utf8')).toContain(
      'node scripts/ci/check-ui-text.mjs'
    );
    expect(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')).toContain(
      'node scripts/ci/check-ui-text.mjs'
    );
    expect(readFileSync(join(ROOT, 'scripts/ci/all-gates.sh'), 'utf8')).toContain('check-ui-text');
  }, 120_000);
});
