/**
 * LIGHTNING PHASE 12 (SPECIFICATION PHASE 20, LOAD / STRESS / CHAOS, THE
 * DATABASE SIDE).
 *
 * A static reading of the load and chaos harness
 * scripts/dev/test-lightning-phase12-load-chaos.sh and of the one migration it
 * found necessary, 20261009151825. The harness proves every claim against a
 * running estate under many real concurrent backends; this file pins that the
 * harness keeps asserting what the specification requires (no duplicate
 * money, no lost money, no duplicate player, hand or blind, no orphan
 * reservation, no ambiguous settlement), that it drives the real production
 * doors with real concurrency and real faults, that its scoreboard reports
 * P50/P95/P99, and that the migration is an asserted substitution touching
 * only the five bodies it names.
 *
 * LIGHTNING_P12_MIGRATION and LIGHTNING_P12_HARNESS override the files under
 * test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql';
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SQL = fs.readFileSync(
  process.env.LIGHTNING_P12_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE),
  'utf8'
);
const HARNESS = fs.readFileSync(
  process.env.LIGHTNING_P12_HARNESS ??
    path.join(ROOT, 'scripts', 'dev', 'test-lightning-phase12-load-chaos.sh'),
  'utf8'
);
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-12-load-chaos.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase12-load-chaos.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
/** The harness with its shell and SQL comments removed. */
const HCODE = HARNESS.split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

/** The invariants lc.check returns, one row each, PASS or FAIL. */
const INVARIANTS = [
  'chip_conservation',
  'no_lost_or_duplicate_money_per_seat',
  'every_hand_conserves',
  'no_duplicate_money_settled_once',
  'idempotent_replays_and_no_door_violation',
  'no_duplicate_player',
  'no_ghost_and_nobody_left_behind',
  'no_duplicate_hand',
  'no_duplicate_blind',
  'no_orphan_reservation',
  'no_ambiguous_settlement',
  'no_unwarranted_freeze',
  'cluster_modes_consistent',
  'no_money_moved_by_a_mode_change',
  'no_unexpected_error',
];
/** The production doors the engine ops drive. */
const DOORS = [
  'fn_lightning_match_and_form(',
  'fn_lightning_form_hand(',
  'fn_lightning_instance_begin_dealing(',
  'fn_lightning_bind_hand_number(',
  'fn_lightning_fast_fold(',
  'fn_lightning_settle_hand(',
  'fn_lightning_presence_report(',
  'fn_lightning_auto_rebuy(',
  'fn_lightning_stop_playing(',
  'fn_cash_clusters_tick_all(',
  'fn_cash_cluster_lightning_drive(',
  'fn_lightning_reap_formations(',
  'fn_lightning_reap_expired_disconnects(',
  'fn_cash_cluster_reap_stuck_conversions(',
  'fn_lightning_instance_abandon(',
];
/** The five bodies the migration substitutes into, and nothing else. */
const REWRITTEN = [
  'fn_cash_cluster_commit_must_move(uuid,uuid)',
  'fn_lightning_pool_exposure(uuid,uuid)',
  'fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  'fn_cash_cluster_commit_lightning(uuid,uuid)',
  'fn_cash_cluster_abort_pending_off(uuid,uuid,text)',
];

describe('the harness asserts the outcome the specification requires', () => {
  it('lc.check returns every invariant, one row each, and the run fails on any FAIL', () => {
    for (const inv of INVARIANTS) expect(HARNESS, inv).toContain(`inv := '${inv}'`);
    expect(HARNESS).toContain('FROM lc.check(');
    expect(HARNESS).toMatch(/if \[ "\$failed" != 0 \]; then[\s\S]*?exit 1/);
    expect(HARNESS).toContain('FAIL: $sections of the $expected scenarios reported');
  });
  it('conservation is the books before against the books after, per Cluster set and per seat', () => {
    expect(HARNESS).toContain('CREATE FUNCTION lc.snapshot(p_scen text)');
    expect(HARNESS).toContain(
      'round(t.seats + t.wallets + t.addons - v_amt, 2) = round(m.total, 2)'
    );
    expect(HARNESS).toContain(
      'round(s.stack + coalesce(n.net, 0) + coalesce(rl.amt, 0), 2) IS DISTINCT FROM round(ts.stack, 2)'
    );
  });
  it('settled exactly once means one commit, one history row, one event and one receipt per hand', () => {
    expect(HARNESS).toContain(
      'FROM public.hand_atomic_commits c WHERE c.hand_number = lh.hand_number) <> 1'
    );
    expect(HARNESS).toContain("e.kind = 'hand_settled'");
    expect(HARNESS).toContain("PERFORM lc.violate('settle_replay_not_identical'");
    expect(HARNESS).toContain("PERFORM lc.violate('settle_second_request_not_refused'");
  });
  it('the blind ledger is reconciled against the kept formations, and no orphan or ambiguous instance survives', () => {
    expect(HARNESS).toContain("NOT (li.state = 'abandoned' AND li.started_at IS NULL)");
    expect(HARNESS).toContain(
      "rv.state IN ('pending', 'committed') AND li.state IN ('complete', 'abandoned')"
    );
    expect(HARNESS).toContain(
      "li.state = 'abandoned' AND (lh.hand_id IS NULL OR (lh.settled_at IS NULL"
    );
  });
  it('a starving pass, a ghost in the pool and a tripped money guard are failures', () => {
    expect(HARNESS).toContain("PERFORM lc.violate('pass_starved_by_its_budget'");
    expect(HARNESS).toContain("e.payload::text ~ 'MOVED_MONEY'");
    expect(HARNESS).toContain('ts.left_at IS NOT NULL OR ts.user_id IS DISTINCT FROM ps.player_id');
  });
  it('only retryable error classes are tolerated, and they are reported', () => {
    expect(HARNESS).toContain("p_allowed_states text[] DEFAULT ARRAY['40P01', '55P03', '40001']");
  });
});

