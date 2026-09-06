/**
 * THE JOURNAL REPLAYS EVERY ACCOUNT IT NAMED (chip standard Phase 7.1,
 * 2026-09-05). Pinned on the migration mirrored byte-exact from production.
 *
 * The supply meter says the world moved by 5.44 and cannot say whose wallet it
 * was. The replay can: every account keeps its own snapshot, and between any
 * two consecutive readings of one account
 *
 *     stored_balance_now - stored_balance_at_the_previous_reading
 *       ==  the journal's net for that account over the same interval
 *
 * LAW 1 - EVERY ACCOUNT IS ITS OWN SERIES. An account is judged against its
 *   own previous reading, however far apart, so an account that never moves
 *   needs no reading and one that moves once a month is still exact.
 * LAW 2 - THE FIRST READING IS A BASELINE AND IS NEVER JUDGED.
 * LAW 3 - TWO INTERVALS, ONE FINDING. A leg that commits between the balance
 *   read and the window's end lands in one interval and reverses in the next,
 *   so the finding is the two-interval sum (the BBJ meter's rule, and three
 *   player wallets demonstrated it while this was built).
 * LAW 1b (gate) - AN ACCOUNT IS THE OWNER OF THE CHIPS, not the club that
 *   happened to be on a leg: one union wallet is one account, a player's
 *   account is their whole balance across every club, and the felt is ONE
 *   pool (a seat move inside a cluster carries a stack between tables with no
 *   leg, correctly). The first judged run filed 159 findings and every one was
 *   this keying, not a chip.
 * LAW 1c (gate) - A BALANCE THAT DOES NOT EXIST IS NOT ZERO: an owner with no
 *   row is skipped, never judged against a fabricated zero.
 * LAW 1d (gate) - THE NIGHTLY RUN READS ONE SNAPSHOT (REPEATABLE READ), so
 *   the balances and the journal come from the same instant.
 * LAW 4 - WHAT IT DOES NOT REPLAY, IT SAYS. prize_liability is excluded
 *   because tournament_escrow is its per-event balance with an hourly shadow;
 *   a leg whose column cannot be keyed is counted and reported as unkeyable,
 *   never guessed at.
 * LAW 5 - IT MOVES NOTHING. It reads balances, writes snapshots, files
 *   findings, and escalates through the kill switch, which itself only pages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, '../supabase/migrations');
const file = readdirSync(MIG).find((n) =>
  /^\d{14}_phase_7_1_the_journal_replays_every_account_it_named\.sql$/.test(n)
);
if (!file) throw new Error('the Phase 7.1 migration is not mirrored');
const sql = readFileSync(resolve(MIG, file), 'utf8');
const fnIn = (text: string, name: string): string => {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('$function$;', start));
};
const load = (re: RegExp): string => {
  const f = readdirSync(MIG).find((n) => re.test(n));
  if (!f) throw new Error(`not mirrored: ${re}`);
  return readFileSync(resolve(MIG, f), 'utf8');
};
const fn = (name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$function$;', start));
};

describe('the journal replays every account it named', () => {
  it('LAW 1: an account is judged against its own previous reading', () => {
    const r = fn('fn_ca_ledger_replay');
    expect(r).toMatch(
      /SELECT x\.balance, x\.taken_at, x\.unexplained FROM public\.ca_account_snapshots x\s+WHERE x\.account_key = t\.account_key ORDER BY x\.taken_at DESC LIMIT 1/
    );
    expect(r).toMatch(/FROM public\.fn_ca_leg_accounts\(v_at, v_now\)/);
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS ix_ca_account_snapshots_key_at ON public\.ca_account_snapshots \(account_key, taken_at DESC\)/
    );
  });

  it('LAW 2: the first reading is a baseline and is never judged', () => {
    const r = fn('fn_ca_ledger_replay');
    expect(r).toMatch(/IF r\.prev_at IS NULL THEN/);
    expect(r).toMatch(/'baseline: first reading of this account, not judged'/);
    expect(r).toMatch(/v_baselines := v_baselines \+ 1;\s+CONTINUE;/);
    expect(sql).toMatch(/the first pass judged an account it had never read/);
  });

  it('LAW 3: the finding is the two-interval sum', () => {
    const r = fn('fn_ca_ledger_replay');
    expect(r).toMatch(/v_two := v_this \+ COALESCE\(r\.prev_unexplained, 0\);/);
    expect(r).toMatch(/IF abs\(v_two\) > 0\.005 THEN/);
    expect(sql).toMatch(/unexplained {2}numeric,/);
  });

  it('LAW 1b: an account is keyed by the owner of the chips, and the felt is one pool', () => {
    const g = load(/^\d{14}_the_replay_keys_an_account_by_what_owns_the_chips\.sql$/);
    const a = fnIn(g, 'fn_ca_leg_accounts');
    expect(a).toMatch(
      /CASE WHEN s\.t = 'table_stack' THEN '00000000-0000-0000-0000-0000000fe17e'::uuid ELSE s\.id END AS owner/
    );
    expect(a).toMatch(/k\.t \|\| ':' \|\| k\.owner::text \|\| ':' \|\| k\.col AS account_key/);
    expect(a).not.toMatch(/COALESCE\(k\.club_id::text, '-'\)/);
    expect(fnIn(g, 'fn_ca_account_balance')).toMatch(
      /FROM public\.club_members WHERE user_id = p_entity;/
    );
    expect(g).toMatch(/RAISE EXCEPTION 'the felt is not one account'/);
  });

  it('LAW 1c: a balance that does not exist is not zero', () => {
    const g = load(/^\d{14}_the_replay_keys_an_account_by_what_owns_the_chips\.sql$/);
    const b = fnIn(g, 'fn_ca_account_balance');
    expect(b).toMatch(/A BALANCE THAT DOES NOT EXIST IS NOT ZERO/);
    expect(b).toMatch(/IF COALESCE\(v_rows, 0\) = 0 THEN RETURN NULL; END IF;/);
    // the felt always exists, even with every seat empty
    expect(b).toMatch(/v_rows := 1; {2}-- the felt always exists/);
  });

  it('LAW 1d: the nightly run reads one snapshot', () => {
    const g = load(/^\d{14}_the_replay_reads_the_balances_and_the_journal_at_one_instant\.sql$/);
    expect(g).toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;/);
    expect(g).toMatch(/RAISE EXCEPTION 'the nightly replay does not ask for one snapshot'/);
    expect(g).toMatch(/COMMENT ON FUNCTION public\.fn_ca_ledger_replay\(integer\) IS/);
  });

  it('LAW 4: what it does not replay, it says', () => {
    const a = fn('fn_ca_leg_accounts');
    expect(a).toMatch(/WHERE s\.t <> 'prize_liability'/);
    expect(a).toMatch(
      /SELECT NULL, 'unkeyable', NULL, NULL, NULL, round\(sum\(k\.amt\), 2\), count\(\*\), count\(\*\)/
    );
    expect(fn('fn_ca_ledger_replay')).toMatch(/'unkeyable_legs', v_unkeyable/);
  });

  it('LAW 5: it moves nothing, and it escalates through a switch that only pages', () => {
    const r = fn('fn_ca_ledger_replay');
    expect(r).toMatch(/PERFORM public\.fn_ca_kill_switch_trip\('fn_ca_ledger_replay', v_worst,/);
    for (const table of [
      'club_members',
      'clubs',
      'union_wallets',
      'bbj_pools',
      'agents',
      'table_seats',
      'spin_bonus_pools',
    ]) {
      expect(r, `the replay writes ${table}`).not.toMatch(
        new RegExp(`UPDATE\\s+(public\\.)?${table}\\b`, 'i')
      );
      expect(fn('fn_ca_account_balance'), `the balance reader writes ${table}`).not.toMatch(
        new RegExp(`UPDATE\\s+(public\\.)?${table}\\b`, 'i')
      );
    }
    expect(sql).toMatch(/\('fn_ca_ledger_replay', 'approved'/);
    expect(sql).toMatch(/\('fn_ca_ledger_replay', 'chip standard', 24, 72/);
  });

  it('it is scheduled, service-only, and one transaction', () => {
    expect(sql).toMatch(/cron\.schedule\('ca-ledger-replay-nightly'/);
    expect(fn('fn_ca_ledger_replay')).toMatch(/fn_ca_ledger_replay is service only/);
    expect((sql.match(/^BEGIN;$/gm) || []).length).toBe(1);
    expect((sql.match(/^COMMIT;$/gm) || []).length).toBe(1);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ca_ledger_replay\(integer\) TO service_role;/
    );
  });
});
