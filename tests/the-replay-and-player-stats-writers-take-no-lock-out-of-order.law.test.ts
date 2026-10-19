/**
 * ===========================================================================
 *  LAW: THE RECEIPT REPLAY KEEPS NO RECEIPT'S LOCKS, AND BOTH PLAYER_STATS
 *  WRITERS TAKE THEIR PLAYER KEYS IN PLAYER ORDER BEFORE ANY ROW
 * ===========================================================================
 *
 * 2026-10-19, read-only on production:
 *  - pg_cron ca-terminal-receipt-replay-daily (04:37 UTC) runs
 *    fn_ca_replay_terminal_receipts as one transaction. A receipt's
 *    subtransaction that succeeded handed its locks (the finish lane F, the
 *    target's T key, the running target tournament and its tournament_players
 *    rows) to the whole run, so engine hands on that target waited up to 108 s.
 *  - fn_project_hand_side_effects (player order) and
 *    fn_credit_agent_commissions_batch (page order, several hands in one
 *    transaction) deadlocked on player_stats/profile rows: 79 of 95 deadlocks
 *    in six hours.
 *
 * Migration 20261019155432 rolls every proved receipt's subtransaction back
 * (sentinel SQLSTATE CAR01: the receipts write nothing), and makes the batch
 * and the projection take 'player-stats-user:<player>' in player order before
 * the first row. Proved natively, before and after, by
 * scripts/qualification/replay-locks-and-player-stats-keys.py
 * (evidence in docs/evidence/replay-locks-and-player-stats-keys-2026-10-19).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_replay_holds_no_lock_past_its_receipt_player_stats_key_order.sql'))
  .at(-1);
if (!NAME) throw new Error('the replay-locks / player-stats-keys migration is missing');
const MIG = migrationText(NAME);
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const REPLAY = sliceBetween(MIG, '$replay$CREATE OR REPLACE FUNCTION', '$replay$)');
const BATCH = sliceBetween(MIG, '$batch$CREATE OR REPLACE FUNCTION', '$batch$)');
const PROJ = sliceBetween(MIG, '$projection$CREATE OR REPLACE FUNCTION', '$projection$)');
const ROOT = resolve(__dirname, '..');
const HARNESS = 'scripts/qualification/replay-locks-and-player-stats-keys';
const FILES = ['.py', '-schema.sql', '-live.sql', '.manifest.json'].map((x) => HARNESS + x);
const EVIDENCE =
  'docs/evidence/replay-locks-and-player-stats-keys-2026-10-19/replay-locks-and-player-stats-keys-run.json';

const PINS: Array<[string, string, string]> = [
  [
    'fn_ca_replay_terminal_receipts',
    '1d5d067c97c46776fb6c1fc5e02f0b7c',
    '3370c9e5aa0f5f551f011f9fd0023786',
  ],
  [
    'fn_credit_agent_commissions_batch',
    '33e0be86d6a2a88f18be4ec4e058cadd',
    '037beff51de87bbaff09b39377044d7c',
  ],
  [
    'fn_project_hand_side_effects_after_post_commit_20260908',
    'ef3cb3725ca3a1566e0e1254830a9a63',
    'cee6c2257fcc49c6c6974e5fe8832107',
  ],
];

describe('the receipt replay and the player_stats writers take no lock out of order', () => {
  it('replaces pinned production text only, in one bounded transaction, and lands on the measured text', () => {
    for (const [fn, before, after] of PINS) {
      expect(SUBS).toContain(`'${before}', '${after}'`);
      expect(MIG).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '${after}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${fn}')`
      );
    }
    expect(SUBS).toContain('IF md5(pg_get_functiondef(v_sig)) <> s.before_md5 THEN');
    expect(SUBS).toContain('IF v_after <> s.new_def OR md5(v_after) <> s.after_md5 THEN');
    expect(SUBS).toContain('IF v_meta IS DISTINCT FROM s.meta THEN');
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    // No grant moves (the only grant statements restate what production holds,
    // and the ACLs are asserted after them), no table, no job, no repair.
    const code = MIG.replace(/--[^\n]*/g, ' ');
    expect(code.match(/^(?:GRANT|REVOKE)[^\n]*$/gm)).toEqual([
      'REVOKE ALL ON FUNCTION public.fn_ca_replay_terminal_receipts(integer, integer) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_ca_replay_terminal_receipts(integer, integer) TO service_role;',
      'REVOKE ALL ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) FROM PUBLIC, anon, authenticated;',
      'GRANT EXECUTE ON FUNCTION public.fn_credit_agent_commissions_batch(jsonb) TO service_role;',
      'REVOKE ALL ON FUNCTION public.fn_project_hand_side_effects_after_post_commit_20260908(uuid) FROM PUBLIC, anon, authenticated;',
    ]);
    expect(MIG).toContain("RAISE EXCEPTION 'the replay, batch or projection grants moved';");
    expect(code).not.toMatch(/^\s*(CREATE TABLE|ALTER|DROP)\b/im);
    expect(MIG).not.toMatch(/cron\.(schedule|alter_job|unschedule)/);
  });

  it('a proved receipt rolls its own subtransaction back before the next receipt, and is counted as before', () => {
    const inner = REPLAY.indexOf('      BEGIN\n        IF t.sat_hdr THEN');
    const sentinel = REPLAY.indexOf("USING ERRCODE='CAR01';");
    const caught = REPLAY.indexOf(
      "EXCEPTION WHEN SQLSTATE 'CAR01' THEN\n        IF NOT v_proved THEN RAISE; END IF;"
    );
    const counted = REPLAY.indexOf('      v_ok := v_ok + 1;');
    expect(inner).toBeGreaterThan(-1);
    expect(REPLAY.indexOf('v_proved := true;')).toBeGreaterThan(inner);
    expect(sentinel).toBeGreaterThan(REPLAY.indexOf('v_proved := true;'));
    expect(caught).toBeGreaterThan(sentinel);
    expect(counted).toBeGreaterThan(caught);
    // The outer refusal contract is untouched.
    expect(REPLAY).toContain(
      '      WHEN lock_not_available OR query_canceled THEN\n        v_locked := v_locked + 1;'
    );
    expect(REPLAY).toContain("SET lock_timeout TO '2s'");
    expect(REPLAY).toContain("SET statement_timeout TO '600s'");
  });

  it('the batch takes every player key in player order after its club keys and before its first item', () => {
    const clubWalk = BATCH.indexOf('FOREACH v_gate IN ARRAY v_need LOOP');
    const playerWalk = BATCH.indexOf('FOREACH v_user IN ARRAY v_need_users LOOP');
    const first = BATCH.indexOf('fn_process_cash_accounting_source(');
    expect(clubWalk).toBeGreaterThan(-1);
    expect(playerWalk).toBeGreaterThan(clubWalk);
    expect(playerWalk).toBeLessThan(first);
    expect(BATCH).toContain(
      'v_need_users:=ARRAY(SELECT DISTINCT g FROM unnest(v_need_users) g ORDER BY g);'
    );
    expect(BATCH).toContain(
      "pg_advisory_xact_lock(hashtextextended('player-stats-user:'||v_user::text,0))"
    );
    const check = BATCH.indexOf('IF NOT v_clubs<@v_held OR NOT v_users<@v_held_users THEN');
    expect(check).toBeGreaterThan(playerWalk);
    expect(check).toBeLessThan(first);
    expect(BATCH).toContain("'deferred',v_deferred");
  });

  it('the projection takes the same keys in player order before its player_stats rows', () => {
    const keys = PROJ.indexOf(
      "PERFORM pg_advisory_xact_lock(hashtextextended('player-stats-user:'||v_uid::text,0));"
    );
    const rows = PROJ.indexOf('INSERT INTO public.player_stats AS ps');
    expect(keys).toBeGreaterThan(PROJ.indexOf('-- Projection 2:'));
    expect(keys).toBeLessThan(rows);
    expect(PROJ.slice(PROJ.indexOf('FOR v_uid IN'), keys)).toMatch(/ORDER BY 1\n/);
    // The rows themselves keep their order and their arithmetic.
    expect(PROJ).toContain(
      '     ORDER BY s.uid::uuid\n    ON CONFLICT (user_id,club_id) DO UPDATE SET'
    );
  });

  it('is qualified natively on production text, before and after, and the evidence is retained', () => {
    for (const f of FILES) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    }
    const runner = readFileSync(resolve(ROOT, FILES[0]), 'utf8');
    expect(runner).toContain(NAME);
    expect(runner).toContain("report['migration_output'] = cl.psql(DB, '-f', str(MIGRATION))");
    const manifest = JSON.parse(readFileSync(resolve(ROOT, FILES[3]), 'utf8')).functions;
    for (const [fn, before] of PINS) {
      expect(Object.entries(manifest).find(([k]) => k.startsWith(fn + '('))?.[1]).toBe(before);
    }
    const run = JSON.parse(readFileSync(resolve(ROOT, EVIDENCE), 'utf8'));
    expect(run.ok).toBe(true);
    expect(Object.values(run.checks).every(Boolean)).toBe(true);
    expect(run.installed['fn_ca_replay_terminal_receipts(integer,integer)']).toBe(PINS[0][2]);
    expect(run.installed['fn_credit_agent_commissions_batch(jsonb)']).toBe(PINS[1][2]);
    expect(run.installed['fn_project_hand_side_effects_after_post_commit_20260908(uuid)']).toBe(
      PINS[2][2]
    );
  });
});
