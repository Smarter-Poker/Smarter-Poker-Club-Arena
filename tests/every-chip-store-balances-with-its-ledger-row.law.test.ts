/**
 * ===========================================================================
 *  EVERY CHIP STORE BALANCES WITH ITS LEDGER ROW
 * ===========================================================================
 *
 * Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
 * drifts should not be possible."
 *
 * tests/a-balance-never-moves-without-its-ledger-row.law.test.ts pins the
 * commit-time check on the first six stores (member wallets, club treasuries,
 * the cash felt, union bank and wallets, jackpot pools). Every other chip store
 * - the promo floats, agent wallets, club wallets, insurance banks, Spin
 * reserves, tournament escrow, the ticket float and the two clearing stores -
 * was journalled after the fact and compared hours later by snapshot. Migration
 * 20261002030942 puts every one of them under the same check, judged by a
 * per-store mode (ca_ledger_invariant_store_mode) so a store can be measured in
 * observe while the proven six keep refusing.
 *
 * THIS LAW IS A COVERAGE LAW. It derives the chip stores from the migrations
 * themselves, not from a list somebody remembered:
 *
 *   * every column the platform's journal trigger (fn_ca_autoledger /
 *     fn_ca_autoledger_delete) journals, as `column=store` on a table, is a
 *     chip balance, and must be counted by a tally trigger on that table;
 *   * every ledger store ca_chip_store_coverage declares 'counted' must be an
 *     account fn_ca_ledger_tally_key resolves;
 *   * the stores the journal trigger never covered (tournament escrow, the
 *     ticket float, the opening seed) are named and must be counted too.
 *
 * A new chip-balance column, journalled but not tallied, turns this red. The
 * negative proof is executed below: a planted migration adding one goes red,
 * and so does a counted ledger store the key function does not know.
 *
 * THE EXECUTABLE PROOF is scripts/dev/test-ledger-invariant.sh, which applies
 * the real migration on an isolated PostgreSQL 17 after the six-store proof
 * and runs tests/fixtures/ledger-invariant/stores-regression.sql: eleven
 * planted regressions refused by name, eleven live shapes committed, and the
 * per-store mode case (an observed promo drift and a felt drift in one
 * transaction: the felt still refuses).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'ledger-invariant');

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIG_DIR, f), 'utf8');

const stripComments = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

const STORES_SUFFIX = '_every_chip_store_balances_with_its_ledger_row.sql';
const storesName = migrations.find((f) => f.endsWith(STORES_SUFFIX));
const installerName = migrations.find((f) =>
  f.endsWith('_a_balance_never_moves_without_its_ledger_row.sql')
);

/**
 * Every `table.column` the journal trigger journals, with the ledger store it
 * names. Read from the LATEST definition of each journal trigger (a later
 * migration that re-creates a trigger with other arguments replaces it, as it
 * does on the database), across every migration in order.
 */
function journalledColumns(sqlFiles: string[]): Map<string, string> {
  const latest = new Map<string, { table: string; args: string }>();
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+[^;]*?ON\s+public\.(\w+)\b[^;]*?EXECUTE\s+FUNCTION\s+public\.fn_ca_autoledger(?:_delete)?\s*\(([^)]*)\)/gi;
  for (const raw of sqlFiles) {
    for (const m of stripComments(raw).matchAll(re)) {
      latest.set(`${m[2]}:${m[1]}`, { table: m[2], args: m[3] });
    }
  }
  const out = new Map<string, string>();
  for (const { table, args } of latest.values()) {
    for (const a of args.matchAll(/'(\w+)=(\w+)'/g)) out.set(`${table}.${a[1]}`, a[2]);
  }
  return out;
}

/**
 * The `table.column`s a tally trigger counts. The six-store installer and the
 * hand receipt name their columns in `UPDATE OF`; the store migration's
 * function counts, per table, the columns its branch for that table reads.
 */
