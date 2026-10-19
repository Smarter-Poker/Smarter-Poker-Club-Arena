/**
 * THE CONSERVATION REPORT READS A CLUB BANK BY ITS OWN ENTITY (issue #7321).
 *
 * The bank side of fn_cashier_conservation_report filtered chip_ledger by
 * club_id as well as by the treasury entity. club_id on a bank leg names the
 * wallet club of the other side: 20261003092151 paid commissions from Midway
 * Union's and Deep Stack Society's banks into payees' wallets in other clubs,
 * filed under those clubs, and the report dropped them from the paying bank -
 * drift -3,038.33 and -81.14 with no chip missing. 20261019093951 reads bank
 * movement by the bank entity only, as fn_ca_treasury_positions does.
 *
 * This pins the shape on the newest definition, so a later rewrite cannot put
 * the club_id filter back on the bank side. The behaviour (a payout from bank A
 * filed under club B counts against bank A) is proved in PostgreSQL by
 * scripts/ci/test-cashier-conservation-bank-entity-postgres.py.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const dir = resolve(ROOT, 'supabase/migrations');
const read = (f: string) => readFileSync(resolve(dir, f), 'utf8');
const latest = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) =>
    read(f).includes('CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report')
  )
  .at(-1)!;
const migration = read(latest);
const definition = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_cashier_conservation_report')
);
const tag = definition.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/)?.[1];
if (!tag) throw new Error('The newest conservation function has no SQL body delimiter');
const bodyEnd = definition.indexOf(`${tag};`, definition.indexOf(tag) + tag.length);
if (bodyEnd < 0) throw new Error('The newest conservation function body is unterminated');
const report = definition.slice(0, bodyEnd + tag.length + 1);
const bankStart = report.search(/\bbank AS MATERIALIZED\s*\(/);
if (bankStart < 0) throw new Error('The newest conservation function has no bank CTE');
const bank = report.slice(bankStart, report.indexOf('baselines AS MATERIALIZED'));
const legs = report.slice(
  report.indexOf('legs AS MATERIALIZED'),
  report.indexOf('moves AS MATERIALIZED')
);
const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const sealedLane = readFileSync(
  resolve(ROOT, 'scripts/ci/test-cashier-conservation-sealed-days-postgres.py'),
  'utf8'
);

describe('the conservation report reads a club bank by its own entity', () => {
  it('is the bank-entity read or a later one that keeps it', () => {
    expect(latest >= '20261019093951').toBe(true);
  });

  it('selects bank credits and debits by the treasury entity alone', () => {
    expect(bank.match(/FROM public\.chip_ledger l/g)).toHaveLength(2);
    expect(bank).toMatch(
      /WHERE l\.to_type='club_treasury'\s+AND l\.to_entity_id=p_club_id AND l\.created_at>=b\.taken_at/
    );
    expect(bank).toMatch(
      /WHERE l\.from_type='club_treasury'\s+AND l\.from_entity_id=p_club_id AND l\.created_at>=b\.taken_at/
    );
    // club_id on a bank leg names the other side's wallet club, never the bank.
    expect(bank).not.toMatch(/\bl\.club_id\b/);
  });

  it('still reads player wallets by the club the wallet belongs to', () => {
    expect(legs).toContain(
      'WHERE l.club_id=p_club_id AND l.created_at>=r.lo AND l.created_at<r.hi'
    );
  });

  it('is qualified in PostgreSQL on every server change', () => {
    // The required Cashier native lane runs the sealed-days harness, which
    // runs the bank-entity harness after its own cases.
    expect(ci).toContain('python3 scripts/ci/test-cashier-conservation-sealed-days-postgres.py');
    expect(sealedLane).toContain("'scripts/ci/test-cashier-conservation-bank-entity-postgres.py'");
    expect(sealedLane).toMatch(
      /subprocess\.run\(\[\s*sys\.executable, str\(ROOT \/ 'scripts\/ci\/test-cashier-conservation-bank-entity-postgres\.py'\)[\s\S]*check=True\)/
    );
  });
});
