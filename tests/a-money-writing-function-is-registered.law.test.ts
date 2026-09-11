/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MONEY WRITING FUNCTION IS REGISTERED BEFORE IT EXISTS (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Seven of the sixteen drift incidents open on the morning of 2026-09-11 were
 * one sentence repeated: "NEW unregistered function writes balance columns".
 * fn_ca_money_rpc_drift was right every time. Three defects sat underneath it.
 *
 *   1. Seven live functions had shipped without a registry row. Each body was
 *      read in full and registered. Five are approved money movers; two move
 *      nothing and are registered system, because calling a reader an approved
 *      money mover is how a registry stops meaning anything.
 *      The seventh, fn_bbj_set_club_mini_enabled, shipped at 14:07 on the same
 *      day this migration was written. The class was still happening while the
 *      fix was being typed, and the first assertion in the migration is what
 *      caught it - not a human reading a dashboard.
 *   2. The eighth incident, fn_diamond_game_promo_lock, NO LONGER EXISTS - and
 *      its incident stayed open regardless, ageing past target for a day.
 *      fn_ca_money_rpc_drift was absent from fn_ca_resolve_cleared_incidents
 *      and recorded no run, so NOTHING could ever close one of its findings.
 *      A detector that cannot retract is a detector that accumulates.
 *   3. Nothing REFUSED an unregistered money writer. Detection ran hourly and
 *      filed a warning; the door was already open by then.
 *
 * THE LAW: the rule that REFUSES a money writer and the rule that REPORTS one
 * are the same predicate, called from two places. A guard that carries its own
 * copy of the rule is a guard that will one day disagree with the detector, and
 * the disagreement will be silent.
 *
 * WHAT MUST NOT HAPPEN TO THIS LAW. The cheap way to make a refused migration
 * apply is to drop the event trigger, or to widen the predicate until it stops
 * matching. Both turn this file red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260911160817_a_money_writing_function_is_registered_before_it_exists.sql');

/** Exactly one function's shipped text: from its CREATE to its closing $function$. */
const fnBody = (name: string): string => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} is not in the migration`).toBeGreaterThan(-1);
  const end = SQL.indexOf('$function$;', start);
  expect(end, `${name} has no closing $function$`).toBeGreaterThan(start);
  return SQL.slice(start, end);
};

describe('the migration obeys the production DDL policy', () => {
  it('is one transaction, so one schema cache reload and not ten', () => {
    expect(SQL.match(/^BEGIN;/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;/gm)?.length).toBe(1);
  });

  it('probes production with no DDL of its own (rule 3)', () => {
    // A CREATE FUNCTION used as a test costs a ~28s PostgREST reload. The
    // proof reads pg_event_trigger instead. This assertion is what stops a
    // later "let us just prove it properly" edit reintroducing the outage.
    const proof = SQL.slice(SQL.indexOf('-- ── 7. prove it'));
    // Anchored to the start of a line: the NOTE above the proof block NAMES
    // the forbidden statement in prose, and an unanchored match would flag its
    // own explanation.
    expect(proof).not.toMatch(/^\s*CREATE\s+(OR REPLACE\s+)?FUNCTION/im);
    expect(proof).toMatch(/FROM pg_event_trigger e/);
  });
});

describe('the rule exists in exactly one place', () => {
  it('a single predicate decides what a money writer is', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_money_rpc_writes_balances\(p_src text\)/);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_money_rpc_balance_columns\(\)/);
  });

  it('the detector calls it instead of carrying its own copy of the regex', () => {
    const detector = fnBody('fn_ca_money_rpc_drift');
    expect(detector).toMatch(/public\.fn_ca_money_rpc_writes_balances\(p\.prosrc\)/);
    // the inlined regex that used to live here must be gone from the detector
    expect(detector).not.toMatch(/v_col_re/);
    expect(detector).not.toMatch(/regexp_matches\(pg_get_triggerdef/);
  });

  it('and the guard calls the same one', () => {
    const guard = fnBody('fn_ca_money_rpc_registry_guard');
    expect(guard).toMatch(/public\.fn_ca_money_rpc_writes_balances\(v_src\)/);
  });
});

describe('the guard refuses at CREATE, not hours later', () => {
  it('is an event trigger on ddl_command_end for CREATE FUNCTION', () => {
    expect(SQL).toMatch(
      /CREATE EVENT TRIGGER ab_ca_money_rpc_registered\s*\n\s*ON ddl_command_end WHEN TAG IN \('CREATE FUNCTION'\)/
    );
  });

  it('it refuses, and the refusal says exactly what to do about it', () => {
    const guard = fnBody('fn_ca_money_rpc_registry_guard');
    expect(guard).toMatch(/RAISE EXCEPTION\s*\n?\s*'REFUSED: % writes balance columns and is not in ca_money_rpc_registry'/);
    expect(guard).toMatch(/ERRCODE = '42501'/);
    // the hint has to name the table and the fix, or the next agent is stuck
    expect(guard).toMatch(/INSERT INTO public\.ca_money_rpc_registry/);
    expect(guard).toMatch(/ABOVE the CREATE FUNCTION in this same migration/);
  });

  it('it lets a function that is already registered through', () => {
    const guard = fnBody('fn_ca_money_rpc_registry_guard');
    expect(guard).toMatch(/IF EXISTS \(SELECT 1 FROM public\.ca_money_rpc_registry g WHERE g\.proname = v_name\) THEN\s*\n\s*CONTINUE;/);
  });

  it('and it only judges functions in public', () => {
    const guard = fnBody('fn_ca_money_rpc_registry_guard');
    expect(guard).toMatch(/obj\.schema_name IS DISTINCT FROM 'public'/);
    expect(guard).toMatch(/p\.prokind = 'f'/);
  });
});

describe('a finding can now be retracted', () => {
  it('the detector records that it ran', () => {
    const detector = fnBody('fn_ca_money_rpc_drift');
    expect(detector).toMatch(/INSERT INTO public\.ca_detector_runs \(detector, detail\)/);
    expect(detector).toMatch(/'fn_ca_money_rpc_drift'/);
  });

  it('and it is on the auto resolve list, which is what closes a dropped function', () => {
    const resolver = fnBody('fn_ca_resolve_cleared_incidents');
    expect(resolver).toMatch(/'fn_ca_conservation_sweep','fn_ca_ratchet_watch','fn_bbj_reconcile','fn_ca_money_rpc_drift'/);
  });

  it('TWO CLEAN RUNS, NOT ONE survives the edit', () => {
    // One run is not enough: a check that errors raises under a different key
    // and must never be mistaken for the finding having cleared.
    const resolver = fnBody('fn_ca_resolve_cleared_incidents');
    expect(resolver).toMatch(/ORDER BY ran_at DESC OFFSET 1 LIMIT 1/);
    expect(resolver).toMatch(/i\.created_at < v_second/);
    expect(resolver).toMatch(/i\.last_seen_at < v_second/);
  });

  it('fn_ca_quick_reconcile is still deliberately absent from that list', () => {
    // It reads a ten minute window, so its silence means the window moved on.
    const resolver = fnBody('fn_ca_resolve_cleared_incidents');
    expect(resolver).not.toMatch(/'fn_ca_quick_reconcile'/);
  });
});

describe('the seven audited functions are registered, with what they do', () => {
  const expected: Array<[string, string]> = [
    ['fn_diamond_game_cover_lock', 'system'],
    ['fn_diamond_game_pay_chips', 'approved'],
    ['fn_diamond_game_fund_promo', 'approved'],
    ['fn_complete_tournament_terminal_pre_seat_guard', 'approved'],
    ['fn_ca_settle_bounty_rebuy_generation_v1', 'approved'],
    ['fn_ca_reprice_unpaid_tournament_place', 'approved'],
    ['fn_bbj_set_club_mini_enabled', 'system'],
  ];

  it.each(expected)('%s is registered as %s', (proname, status) => {
    const row = new RegExp(`'${proname}',\\s*'${status}',`);
    expect(SQL).toMatch(row);
  });

  it('the lock helper is system and not approved, because it moves nothing', () => {
    // Registering a reader as an approved money mover is how a registry stops
    // meaning anything. It is flagged only for its ON CONFLICT DO NOTHING row.
    expect(SQL).toMatch(/'fn_diamond_game_cover_lock', 'system'/);
    expect(SQL).toMatch(/Moves no money/);
  });

  it('every registered function carries a note, not an empty string', () => {
    for (const [proname] of expected) {
      const at = SQL.indexOf(`'${proname}',`);
      expect(at, `${proname} missing`).toBeGreaterThan(-1);
      const row = SQL.slice(at, SQL.indexOf('),', at));
      // note is the third column and must be a real sentence
      expect(row.length, `${proname} has no note`).toBeGreaterThan(proname.length + 80);
    }
  });

  it('registering is additive: an existing row is never overwritten', () => {
    expect(SQL).toMatch(/ON CONFLICT \(proname\) DO NOTHING/);
  });
});

describe('the migration refuses to apply on a false claim', () => {
  it('aborts if any money writer is still unregistered', () => {
    expect(SQL).toMatch(/ABORT: % money writing function\(s\) are still unregistered/);
  });

  it('aborts if the guard is missing or disabled rather than assuming it armed', () => {
    expect(SQL).toMatch(/ABORT: the registry guard event trigger is not installed/);
    expect(SQL).toMatch(/ABORT: the registry guard event trigger is installed but DISABLED/);
  });

  it('aborts if a client role can execute the new functions', () => {
    // REVOKE ... FROM PUBLIC does not remove a direct grant, and this project's
    // default privileges grant EXECUTE to anon and authenticated on every new
    // function. Naming them is not enough; the assertion is the proof.
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.fn_ca_money_rpc_writes_balances\(text\) FROM PUBLIC, anon, authenticated;/);
    expect(SQL).toMatch(/ABORT: a client role can still execute %/);
  });
});

/**
 * The predicate restated, so a change to the SQL has to be a deliberate change
 * to the rule and not a typo inside a 250 character regex.
 */
const MONEY_TABLES =
  '(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)';
const BALANCE_COLS = '(chip_balance|held_chips|locked_chips|credit_used|stack|balance|chips|prize|bounty_winnings)';
const writesBalances = (src: string): boolean =>
  (new RegExp(`UPDATE\\s+(public\\.)?${MONEY_TABLES}\\b`, 'i').test(src) ||
    new RegExp(`INSERT\\s+INTO\\s+(public\\.)?${MONEY_TABLES}\\b`, 'i').test(src)) &&
  new RegExp(`\\b${BALANCE_COLS}\\b`, 'i').test(src);

describe('the predicate, on the bodies that opened the incident', () => {
  it('a balance write is a money writer', () => {
    expect(writesBalances('UPDATE public.club_members SET chip_balance = chip_balance + 1')).toBe(true);
  });

  it('a plain read is not', () => {
    expect(writesBalances('SELECT chip_balance FROM public.club_members')).toBe(false);
  });

  it('a write that touches no balance column is not', () => {
    expect(writesBalances("UPDATE public.clubs SET name = 'x'")).toBe(false);
  });

  it('the lock helper IS caught, which is why it needed a registry row', () => {
    // It only reads and locks, but it inserts an empty union_wallets row so the
    // lock has something to hold, and that row names balance columns. The
    // registry's answer to an over-broad predicate is status system, never a
    // narrower predicate: narrowing it is how a real writer slips through.
    expect(
      writesBalances(
        'INSERT INTO public.union_wallets (union_id) VALUES (p_host) ON CONFLICT DO NOTHING; SELECT COALESCE(w.promo_wallet,0), COALESCE(w.chip_balance,0) FROM public.union_wallets w FOR UPDATE'
      )
    ).toBe(true);
  });

  it('a seat stack write is a money writer', () => {
    expect(writesBalances('UPDATE public.table_seats SET stack = 0 WHERE id = x')).toBe(true);
  });
});