function talliedColumns(sqlFiles: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of sqlFiles) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(
      /CREATE TRIGGER zy_ca_tally_balance_move\s+AFTER INSERT OR UPDATE OF ([\w,\s]+?) OR DELETE\s+ON public\.(\w+)/gi
    )) {
      for (const c of m[1].split(',')) out.add(`${m[2]}.${c.trim()}`);
    }
    const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_tally_store_move()');
    if (fnStart < 0) continue;
    const fn = sql.slice(fnStart, sql.indexOf('$function$;', fnStart));
    for (const t of sql.matchAll(
      /CREATE TRIGGER zy_ca_tally_store_move\s+AFTER INSERT OR UPDATE(?: OF ([\w,\s]+?))? OR DELETE ON public\.(\w+)/gi
    )) {
      const table = t[2];
      const branch = fn.match(
        new RegExp(`WHEN '${table}' THEN([\\s\\S]*?)(?=\\n\\s+WHEN '|\\n\\s+ELSE\\n)`)
      );
      if (!branch) continue;
      const listed = t[1] ? t[1].split(',').map((c) => c.trim()) : null;
      for (const c of branch[1].matchAll(/->> '(\w+)'\)::numeric/g)) {
        if (listed === null || listed.includes(c[1])) out.add(`${table}.${c[1]}`);
      }
    }
  }
  return out;
}

/** Every ledger store ca_chip_store_coverage declares counted. */
function countedLedgerStores(sqlFiles: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of sqlFiles) {
    if (!/ca_chip_store_coverage/.test(raw)) continue;
    for (const m of stripComments(raw).matchAll(/\('(\w+)',\s*'counted'/g)) out.add(m[1]);
  }
  return out;
}

