/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A REFUSAL THAT CANNOT CHANGE IS NOT A SERIALIZATION FAILURE (issue #6326)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PostgREST 14 re-runs any request whose transaction raised SQLSTATE 40001,
 * on the same pooled connection, until it stops failing. It never returns the
 * 40001 and no statement timeout ends it, because each attempt is a new
 * statement (Supabase: "SQLSTATE 40001 in an RPC function causes infinite
 * retries", fixed only in PostgREST 16; production runs 14.5).
 *
 * So a function that raises 40001 for a condition another attempt cannot
 * change pins one of the 41 pool connections for ever. On 2026-10-06/07
 * fn_settle_tournament_places raised "observed winner ... does not match
 * locked winner <NULL>" with 40001 about 100 times a second for ten and a half
 * hours from 457 PostgREST backends. Each request the engine abandoned left one
 * backend looping, the count climbed about one a minute to the pool size, and
 * then every request in the project waited for a connection and got 504
 * PGRST003 (up to 9,720 a minute) until PostgREST recycled - the "about hourly"
 * outage of #6326.
 *
 * The rule: a refusal that compares a caller's observation with a durable or
 * locked record (an immutable receipt, a roster under its row locks) is a
 * refusal, not a serialization failure. It is raised with an ordinary SQLSTATE
 * (55000 here) so the caller receives it. 40001 stays legitimate only for a
 * lost compare-and-set or a busy lane, where the retry re-reads a state another
 * transaction is changing.
 *
 * Pins:
 *  1. 20261007071300 moves exactly the twelve disagreement refusals of the
 *     terminal, satellite, bubble and cancellation paths from 40001 to 55000,
 *     each pinned by md5 and reversible to the pinned text.
 *  2. No migration after it raises 40001 or 40P01 with a disagreement message
 *     ("does not match", "disagree", "differs", "conflicts with"), so a later
 *     redefinition copied from an older body cannot bring the loop back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const FIX = '20261007071300_a_refusal_that_cannot_change_is_not_a_serialization_failure.sql';
const FIX_VERSION = '20261007071300';
const read = (name: string) => readFileSync(resolve(MIGRATIONS, name), 'utf8');

const MOVED: Array<[string, string]> = [
  ['public.fn_settle_tournament_places(uuid,uuid)', 'does not match locked winner'],
  [
    'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
    'does not match the locked last survivor in satellite',
  ],
  ['public.fn_settle_tournament_bubble_protection(uuid,uuid)', 'does not match durable place'],
  [
    'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
    'terminal replay parameters disagree with stored receipt',
  ],
  [
    'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
    'mystery evidence receipt conflicts with canonical proof',
  ],
  [
    'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)',
    'terminal outcome parameters disagree with stored receipt',
  ],
  [
    'public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
    'receipt winner % differs from observed winner',
  ],
  [
    'public.fn_resolve_satellite_settlement_outcome(uuid,uuid)',
    'satellite outcome winner disagrees with stored receipt',
  ],
  [
    'public.fn_ca_satellite_settlement_receipt(uuid,uuid)',
    'receipt winner % differs from observed winner',
  ],
  [
    'public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',
    'satellite cohort receipt identity differs',
  ],
  [
    'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)',
    'cancellation actor disagrees with stored receipt',
  ],
  [
    'public.fn_poker_diamond_tournament_cancellation_receipt(uuid,uuid)',
    'cancellation actor disagrees with stored receipt',
  ],
];

/** Strip SQL line comments so prose about the old behaviour is not read as code. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

const RETRYABLE = /ERRCODE\s*=\s*'(?:40001|40P01)'/i;
const DISAGREEMENT = /does not match|disagree|differs|conflicts with/i;

/** RAISE statements that carry a retryable SQLSTATE and a disagreement message. */
function disagreementsRaisedAsRetryable(sql: string): string[] {
  return code(sql)
    .split(';')
    .filter((st) => /\bRAISE\b/i.test(st) && RETRYABLE.test(st) && DISAGREEMENT.test(st))
    .map((st) => st.replace(/\s+/g, ' ').trim());
}

describe('a refusal that cannot change is not a serialization failure', () => {
  const fix = read(FIX);
  const body = code(fix);

  it('moves exactly the twelve disagreement refusals, each from a pinned body', () => {
    for (const [sig, key] of MOVED) {
      expect(body, sig).toContain(`'${sig}'`);
      expect(body, key).toContain(`'${key}'`);
    }
    // eleven functions, each pinned by an md5 of its installed definition
    expect(body.match(/'[0-9a-f]{32}'/g)?.length).toBe(11);
    expect(body).toContain('IF v_changed <> 12 THEN');
    expect(body).toMatch(
      /v_new_frag := left\(v_frag, length\(v_frag\) - 7\) \|\| \$q\$'55000'\$q\$/
    );
    // the reverse substitution must reproduce the pinned text
    expect(body).toMatch(/IF md5\(v_back\) <> r\.pin THEN/);
  });

  it('is one transaction with one dynamic definition and no other write', () => {
    expect(body.match(/^\s*BEGIN;\s*$/gm)?.length).toBe(1);
    expect(body.match(/^\s*COMMIT;\s*$/gm)?.length).toBe(1);
    expect(body.match(/\bEXECUTE\b/g)?.length).toBe(1);
    expect(body).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|DROP|ALTER)\b/i);
  });

  it('recognises the shape that caused the outage', () => {
    const outage = `
      IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
        RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
          p_observed_winner_id, v_winner.user_id, p_tournament_id
          USING ERRCODE = '40001';
      END IF;`;
    expect(disagreementsRaisedAsRetryable(outage)).toHaveLength(1);
    // a lost compare-and-set stays a legitimate 40001
    const cas = `RAISE EXCEPTION 'finish claim CAS changed % rows for tournament %', v_rows, p_tournament_id USING ERRCODE = '40001';`;
    expect(disagreementsRaisedAsRetryable(cas)).toHaveLength(0);
    // the same refusal with an ordinary code is fine
    expect(disagreementsRaisedAsRetryable(outage.replace("'40001'", "'55000'"))).toHaveLength(0);
  });

  it('no migration after the fix raises a disagreement as 40001 or 40P01', () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f.slice(0, 14) > FIX_VERSION)
      .sort();
    const offenders = later.flatMap((f) =>
      disagreementsRaisedAsRetryable(read(f)).map((st) => `${f}: ${st}`)
    );
    expect(offenders).toEqual([]);
  });
});
