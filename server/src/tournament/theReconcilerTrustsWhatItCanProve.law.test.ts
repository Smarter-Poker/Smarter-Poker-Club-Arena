/**
 * THE RECONCILER CANNOT OUTLIVE ATOMIC SETTLEMENT.
 *
 * The historical reconciler was once the only way to detect a missing place
 * payment. Keeping even a non-paying observer left a callable, registrable and
 * schedulable second interpretation of tournament entitlements. The atomic
 * place batch is now both the proof and the only normal-place money door, so
 * the full deferred reconciliation graph is removed in the same transaction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const file = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('_tournament_manager_request_fencing_is_strict.sql'))
  .sort()
  .at(-1);
if (!file) throw new Error('strict Stage-B tournament cutover migration is missing');

const SQL = readFileSync(join(MIGRATIONS, file), 'utf8')
  .replace(/^\s*--.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

const ROUTINES = [
  {
    name: 'fn_tournament_payout_reconcile',
    drop: 'DROP FUNCTION IF EXISTS public.fn_tournament_payout_reconcile(uuid, boolean) RESTRICT;',
  },
  {
    name: 'fn_pay_backed_payout_shortfalls',
    drop: 'DROP FUNCTION IF EXISTS public.fn_pay_backed_payout_shortfalls(boolean, integer) RESTRICT;',
  },
  {
    name: 'fn_ca_backpay_guarantee_shortfalls',
    drop: 'DROP FUNCTION IF EXISTS public.fn_ca_backpay_guarantee_shortfalls(boolean, integer) RESTRICT;',
  },
  {
    name: 'fn_tournament_payout_sweep',
    drop: 'DROP FUNCTION IF EXISTS public.fn_tournament_payout_sweep(integer, boolean, integer) RESTRICT;',
  },
  {
    name: 'sp_ca_reconcile_backpaid_events',
    drop: 'DROP PROCEDURE IF EXISTS public.sp_ca_reconcile_backpaid_events(boolean) RESTRICT;',
  },
  {
    name: 'fn_backpay_hu_winner_shortfalls',
    drop: 'DROP FUNCTION IF EXISTS public.fn_backpay_hu_winner_shortfalls(integer) RESTRICT;',
  },
] as const;

function activeSourceFiles(path: string): string[] {
  if (/[/\\]fixtures[/\\]/.test(path) || /[/\\]probe-[^/\\]*\.sql$/.test(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (/[/\\]fixtures[/\\]/.test(child) || /[/\\]probe-[^/\\]*\.sql$/.test(child)) return [];
    if (entry.isDirectory()) return activeSourceFiles(child);
    if (!entry.isFile()) return [];
    if (!/\.(?:[cm]?[jt]sx?|sql|sh)$/.test(entry.name)) return [];
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

describe('atomic tournament settlement retires every deferred reconciler', () => {
  it('drops the complete function and procedure graph before the only commit', () => {
    const commitAt = SQL.lastIndexOf('COMMIT;');
    expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    for (const routine of ROUTINES) {
      const dropAt = SQL.indexOf(routine.drop);
      expect(dropAt, `${routine.name} has no explicit RESTRICT drop`).toBeGreaterThan(-1);
      expect(dropAt, `${routine.name} is dropped after COMMIT`).toBeLessThan(commitAt);

      const compatibilityDefinitionAt = Math.max(
        SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${routine.name}(`),
        SQL.lastIndexOf(`CREATE OR REPLACE PROCEDURE public.${routine.name}(`)
      );
      expect(
        compatibilityDefinitionAt,
        `${routine.name} remains declared as a dormant compatibility surface`
      ).toBe(-1);
    }
  });

  it('fails the migration if any same-named overload survives', () => {
    expect(SQL).toMatch(
      /FROM pg_proc p[\s\S]*?JOIN pg_namespace n[\s\S]*?p\.proname IN \([\s\S]*?'fn_tournament_payout_reconcile'[\s\S]*?'fn_pay_backed_payout_shortfalls'[\s\S]*?'fn_ca_backpay_guarantee_shortfalls'[\s\S]*?'fn_tournament_payout_sweep'[\s\S]*?'sp_ca_reconcile_backpaid_events'[\s\S]*?'fn_backpay_hu_winner_shortfalls'[\s\S]*?deferred tournament payout reconciliation routine remains installed/
    );
  });

  it('removes registry, settlement-source and scheduler call paths', () => {
    for (const routine of ROUTINES) {
      expect(SQL).toContain(`'${routine.name}'`);
    }
    expect(SQL).toMatch(
      /DELETE FROM public\.ca_money_rpc_registry[\s\S]*?'fn_tournament_payout_reconcile'[\s\S]*?'fn_backpay_hu_winner_shortfalls'/
    );
    expect(SQL).toMatch(
      /DELETE FROM public\.ca_settle_sources WHERE lower\(source\) = ANY\(\$1\)[\s\S]*?USING ARRAY\[[\s\S]*?'reconcile'[\s\S]*?'fn_backpay_hu_winner_shortfalls'/
    );
    expect(SQL).toMatch(
      /cron\.unschedule\(j\.jobid\)[\s\S]*?j\.command ~\* '\(fn_tournament_payout_sweep\|fn_tournament_payout_reconcile[\s\S]*?fn_backpay_hu_winner_shortfalls\)'/
    );
    expect(SQL).not.toMatch(/cron\.schedule\s*\(/);
  });

  it('has no executable engine, client or operator caller left behind', () => {
    const files = [
      ...activeSourceFiles(join(ROOT, 'server', 'src')),
      ...activeSourceFiles(join(ROOT, 'src')),
      ...activeSourceFiles(join(ROOT, 'scripts', 'dev')),
      join(ROOT, 'scripts', 'verify-tournaments.mjs'),
    ];

    for (const path of files) {
      const executable = withoutComments(readFileSync(path, 'utf8'));
      for (const routine of ROUTINES) {
        expect(executable, `${routine.name} remains callable from ${path}`).not.toMatch(
          new RegExp(`['\"]${routine.name}['\"]`)
        );
      }
    }
  });
});