/** The ledger types the LATEST fn_ca_ledger_tally_key resolves to an account. */
function keyedLedgerTypes(sqlFiles: string[]): Set<string> {
  let body = '';
  for (const raw of sqlFiles) {
    const sql = stripComments(raw);
    const i = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key(');
    if (i >= 0) body = sql.slice(i, sql.indexOf('$function$;', i));
  }
  const out = new Set<string>();
  for (const w of body.matchAll(/WHEN ((?:'\w+'(?:,\s*)?)+) THEN/g)) {
    for (const t of w[1].matchAll(/'(\w+)'/g)) out.add(t[1]);
  }
  return out;
}

/**
 * Columns the journal trigger journals that are deliberately NOT a separate
 * account: none today. A column belongs here only with the migration that
 * proves it is a mirror of a counted one.
 */
const NOT_A_STORE = new Set<string>([]);

/** Chip stores the journal trigger never covered, counted by the store tally. */
const STORES_WITHOUT_A_JOURNAL_TRIGGER = [
  'tournament_escrow.prize_balance',
  'tournament_escrow.bounty_balance',
  'tournament_escrow.fee_balance',
  'tournament_tickets.value',
  'club_opening_setups.leaderboard_seed_remaining',
] as const;

/** Ledger labels that are not chip stores: outside circulation by definition. */
const NONCIRCULATING = new Set([
  'chip_retirement',
  'issuance_reserve',
  'system_burn',
  'system_mint',
]);

function uncovered(sqlFiles: string[]): string[] {
  const tallied = talliedColumns(sqlFiles);
  const missing: string[] = [];
  for (const [col, store] of journalledColumns(sqlFiles)) {
    if (NOT_A_STORE.has(col)) continue;
    if (!tallied.has(col)) missing.push(`${col}=${store}`);
  }
  for (const col of STORES_WITHOUT_A_JOURNAL_TRIGGER) {
    if (!tallied.has(col)) missing.push(col);
  }
  return missing.sort();
}

function unkeyed(sqlFiles: string[]): string[] {
  const keyed = keyedLedgerTypes(sqlFiles);
  const missing: string[] = [];
  for (const s of countedLedgerStores(sqlFiles)) if (!keyed.has(s)) missing.push(s);
  for (const s of new Set(journalledColumns(sqlFiles).values())) {
    if (!keyed.has(s) && !NONCIRCULATING.has(s)) missing.push(s);
  }
  return [...new Set(missing)].sort();
}

const all = migrations.map(read);

describe('every chip store balances with its ledger row', () => {
  it('the store migration exists, is one transaction, takes its locks together, and drops nothing', () => {
    expect(storesName, `migration *${STORES_SUFFIX}`).toBeTruthy();
    expect(storesName! > (installerName ?? '')).toBe(true);
    const body = stripComments(read(storesName!));
    expect(body.trim().startsWith('BEGIN;')).toBe(true);
    expect(body.trim().endsWith('COMMIT;')).toBe(true);
    expect(body).toMatch(/SET LOCAL lock_timeout = '\d+s';/);
    expect(body).toMatch(/set_config\('lock_timeout', '250ms', true\)/);
    expect(body).toMatch(
      /LOCK TABLE public\.club_members, public\.clubs, public\.agents, public\.club_wallets,\s+public\.spin_bonus_pools, public\.tournament_escrow, public\.tournament_tickets,\s+public\.unions, public\.club_opening_setups\s+IN SHARE ROW EXCLUSIVE MODE;/
    );
    expect(body.indexOf('LOCK TABLE')).toBeLessThan(body.indexOf('CREATE TRIGGER'));
    expect(body).not.toMatch(/^\s*DROP\s+(TRIGGER|POLICY)\b/im);
    // the bodies it builds on are pinned, so a changed guard is not overwritten blind
    expect(body).toMatch(/'fn_ca_balance_has_its_ledger_row', '[0-9a-f]{32}'/);
    expect(body).toMatch(/'fn_ca_ledger_tally_key',\s+'[0-9a-f]{32}'/);
  });

  it('the proven six are not touched: their function and triggers are not redefined, and their keys read back unchanged', () => {
    const body = stripComments(read(storesName!));
    expect(body).not.toContain('CREATE OR REPLACE FUNCTION public.fn_ca_tally_balance_move');
    expect(body).not.toMatch(
      /CREATE (CONSTRAINT )?TRIGGER (zy_ca_tally_balance_move|zz_ca_balance_has_its_ledger_row)\b/
    );
    expect(body).toContain(
      'fn_ca_ledger_tally_key changed a key the refusing stores already judge'
    );
    for (const s of [
      'player_wallet',
      'club_treasury',
      'table_stack',
      'union_bank',
      'union_wallet',
      'bbj_pool',
    ]) {
      expect(body).toMatch(new RegExp(`\\('${s}',\\s+'refuse',`));
    }
  });

  it('each store is judged by its own mode, and a store with no row falls back to the global one', () => {
    const body = stripComments(read(storesName!));
    expect(body).toContain('CREATE TABLE public.ca_ledger_invariant_store_mode (');
    expect(body).toMatch(
      /sm\.store = split_part\(r\.key, ':', 1\)\),\s+\(SELECT m\.mode FROM public\.ca_ledger_invariant_mode m LIMIT 1\),\s+'refuse'\);/
    );
    // the refusal keeps its one name and SQLSTATE
    expect(body).toContain(
      "RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%'"
    );
    expect(body).toContain("USING ERRCODE = '23514'");
  });

  it('every chip-balance column the journal trigger journals is counted by a tally trigger on its table', () => {
    const journalled = journalledColumns(all);
    // the derivation found the real estate, not an empty set
    for (const col of [
      'club_members.chip_balance',
      'club_members.promo_balance',
      'clubs.promo_balance',
      'clubs.insurance_balance',
      'agents.agent_wallet_balance',
      'agents.promo_wallet_balance',
      'club_wallets.chip_balance',
      'spin_bonus_pools.balance',
      'unions.promo_fund_balance',
      'union_wallets.rake_wallet',
      'bbj_pools.main_balance',
    ]) {
      expect(journalled.has(col), `journalled: ${col}`).toBe(true);
    }
    expect(uncovered(all)).toEqual([]);
  });

  it('every counted ledger store is an account the key function resolves', () => {
    const counted = countedLedgerStores(all);
    for (const s of [
      'promo_wallet',
      'agent_wallet',
      'club_wallet',
      'insurance_bank',
      'spin_reserve',
      'prize_liability',
      'bounty_liability',
      'escrow',
      'opening_setup',
      'leaderboard_round',
    ]) {
      expect(counted.has(s), `declared counted: ${s}`).toBe(true);
    }
    expect(unkeyed(all)).toEqual([]);
  });

  it('NEGATIVE PROOF: a new journalled chip column with no tally, or a counted store with no key, goes red', () => {
    const planted = `
      BEGIN;
      ALTER TABLE public.clubs ADD COLUMN vault_balance numeric NOT NULL DEFAULT 0;
      CREATE TRIGGER trg_ca_autoledger_vault
        AFTER UPDATE OF vault_balance ON public.clubs
        FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('vault_balance=club_vault');
      CREATE TABLE public.jackpot_floats (id uuid PRIMARY KEY, float numeric);
      CREATE TRIGGER trg_ca_autoledger
        AFTER INSERT OR UPDATE OF float ON public.jackpot_floats
        FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('float=jackpot_float');
      INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) VALUES
        ('club_vault', 'counted', 'vaults', 'clubs vault_balance');
      COMMIT;`;
    expect(uncovered([...all, planted])).toEqual([
      'clubs.vault_balance=club_vault',
      'jackpot_floats.float=jackpot_float',
    ]);
    expect(unkeyed([...all, planted])).toEqual(['club_vault', 'jackpot_float']);
    // and dropping a tally trigger's column list entry is caught the same way
    const narrowed = all.map((sql) =>
      sql.replace(
        'AFTER INSERT OR UPDATE OF promo_balance, insurance_balance OR DELETE ON public.clubs',
        'AFTER INSERT OR UPDATE OF promo_balance OR DELETE ON public.clubs'
      )
    );
    expect(uncovered(narrowed)).toEqual(['clubs.insurance_balance=insurance_bank']);
  });

  it('observe is a measurement window: installed for the nine new stores, and no later migration moves any store back', () => {
    const body = stripComments(read(storesName!));
    for (const s of [
      'promo_wallet',
      'agent_wallet',
      'club_wallet',
      'insurance_bank',
      'spin_reserve',
      'tournament_liability',
      'ticket_escrow',
      'opening_setup',
      'leaderboard_round',
    ]) {
      expect(body).toMatch(new RegExp(`\\('${s}',\\s+'observe',`));
    }
    for (const f of migrations.filter((m) => m > storesName!)) {
      const sql = stripComments(read(f));
      expect(sql, `${f} may only move a store forward, to refuse`).not.toMatch(
        /UPDATE\s+(public\.)?ca_ledger_invariant_store_mode\s+SET\s+mode\s*=\s*'observe'/i
      );
      expect(sql, `${f} must not drop or disable the store invariant`).not.toMatch(
        /DROP TRIGGER (IF EXISTS )?(zy_ca_tally_store_move|zz_ca_store_has_its_ledger_row)\b|DISABLE TRIGGER\s+z[yz]_ca_|DROP FUNCTION (IF EXISTS )?(public\.)?fn_ca_(tally_store_move|tally_pair|tournament_counts)\b/i
      );
    }
  });

  it('the executable proof applies the real migration after the six-store proof and plants every store', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'dev', 'test-ledger-invariant.sh'), 'utf8');
    expect(script).toContain(`*${STORES_SUFFIX}`);
    expect(script.indexOf('stores-bootstrap.sql')).toBeGreaterThan(
      script.indexOf('regression.sql')
    );
    expect(script.indexOf('-f "$stores"')).toBeGreaterThan(script.indexOf('stores-bootstrap.sql'));
    expect(script.indexOf('stores-regression.sql')).toBeGreaterThan(script.indexOf('-f "$stores"'));
    const regression = readFileSync(join(FIXTURE_DIR, 'stores-regression.sql'), 'utf8');
    for (const shape of [
      'S1 a member promo wallet',
      'S2 an agent wallet moves through its mirror column',
      'S3 a club wallet leg of the wrong amount',
      'S4 a club insurance bank',
      'S5 a Spin reserve is drawn with no leg',
      'S6 an event escrow grows with no leg',
      'S7 a prize leg with no escrow movement',
      'S8 a ticket is issued with no leg',
      'S9 a ticket is marked redeemed with no leg',
      'S10 a clearing store keeps what passed through it',
      'S11 the legacy union promo fund',
      'Q1 tournament buy-in',
      'Q4 a Spin',
      'Q5 a satellite ticket',
      'Q10 a Diamond event',
      'M1 one transaction, an observed promo drift and a felt drift: the felt still refuses',
    ]) {
      expect(regression).toContain(shape);
    }
  });
});
