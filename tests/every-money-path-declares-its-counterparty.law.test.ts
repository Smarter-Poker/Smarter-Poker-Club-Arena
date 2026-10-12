/**
 * ===========================================================================
 *  EVERY MONEY PATH DECLARES ITS COUNTERPARTY
 * ===========================================================================
 *
 * Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
 * drifts should not be possible."
 *
 * Since 20261002073930 a transaction that journals a leg against
 * settlement_suspense and moves a covered balance does not commit. The journal
 * triggers fall to settlement_suspense when the writer named no counterparty,
 * so an undeclared money path is a path that fails the first time it runs -
 * a refund, a cancellation, a rare door - in front of a player.
 * fn_ca_undeclared_money_paths() is the catalog-side watch (ratcheted by
 * fn_ca_ratchet_watch; incident 36991212 when it rose 80 -> 86).
 * 20261002140203 brought it to 0: 25 dead doors retired, 5 primitives guarded
 * (the caller names the counterparty or the call is refused by name), 6 live
 * doors declared, 1 self-test registered as moving no money, and the producer
 * taught to count only what is true.
 *
 * THIS LAW IS MIGRATION-DERIVED. It reads the journalled balance columns from
 * the LATEST fn_ca_autoledger trigger definitions, and the LATEST definition of
 * every function from the migrations in order, and applies the producer's own
 * rule (ported below) to:
 *   * the 37 functions 20261002140203 settled, and
 *   * every function defined by any migration from 20261002140203 onward -
 *     so a new door that assigns a journalled balance without naming its
 *     counterparty turns this red before it can be refused in production.
 *
 * THE NEGATIVE PROOF is executed here on planted bodies and a planted
 * migration, and was executed against the real SQL producer on an isolated
 * PostgreSQL 17 (docs/changelog/2026-10-02-every-money-path-declares-its-
 * counterparty.md): an undeclared treasury write and an autoskip without its
 * own leg are reported; a reader, a declared write and an autoskip with its own
 * leg are not.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIG_DIR = join(ROOT, 'supabase', 'migrations');
const SUFFIX = '_every_money_path_declares_its_counterparty.sql';

const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIG_DIR, f), 'utf8');
const mine = migrations.find((f) => f.endsWith(SUFFIX));

const stripComments = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

type Fn = { name: string; file: string; body: string };

/** Every function definition in a migration, in order, with its body. */
function definitions(file: string, sql: string): Fn[] {
  const out: Fn[] = [];
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\([\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\2/gi;
  for (const m of sql.matchAll(re)) out.push({ name: m[1], file, body: m[3] });
  return out;
}

function latestDefinitions(files: { name: string; sql: string }[]): Map<string, Fn> {
  const latest = new Map<string, Fn>();
  for (const { name, sql } of files) for (const d of definitions(name, sql)) latest.set(d.name, d);
  return latest;
}

/** `table` -> balance columns the journal trigger (fn_ca_autoledger) journals. */
function journalled(files: { sql: string }[]): Array<[string, string]> {
  const latest = new Map<string, { table: string; args: string }>();
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+[^;]*?ON\s+public\.(\w+)\b[^;]*?EXECUTE\s+FUNCTION\s+(?:public\.)?fn_ca_autoledger\s*\(([^)]*)\)/gi;
  for (const { sql } of files) {
    for (const m of stripComments(sql).matchAll(re))
      latest.set(`${m[2]}:${m[1]}`, { table: m[2], args: m[3] });
  }
  const out = new Set<string>();
  for (const { table, args } of latest.values()) {
    for (const a of args.matchAll(/'(\w+)=(\w+)'/g)) out.add(`${table}.${a[1]}`);
  }
  return [...out].map((s) => s.split('.') as [string, string]);
}

/** Functions a migration registered as moving no money (status 'system'). */
function systemRegistered(files: { sql: string }[]): Set<string> {
  const status = new Map<string, string>();
  for (const { sql } of files) {
    const s = stripComments(sql);
    if (!/ca_money_rpc_registry/.test(s)) continue;
    for (const m of s.matchAll(/\(\s*'(\w+)'\s*,\s*'(approved|legacy|retired|system|closed)'/g))
      status.set(m[1], m[2]);
    for (const m of s.matchAll(
      /UPDATE\s+(?:public\.)?ca_money_rpc_registry\s+SET\s+status\s*=\s*'(\w+)'[^;]*?WHERE\s+proname\s*(?:=\s*'(\w+)'|IN\s*\(([^)]*)\))/gi
    )) {
      const names = m[2] ? [m[2]] : [...m[3].matchAll(/'(\w+)'/g)].map((x) => x[1]);
      for (const n of names) status.set(n, m[1]);
    }
  }
  return new Set([...status].filter(([, v]) => v === 'system').map(([k]) => k));
}

const EXEMPT = new Set([
  'fn_ca_autoledger',
  'fn_ca_autoledger_delete',
  'fn_ca_declare_ledger',
  'fn_ca_undeclared_money_paths',
]);

/**
 * The producer's rule (fn_ca_undeclared_money_paths, 20261002140203), ported:
 * a function that ASSIGNS a journalled column inside an UPDATE of its table,
 * and neither declares a counterparty nor stands that table's journal down
 * while writing its own chip_ledger leg, is an undeclared money path.
 */
function undeclared(body: string, watched: Array<[string, string]>): string[] {
  const declares = /fn_ca_declare_ledger|app\.ledger_counterparty/i.test(body);
  const ownLeg = /INSERT\s+INTO\s+(public\.)?chip_ledger\b/i.test(body);
  const out: string[] = [];
  for (const [t, c] of watched) {
    const assigns = new RegExp(
      `UPDATE\\s+(public\\.)?${t}\\b[^;]*?\\bSET\\b[^;]*?\\b${c}\\s*=`,
      'i'
    );
    if (!assigns.test(body)) continue;
    if (declares) continue;
    if (ownLeg && new RegExp(`ledger_autoskip_${t}\\b`, 'i').test(body)) continue;
    out.push(`${t}.${c}`);
  }
  return out;
}

const all = migrations.map((name) => ({ name, sql: read(name) }));
const WATCHED = journalled(all);
const LATEST = latestDefinitions(all);
const SYSTEM = systemRegistered(all);

const RETIRED = [
  'atomic_tournament_register',
  'credit_club_wallet_rake',
  'decrement_club_treasury',
  'deduct_chip_balance',
  'distribute_chips',
  'fn_add_chips',
  'fn_cashier_claim_back',
  'fn_cashier_send_chips',
  'fn_debit_chips',
  'fn_leave_club_atomic',
  'fn_reject_cashout',
  'fn_spin_reserve_seed_from_union',
  'fn_tournament_atomic_register',
  'fn_union_distribute_promo',
  'fn_union_fund_promo_from_bank',
  'fn_wallet_claim_back',
  'increment_union_chip_balance',
  'lock_chips_for_table',
  'mass_fund_horses',
  'mint_club_chips',
  'record_rake',
  'redeem_promo_to_chips',
  'spin_pool_draw',
  'transfer_promo_agent_to_player',
  'unlock_chips_from_table',
] as const;

const GUARDED: Record<string, string> = {
  atomic_deduct_wallet_and_log: 'club_members',
  fn_credit_player_wallet_once: 'club_members',
  fn_credit_chips: 'club_members',
  fn_credit_treasury_zd4core: 'clubs',
  fn_debit_treasury: 'clubs',
};

const DECLARED = [
  'fn_member_leave_to_treasury',
  'fn_seed_horses_to_floor',
  'fn_spin_activate',
  'fn_spin_absorb_club_pool_into_union',
  'fn_close_club_wallets_on_union_join',
  'fn_spin_reserve_wallet_fund',
] as const;

describe('every money path declares its counterparty', () => {
  it('the migration exists, is one transaction, asserts its preimages and an empty watch, and drops nothing', () => {
    expect(mine, `migration *${SUFFIX}`).toBeTruthy();
    const sql = read(mine!);
    const code = stripComments(sql);
    expect(code.match(/^\s*BEGIN\s*;/gm)?.length).toBe(1);
    expect(code.match(/^\s*COMMIT\s*;/gm)?.length).toBe(1);
    expect(code).toMatch(/SET LOCAL lock_timeout/);
    expect(code).not.toMatch(/\bDROP\s+(FUNCTION|TABLE|TRIGGER|POLICY|INDEX)\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code).toMatch(/md5\(pg_get_functiondef\(p\.oid\)\)/);
    expect(code).toMatch(/FROM public\.fn_ca_undeclared_money_paths\(\);[\s\S]*IF v_n <> 0 THEN/);
    expect(sql).toMatch(
      /@live-proof: \(SELECT count\(\*\) FROM public\.fn_ca_undeclared_money_paths\(\)\) = 0/
    );
  });

  it('the watch reads the journalled balance columns from the migrations (sanity)', () => {
    const cols = WATCHED.map(([t, c]) => `${t}.${c}`);
    for (const c of [
      'clubs.chip_treasury',
      'club_members.chip_balance',
      'union_wallets.chip_balance',
      'spin_bonus_pools.balance',
      'bbj_pools.main_balance',
      'agents.agent_wallet_balance',
    ]) {
      expect(cols, c).toContain(c);
    }
  });

  it('the producer counts only what is true: an assignment, statement-scoped, and the autoskip-plus-own-leg contract', () => {
    const p = LATEST.get('fn_ca_undeclared_money_paths');
    expect(p?.file).toBe(mine);
    const body = p!.body;
    expect(body).toContain(`'\\y[^;]*?\\ySET\\y[^;]*?\\y' || w.col || '\\s*='`);
    expect(body).toMatch(
      /NOT \(f\.writes_own_leg AND f\.prosrc ~\* \('ledger_autoskip_' \|\| w\.tbl \|\| '\\y'\)\)/
    );
    expect(body).toMatch(/g\.status = 'system'/);
    // the old match - "UPDATE <table>" anywhere plus the column name anywhere - is gone
    expect(body).not.toMatch(/AND f\.prosrc ~\* \('\\y' \|\| w\.col \|\| '\\y'\)/);
  });

  it('none of the 37 doors 20261002140203 settled is an undeclared money path', () => {
    const names = [...RETIRED, ...Object.keys(GUARDED), ...DECLARED];
    expect(names.length).toBe(36);
    for (const n of names) {
      const d = LATEST.get(n);
      expect(d, n).toBeTruthy();
      expect(d!.file >= mine!, `${n} is last defined by ${d!.file}`).toBe(true);
      expect(undeclared(d!.body, WATCHED), n).toEqual([]);
    }
    // the 37th moves nothing that survives the call and is registered so
    expect(SYSTEM.has('fn_bbj_selftest_payout_conservation')).toBe(true);
  });

  it('a retired door moves nothing and answers <name>_retired', () => {
    for (const n of RETIRED) {
      const body = stripComments(LATEST.get(n)!.body);
      expect(body, n).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
      expect(body, n).toContain(`'${n}_retired'`);
    }
  });

  it("a guarded primitive asks for its caller's declaration before the balance moves", () => {
    for (const [n, table] of Object.entries(GUARDED)) {
      const body = LATEST.get(n)!.body;
      const guard = body.search(
        /NULLIF\(current_setting\('app\.ledger_counterparty', true\), ''\) IS NULL/
      );
      const skip = body.indexOf(`app.ledger_autoskip_${table}`);
      const firstWrite = body.search(new RegExp(`UPDATE\\s+(public\\.)?${table}\\b`, 'i'));
      expect(guard, n).toBeGreaterThan(-1);
      expect(skip, n).toBeGreaterThan(guard);
      expect(guard, `${n}: the guard precedes the first ${table} write`).toBeLessThan(firstWrite);
      expect(body, n).toContain(
        `RAISE EXCEPTION '${n === 'fn_credit_treasury_zd4core' ? 'fn_credit_treasury' : n}_requires_a_declared_counterparty'`
      );
    }
  });

  it('a declaring door puts back the declaration it found', () => {
    for (const n of DECLARED) {
      const body = stripComments(LATEST.get(n)!.body);
      const saves = body.match(/fn_ca_ledger_declaration_save\(/g)?.length ?? 0;
      const restores = body.match(/fn_ca_ledger_declaration_restore\(/g)?.length ?? 0;
      expect(saves, n).toBeGreaterThan(0);
      expect(restores, n).toBeGreaterThanOrEqual(saves);
    }
    // spin activation keeps a caller's declaration (the welcome package's opening allocation)
    expect(LATEST.get('fn_spin_activate')!.body).toMatch(
      /IF NULLIF\(current_setting\('app\.ledger_counterparty', true\), ''\) IS NULL THEN\s+v_saved := public\.fn_ca_ledger_declaration_save/
    );
    // no chips into the Spin reserve from nowhere
    expect(LATEST.get('fn_spin_reserve_wallet_fund')!.body).toMatch(
      /IF p_from_wallet IS NULL THEN[\s\S]*?'source_wallet_required'/
    );
  });

  it('an unmapped union tx_type is refused by name, never booked to suspense', () => {
    const body = LATEST.get('fn_union_credit_wallet_zd3core')!.body;
    expect(LATEST.get('fn_union_credit_wallet_zd3core')!.file).toBe(mine);
    expect(body).toMatch(
      /IF v_cp IS NULL THEN\s+RAISE EXCEPTION 'fn_union_credit_wallet_unmapped_tx_type/
    );
    expect(stripComments(body)).not.toMatch(
      /IF v_cp IS NOT NULL THEN\s+PERFORM public\.fn_ca_declare_ledger/
    );
  });

  it('every function defined from 20261002140203 onward declares the counterparty of any balance it assigns', () => {
    const offenders: string[] = [];
    for (const d of LATEST.values()) {
      if (d.file < mine! || EXEMPT.has(d.name) || SYSTEM.has(d.name)) continue;
      const u = undeclared(d.body, WATCHED);
      if (u.length) offenders.push(`${d.name} (${d.file}): ${u.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  describe('negative proof', () => {
    const W: Array<[string, string]> = [
      ['clubs', 'chip_treasury'],
      ['club_members', 'chip_balance'],
    ];

    it('an undeclared balance assignment is reported', () => {
      expect(
        undeclared(
          `BEGIN UPDATE public.clubs SET chip_treasury = chip_treasury + 1 WHERE id = p; END`,
          W
        )
      ).toEqual(['clubs.chip_treasury']);
    });

    it('standing the journal down without writing the leg is still undeclared', () => {
      expect(
        undeclared(
          `BEGIN PERFORM set_config('app.ledger_autoskip_clubs','1',true);
         UPDATE clubs SET chip_treasury = chip_treasury + 1 WHERE id = p; END`,
          W
        )
      ).toEqual(['clubs.chip_treasury']);
    });

    it('a reader, a declared write and an autoskip with its own leg are not reported', () => {
      expect(
        undeclared(
          `DECLARE v numeric; BEGIN SELECT chip_treasury INTO v FROM clubs WHERE id = p;
        UPDATE clubs SET role = 'x' WHERE id = p; END`,
          W
        )
      ).toEqual([]);
      expect(
        undeclared(
          `BEGIN PERFORM fn_ca_declare_ledger('transfer','club_treasury',p);
        UPDATE clubs SET chip_treasury = chip_treasury + 1 WHERE id = p; END`,
          W
        )
      ).toEqual([]);
      expect(
        undeclared(
          `BEGIN PERFORM set_config('app.ledger_autoskip_clubs','1',true);
        UPDATE clubs SET chip_treasury = chip_treasury + 1 WHERE id = p;
        INSERT INTO public.chip_ledger (amount) VALUES (1); END`,
          W
        )
      ).toEqual([]);
    });

    it('a planted migration after 20261002140203 with an undeclared door turns the law red', () => {
      const planted = {
        name: '29991231235959_planted_undeclared_door.sql',
        sql: `BEGIN;
CREATE OR REPLACE FUNCTION public.zz_planted_refund(p_club uuid, p_user uuid, p_amount numeric)
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE public.club_members SET chip_balance = chip_balance + p_amount WHERE club_id = p_club AND user_id = p_user;
END;
$function$;
COMMIT;`,
      };
      const latest = latestDefinitions([...all, planted]);
      const offenders = [...latest.values()]
        .filter((d) => d.file >= mine! && !EXEMPT.has(d.name) && !SYSTEM.has(d.name))
        .filter((d) => undeclared(d.body, WATCHED).length > 0)
        .map((d) => d.name);
      expect(offenders).toEqual(['zz_planted_refund']);
    });

    it('a planted migration that re-opens a retired door turns the law red', () => {
      const planted = {
        name: '29991231235959_planted_reopened_door.sql',
        sql: `CREATE OR REPLACE FUNCTION public.fn_add_chips(p_user_id uuid, p_club_id uuid, p_amount numeric)
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE club_members SET chip_balance = chip_balance + p_amount WHERE club_id = p_club_id AND user_id = p_user_id;
END;
$function$;`,
      };
      const d = latestDefinitions([...all, planted]).get('fn_add_chips')!;
      expect(undeclared(d.body, WATCHED)).toEqual(['club_members.chip_balance']);
    });
  });
});
