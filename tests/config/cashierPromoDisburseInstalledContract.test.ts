import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The live Cashier verifier pins md5(pg_get_functiondef) for every Cashier
// writer. Midway weekly promo (20261016132743, #7104) replaced
// fn_promo_disburse after asserting the old full definition as its preimage.
// The verifier must name the installed definition, derived here from the
// merged migration text, and must no longer accept the superseded one.
const migration = readFileSync(
  'supabase/migrations/20261016132743_midway_weekly_horse_promo_distribution.sql',
  'utf8'
);
const contract = readFileSync('scripts/verification-harness/cashier-release-contract.sql', 'utf8');

const PREIMAGE = '54539cb4d66ffdcdacd85521e5fbb929';
const INSTALLED = 'e54e4f3949335c61d4c1492d81b5ca21';

it('derives the installed fn_promo_disburse definition from the Midway migration', () => {
  expect(migration).toContain(`<>'${PREIMAGE}'`);
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_promo_disburse(');
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = migration.slice(start);
  const open = tail.indexOf('AS $function$');
  expect(open).toBeGreaterThan(0);
  const close = tail.indexOf('$function$', open + 'AS $function$'.length);
  expect(close).toBeGreaterThan(open);
  const definition = `${tail.slice(0, close + '$function$'.length)}\n`;
  expect(createHash('md5').update(definition).digest('hex')).toBe(INSTALLED);
});

it('pins the installed definition in the live Cashier verifier', () => {
  const at = contract.indexOf(
    "'signature', 'public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'"
  );
  expect(at).toBeGreaterThanOrEqual(0);
  const entry = contract.slice(at, contract.indexOf('\n    ),', at));
  expect(entry).toContain(`'hash', '${INSTALLED}'`);
  expect(entry).not.toContain(PREIMAGE);
  expect(entry).toContain("'search_path', 'search_path=public'");
});

// Club Bank ledger one-pass read (20261016155801, #7115) asserts its own
// post-image inside the install transaction; the verifier pins that value.
const ledgerMigration = readFileSync(
  'supabase/migrations/20261016155801_club_bank_ledger_reads_its_totals_in_one_pass.sql',
  'utf8'
);
const LEDGER_PREIMAGE = 'f17eb94522c177856683617945d9f371';
const LEDGER_INSTALLED = 'cb7edf507b92e7c22535d6fed10a416b';

it('derives the installed fn_club_bank_ledger definition from its migration', () => {
  expect(ledgerMigration).toContain(`IS DISTINCT FROM '${LEDGER_PREIMAGE}'`);
  expect(ledgerMigration).toContain(`IS DISTINCT FROM '${LEDGER_INSTALLED}'`);
  const start = ledgerMigration.indexOf('CREATE OR REPLACE FUNCTION public.fn_club_bank_ledger(');
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = ledgerMigration.slice(start);
  const open = tail.indexOf('AS $function$');
  const close = tail.indexOf('$function$', open + 'AS $function$'.length);
  expect(close).toBeGreaterThan(open);
  const definition = `${tail.slice(0, close + '$function$'.length)}\n`;
  expect(createHash('md5').update(definition).digest('hex')).toBe(LEDGER_INSTALLED);
});

it('pins the installed Club Bank ledger in the live Cashier verifier', () => {
  const at = contract.indexOf(
    "'signature', 'public.fn_club_bank_ledger(uuid,integer,integer,text[])'"
  );
  expect(at).toBeGreaterThanOrEqual(0);
  const entry = contract.slice(at, contract.indexOf('\n    ),', at));
  expect(entry).toContain(`'hash', '${LEDGER_INSTALLED}'`);
  expect(entry).not.toContain(`'hash', '${LEDGER_PREIMAGE}'`);
});