describe('the harness drives the real chain with real concurrency and real faults', () => {
  it('builds the real chain through Phase 11 on the Phase 11 ground, on port 55561, PostgreSQL 17', () => {
    expect(HARNESS).toContain('LIGHTNING_P12_PORT:-55561');
    expect(HARNESS).toContain(
      '20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql'
    );
    expect(HARNESS).toContain('test-lightning-phase11-integrity-shadow.sh');
    expect(HARNESS).toContain('CREATE EVENT TRIGGER trg_autorevoke_privileged_anon');
    expect(HARNESS).toContain('_lightning_phase_12_load_chaos_*.sql');
    expect(HARNESS).toContain('none of the $predn true predecessor proofs falsified');
  });
  it('calls every production door the engine calls', () => {
    for (const d of DOORS) expect(HARNESS, d).toContain(`public.${d}`);
  });
  it('runs every worker as its own backend and kills them mid transaction', () => {
    expect(HARNESS).toContain('PGAPPNAME="lcw-$name"');
    expect(HARNESS).toContain('pg_terminate_backend(a.pid)');
    expect(HARNESS).toContain('pg_cancel_backend(a.pid)');
    expect(HARNESS).toContain('-c statement_timeout=40 -c lock_timeout=15');
    expect(HARNESS).toContain(
      'CREATE TRIGGER lc_fault_settle AFTER INSERT ON public.lightning_settlement_marker'
    );
    expect(HARNESS).toContain(
      'CREATE TRIGGER lc_fault_form AFTER INSERT ON public.lightning_reservation'
    );
    expect(HARNESS).toContain(
      'CREATE TRIGGER lc_fault_convert AFTER INSERT OR UPDATE ON public.cash_cluster_conversion'
    );
  });
  it('loads every population the specification lists, with a reduced CI profile', () => {
    expect(HARNESS).toContain('pops_default="10 50 100 500 1000 5000 10000"');
    expect(HARNESS).toContain('ci)   pops_default="10 50 100 500"');
    for (const s of ['S1', 'S2', 'S3', 'C1', 'C2', 'C3', 'C4'])
      expect(HARNESS, s).toContain(`if want ${s}; then`);
  });
  it('prints the scoreboard with P50, P95 and P99 per population', () => {
    expect(HARNESS).toContain('LIGHTNING PHASE 12 LOAD SCOREBOARD');
    expect(HARNESS).toContain('percentile_cont(0.50)');
    expect(HARNESS).toContain('percentile_cont(0.95)');
    expect(HARNESS).toContain('percentile_cont(0.99)');
    for (const op of ['match_and_form', 'form_hand', 'fast_fold', 'settle_hand'])
      expect(HARNESS, op).toContain(`'${op}'`);
  });
  it('seats horses beside humans and never reads the flag', () => {
    expect(HARNESS).toContain('PERFORM lc.arrive(p_game, i % 2 = 0)');
    expect(HCODE).not.toMatch(/\bis_horse\b/);
    expect(HCODE).not.toMatch(/(WHERE|AND|OR|ON|SELECT)[^\n]*\bhorse_id\b/);
  });
});

