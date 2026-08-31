/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CASH BUY-IN BAND IS ONE PAIR OF COLUMNS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `public.tables` carried three buy-in column pairs and they disagreed on every
 * live cash table. On a 1/2 table, measured on production 2026-08-31:
 *
 *     min_buy_in    / max_buy_in       80 / 400   chips, 40-200BB   ENFORCED
 *     min_buyin     / max_buyin        40 / 200   big blinds
 *     min_buy_in_bb / max_buy_in_bb     2 /  25   big blinds, WRONG
 *
 * `atomic_table_buyin` is the only hard enforcement of a buy-in anywhere in the
 * product and it reads `min_buy_in` / `max_buy_in`. The engine reads the same
 * pair; so does src/lib/cashBuyIn.ts and its server mirror. The other four were
 * stale defaults from migration 010 that nothing read and one page still wrote.
 *
 * 20260831133000 made those four GENERATED columns derived from the canonical
 * pair, so the database now refuses a write to them. This test is the source
 * side of that guarantee: it fails if any code starts authoring a buy-in
 * through a column that is no longer writable, which in production surfaces as
 * a 428C9 that takes table creation down rather than as a test failure here.
 *
 * WHY THE MIGRATION IS ALSO PINNED: a migration can be reverted by a later one
 * far more quietly than a column can be un-dropped. If the generated columns
 * ever go back to being plain, the file that made them generated is the thing
 * that should have to change too.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIGRATION = 'supabase/migrations/20260831133000_one_buy_in_band_and_the_rest_are_derived.sql';

/* Built rather than written out, so this file does not trip its own scan. */
const DERIVED = ['min_buy_in_bb', 'max_buy_in_bb', 'min_buyin', 'max_buyin'];
const CANONICAL = ['min_buy_in', 'max_buy_in'];

const SCAN_ROOTS = ['src', 'server/src'];
const CODE = /\.(ts|tsx|js|jsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry)) out.push(full);
  }
  return out;
}

describe('the cash buy-in band is one pair of columns', () => {
  it('no source file authors a buy-in through a derived column', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        if (file.endsWith('buyInBandIsOneColumnPair.test.ts')) continue;
        const src = readFileSync(file, 'utf8');
        for (const col of DERIVED) {
          /* An object-literal write: `min_buy_in_bb: something`. A read
             (`row.min_buy_in_bb`) or a type declaration is fine — those keep
             working, and keeping them working is the whole reason the columns
             were made generated instead of dropped. */
          const write = new RegExp(`(^|[,{\\s])${col}\\s*:\\s*[^;\\n]*[,\\n]`, 'm');
          if (write.test(src)) offenders.push(`${file.slice(ROOT.length + 1)} -> ${col}`);
        }
      }
    }
    expect(
      offenders,
      `these write a GENERATED column; Postgres answers 428C9 and the insert fails:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('TableConfigPage still authors the canonical pair, in chips', () => {
    const page = readFileSync(join(ROOT, 'src/pages/TableConfigPage.tsx'), 'utf8');
    for (const col of CANONICAL) {
      expect(page, `${col} must still be written by the table creator`).toContain(`${col}:`);
    }
    /* In chips — the band is authored in big blinds and multiplied out here.
       A bare `min_buy_in: config.minBuyInBB` would recreate the unit mismatch
       this whole change exists to end. */
    expect(page).toMatch(/min_buy_in:\s*config\.minBuyInBB\s*\*\s*config\.bigBlind/);
    expect(page).toMatch(/max_buy_in:\s*config\.maxBuyInBB\s*\*\s*config\.bigBlind/);
  });

  it('the migration that made the other four derived is still in the tree', () => {
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
    for (const col of DERIVED) {
      const generated = new RegExp(`ADD COLUMN ${col} integer GENERATED ALWAYS AS`, 'i');
      expect(sql, `${col} must be declared GENERATED`).toMatch(generated);
    }
    /* The floor rounds up and the ceiling rounds down, so a reader of the
       derived pair can never offer a buy-in the RPC would refuse. */
    expect(sql).toMatch(/ceil\(min_buy_in \/ big_blind\)/);
    expect(sql).toMatch(/floor\(max_buy_in \/ big_blind\)/);
    /* A queued ACCESS EXCLUSIVE on public.tables parks every reader behind it. */
    expect(sql).toMatch(/SET LOCAL lock_timeout/i);
  });
});
