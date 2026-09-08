/**
 * THE ROLLING ENGINE CANNOT DISPATCH A DEFERRED RECONCILER.
 *
 * Stage A must leave the old database signatures intact until every previous
 * engine process has drained. The new engine already owns completion through
 * atomic settlement, so no executable runtime or operator path may dispatch
 * the historical reconciler graph during that compatibility window.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_tournament_places_settle_and_complete_atomically.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('rolling atomic tournament settlement migration is missing');

const SQL = readFileSync(join(MIGRATIONS, file), 'utf8')
  .replace(/^\s*--.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const ROUTINES = [
  'fn_tournament_payout_reconcile',
  'fn_pay_backed_payout_shortfalls',
  'fn_ca_backpay_guarantee_shortfalls',
  'fn_tournament_payout_sweep',
  'sp_ca_reconcile_backpaid_events',
  'fn_backpay_hu_winner_shortfalls',
] as const;

function activeSourceFiles(path: string): string[] {
  if (/[/\\]fixtures[/\\]/.test(path) || /[/\\]probe-[^/\\]*\.sql$/.test(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (/[/\\]fixtures[/\\]/.test(child) || /[/\\]probe-[^/\\]*\.sql$/.test(child)) return [];
    if (entry.isDirectory()) return activeSourceFiles(child);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|sql|sh)$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\./.test(entry.name)) return [];
    return [child];
  });
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(?:--|#).*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

describe('Stage A preserves old-engine RPC compatibility without a second current payer', () => {
  it('keeps the compatibility graph installed and the atomic guards dormant', () => {
    for (const name of ROUTINES) {
      expect(SQL).not.toMatch(new RegExp(`DROP (?:FUNCTION|PROCEDURE) IF EXISTS public\\.${name}`));
    }
    expect(SQL).toMatch(
      /fn_tournament_payout_reconcile\(uuid,boolean\)[\s\S]*?fn_pay_backed_payout_shortfalls\(boolean,integer\)[\s\S]*?fn_tournament_payout_sweep\(integer,boolean,integer\)[\s\S]*?fn_backpay_hu_winner_shortfalls\(integer\)[\s\S]*?Stage-A old-engine tournament payout RPC compatibility is incomplete/
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard[\s\S]*?DISABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard/
    );
  });

  it('has no executable engine, client or operator caller', () => {
    const files = [
      ...activeSourceFiles(join(ROOT, 'server', 'src')),
      ...activeSourceFiles(join(ROOT, 'src')),
      ...activeSourceFiles(join(ROOT, 'scripts', 'dev')),
      join(ROOT, 'scripts', 'verify-tournaments.mjs'),
    ];

    for (const path of files) {
      const executable = withoutComments(readFileSync(path, 'utf8'));
      for (const routine of ROUTINES) {
        expect(executable, `${routine} remains callable from ${path}`).not.toMatch(
          new RegExp(`['\"]${routine}['\"]`)
        );
      }
    }
  });
});