describe('the migration', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('creates and alters no table, and substitutes into exactly five bodies by asserted anchors', () => {
    expect(CODE).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP FUNCTION/);
    const targets = [...CODE.matchAll(/SELECT pg_temp\.lp12c_rewrite\(\s*'public\.([^']+)'/g)].map(
      (m) => m[1]
    );
    expect(targets.sort()).toEqual([...REWRITTEN].sort());
    expect(CODE).toContain('refusing to substitute blind');
    expect(count(CODE, /ARRAY\[1, 1, 1\]\);/g)).toBe(2);
    expect(count(CODE, /ARRAY\[1, 1, 2\]\);/g)).toBe(1);
    expect(count(CODE, /ARRAY\[1, 1, 2, 2\]\);/g)).toBe(1);
    expect(count(CODE, /ARRAY\[1\]\);/g)).toBe(1);
  });
  it('never touches the doors other Phase 12 agents own', () => {
    for (const f of [
      'fn_lightning_config',
      'fn_lightning_pool_status',
      'fn_lightning_pool_enter',
      'fn_lightning_player_legality',
      'fn_lightning_operator_',
      'fn_lightning_alert_sweep',
    ])
      expect(CODE, f).not.toContain(`lp12c_rewrite(\n  'public.${f}`);
  });
  it('the pass budget runs from the end of the first plan', () => {
    expect(SQL).toContain(
      'IF v_first IS NULL THEN v_first := v_plan; v_form_started := clock_timestamp(); END IF;'
    );
    expect(SQL).toContain('      IF clock_timestamp() - v_form_started >= v_budget THEN');
  });
  it('both pool writers lock the live seats in seat-id order before they read them', () => {
    expect(count(SQL, /ORDER BY ts\.id\n {5}FOR SHARE;/g)).toBe(1);
    expect(count(SQL, /ORDER BY ts\.id\n {7}FOR SHARE\) x;/g)).toBe(2);
  });
  it('the money guards compare exactly the rows they locked, and any row their own transaction wrote', () => {
    expect(
      count(
        SQL,
        /AND \(ts\.id = ANY \(v_locked_seats\) OR ts\.xmin = pg_current_xact_id\(\)::xid\)/g
      )
    ).toBe(2);
    expect(
      count(
        SQL,
        /AND \(s\.id = ANY \(v_locked_sessions\) OR s\.xmin = pg_current_xact_id\(\)::xid\)/g
      )
    ).toBe(1);
  });
  it('keeps grants semantically and reads them back per role', () => {
    expect(CODE).toContain("has_function_privilege(t.r, p_sig::regprocedure, 'EXECUTE')");
    expect(CODE).not.toMatch(/acl::text|proacl/);
  });
  it('the exposure reader is the same query in PL/pgSQL', () => {
    expect(SQL).toContain('$b$ LANGUAGE plpgsql');
    expect(SQL).toContain("     AND hp.fold_type IN ('fast', 'normal'));\nEND\n$function$$b$]");
  });
  it('declares ten single-line live proofs, among them law 10.5 and the anti-manipulation pin', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(10);
    for (const p of proofs) expect(p).not.toContain('\n');
    expect(proofs.some((p) => p.includes("~ 'is_horse|horse_id'"))).toBe(true);
    expect(
      proofs.some((p) => p.includes("!~ 'integrity|shadow_comparison|quality_|latency'"))
    ).toBe(true);
    expect(CODE.split("'is_horse|horse_id'").join('')).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
  });
});

describe('CI, the manifest fragment and the changelog', () => {
  it('CI runs the harness on shard 1, after the Phase 11 step, in the CI profile', () => {
    const p11 = CI.indexOf('test-lightning-phase11-integrity-shadow.sh');
    const p12 = CI.indexOf('test-lightning-phase12-load-chaos.sh');
    expect(p11).toBeGreaterThan(0);
    expect(p12).toBeGreaterThan(p11);
    const step = CI.slice(CI.lastIndexOf('- name:', p12), p12);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
    expect(step).toContain('LIGHTNING_CHAOS_PROFILE: ci');
  });
  it('the schema manifest fragment promises nothing new', () => {
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.functions).toEqual([]);
    expect(FRAGMENT._owner).toContain(FILE.replace(/\.sql$/, ''));
  });
  it('the changelog carries the scoreboard and every invariant, in title case, without an em dash', () => {
    expect(CHANGELOG).toContain(FILE);
    expect(CHANGELOG).toContain('P99');
    for (const inv of INVARIANTS) expect(CHANGELOG, inv).toContain(inv);
    expect(CHANGELOG).not.toContain('—');
    const small = [
      'a',
      'an',
      'and',
      'the',
      'of',
      'to',
      'in',
      'on',
      'or',
      'by',
      'at',
      'for',
      'is',
      'its',
      'with',
      'per',
    ];
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
        if (/^[a-z]/.test(w) && !small.includes(w))
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
