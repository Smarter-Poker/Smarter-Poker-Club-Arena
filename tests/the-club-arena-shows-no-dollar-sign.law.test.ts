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
