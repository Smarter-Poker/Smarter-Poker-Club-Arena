/**
 * LIGHTNING PHASE 13 (SPECIFICATION PHASE 22, THE DATABASE SIDE): ROLLOUT,
 * DRAIN AND ROLLBACK.
 *
 * A static reading of ONE migration, 20261009235505. The harness
 * scripts/dev/test-lightning-phase13-rollout-drain.sh proves every claim
 * against a running catalogue and estate; this file proves what a catalogue
 * cannot see: the transaction shape, the signatures and grants the app and
 * the engine are built against, that every change to an existing body is an
 * asserted substitution, that the emergency drain waits for a dealing hand
 * and ends through the existing reversion, that nothing in the seating path
 * calls an operator door, and that horses are never singled out.
 *
 * LIGHTNING_P13_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql';
const MIGRATION =
  process.env.LIGHTNING_P13_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase13-rollout-drain.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-13-rollout-drain.md');
const ROLLOUT = read('docs', 'lightning', 'ROLLOUT.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase13-rollout-drain.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** The text of one CREATE OR REPLACE FUNCTION, header to its closing tag. */
function fn(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const end = SQL.indexOf('$fn$;', start);
  expect(end, name).toBeGreaterThan(start);
  return SQL.slice(start, end);
}
/** The replacement text of one asserted substitution. */
function rewrite(signature: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp13_rewrite(\n  'public.${signature}'`);
  expect(start, signature).toBeGreaterThan(0);
  const ends = [
    SQL.indexOf('SELECT pg_temp.lp13_rewrite(', start + 1),
    SQL.indexOf('-- =====', start),
  ].filter((i) => i > start);
  return SQL.slice(start, Math.min(...ends));
}

const BROWSER = ['fn_lightning_operator_control', 'fn_lightning_rollout_readiness'];
const SERVICE = [
  'fn_lightning_drain_advance',
  'fn_lightning_operator_may_control',
  'fn_lightning_operator_state',
  'fn_lightning_spec_flags',
  'fn_lightning_joins_enabled',
  'fn_lightning_pool_enter_seated',
];
const TABLES = [
  'lightning_operator_request',
  'lightning_cluster_control',
  'lightning_cluster_drain',
];
const SUBSTITUTED = [
  'fn_lightning_config(uuid)',
  'fn_cash_cluster_lightning_state(uuid)',
  'fn_lightning_pool_enter(uuid,timestamp with time zone)',
  'fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'fn_lightning_pool_status(uuid)',
  'fn_lightning_reconnect_state(uuid)',
  'fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
  'fn_cash_cluster_commit_must_move(uuid,uuid)',
  'fn_cash_cluster_lightning_drive(uuid)',
  'fn_cash_clusters_tick_all(jsonb)',
  'fn_lightning_operator_cluster_row(uuid,timestamp with time zone)',
  'fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)',
  'fn_lightning_operator_session_trail(uuid,uuid)',
];
const ACTIONS = [
  'pause',
  'resume',
  'disable_joins',
  'enable_joins',
  'drain',
  'freeze',
  'unfreeze',
  'enable_lightning',
  'disable_lightning',
  'set_matcher_version',
  'disable_matcher_version',
  'enable_matcher_version',
  'rollback_matcher_version',
  'set_flag',
  'set_worker_mode',
];
const FLAGS = [
  'lightning_v1',
  'lightning_fast_fold',
  'lightning_fold_watch',
  'lightning_multi_table',
  'lightning_pool_health',
  'lightning_repeat_suppression',
  'lightning_session_stats',
  'lightning_shadow_matcher',
  'lightning_auto_rebuy',
  'lightning_adaptive_liquidity',
];
const CODES = [
  'NOT_AUTHORIZED',
  'REASON_REQUIRED',
  'INVALID_ACTION',
  'INVALID_ARGS',
  'CLUSTER_NOT_FOUND',
  'CLUSTER_FROZEN',
  'CLUSTER_BUSY',
  'UNKNOWN_VERSION',
  'VERSION_DISABLED',
  'NOT_SQL_MATCHER',
  'FLAG_NOT_SUPPORTED',
  'ALREADY',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('creates exactly the three tables, alters none, and puts no foreign key anywhere', () => {
    const created = [...CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map(
      (m) => m[1]
    );
    expect(created.sort()).toEqual([...TABLES].sort());
    expect(CODE).not.toMatch(/ALTER TABLE public\.\w+\s+(ADD|DROP|ALTER) /);
    expect(CODE).not.toMatch(/REFERENCES/);
    for (const m of CODE.matchAll(/CREATE (UNIQUE )?INDEX (\w+ )*(\w+)/g))
      expect(m[0]).toContain('IF NOT EXISTS');
  });
  it('takes no DDL lock on tables, table_seats or cash_games', () => {
    expect(CODE).not.toMatch(/(ALTER|LOCK) TABLE (public\.)?(tables|table_seats|cash_games)\b/);
    expect(CODE).not.toMatch(/ON public\.(tables|table_seats|cash_games|cash_cluster_events) /);
  });
});

describe('the tables', () => {
  it('all three have RLS on, no policy and no privilege for any role', () => {
    for (const t of TABLES) {
      expect(CODE).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(CODE).toContain(
        `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`
      );
      expect(CODE).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON TABLE public\\.${t}`));
    }
    expect(CODE).not.toMatch(/CREATE POLICY/);
  });
  it('a Cluster holds at most one open drain, and the request and drain ledgers refuse TRUNCATE', () => {
    expect(CODE).toMatch(
      /lightning_cluster_drain_one_open\s+ON public\.lightning_cluster_drain \(cluster_id\) WHERE \(completed_at IS NULL\);/
    );
    expect(CODE).toContain("ARRAY['lightning_operator_request', 'lightning_cluster_drain']");
    expect(CODE).toContain('EXECUTE FUNCTION public.fn_lightning_refuses_truncate()');
  });
});

describe('the doors', () => {
  it('the control and readiness doors are definers for authenticated and service_role, never anon', () => {
    for (const d of BROWSER) {
      const f = fn(d);
      expect(f, d).toContain('SECURITY DEFINER');
      expect(f, d).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(f, d).toContain("'NOT_AUTHORIZED'");
      expect(CODE).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${d}\\([^)]*\\) FROM PUBLIC, anon;`)
      );
      expect(CODE).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${d}\\([^)]*\\) TO authenticated, service_role;`
        )
      );
    }
  });
  it('the helpers and the drain are the service alone, and only the drain runs as its owner', () => {
    for (const d of SERVICE) {
      const f = fn(d);
      expect(f.includes('SECURITY DEFINER'), d).toBe(d === 'fn_lightning_drain_advance');
      expect(f, d).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(CODE).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${d}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`
        )
      );
      expect(CODE).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${d}\\([^)]*\\) TO service_role;`)
      );
    }
  });
  it('the signatures the app and the engine are built against', () => {
    expect(SQL).toContain(
      "public.fn_lightning_operator_control(\n  p_cluster_id uuid, p_action text, p_reason text, p_args jsonb DEFAULT '{}'::jsonb)"
    );
    expect(SQL).toContain('public.fn_lightning_rollout_readiness(p_cluster_id uuid)');
    expect(SQL).toContain(
      'public.fn_lightning_drain_advance(p_cluster_id uuid, p_now timestamptz DEFAULT NULL)'
    );
  });
  it('the control gate is the service, a platform admin or the club control roles', () => {
    const g = fn('fn_lightning_operator_may_control');
    expect(g).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(g).toContain('public.fn_is_platform_admin()');
    expect(g).toContain('public.fn_ca_is_club_control(p_club_id, auth.uid())');
    const d = fn('fn_lightning_operator_control');
    expect(d).toContain('public.fn_lightning_operator_may_control(v_club)');
    expect(d).toMatch(
      /v_action = 'unfreeze' AND NOT \(v_service OR coalesce\(public\.fn_is_platform_admin\(\), false\)\)/
    );
    expect(fn('fn_lightning_rollout_readiness')).toContain(
      'public.fn_lightning_operator_may(g.club_id)'
    );
  });
  it('every action, flag and refusal code of the contract is in the door', () => {
    const d = fn('fn_lightning_operator_control');
    for (const a of ACTIONS) expect(d, a).toContain(`'${a}'`);
    for (const f of FLAGS) expect(d, f).toContain(`'${f}'`);
    for (const c of CODES) expect(d, c).toContain(`'${c}'`);
    expect(d).toContain('length(v_reason) < 3');
    expect(d).toContain("'operator_' || v_action");
    expect(d).toContain('INSERT INTO public.lightning_operator_request');
    expect(d).toContain("'replayed', true");
  });
  it('the manual freeze takes the freeze path and the unfreeze is fn_cash_cluster_unfreeze', () => {
    const d = fn('fn_lightning_operator_control');
    expect(d).toContain("UPDATE public.cash_games SET cluster_mode = 'frozen'");
    expect(d).toContain("'lightning_cluster_frozen:' || g.id");
    expect(d).toContain('LIGHTNING_CLUSTER_FROZEN');
    expect(d).toContain("'cluster_frozen'");
    expect(d).toContain('public.fn_cash_cluster_unfreeze(g.id, v_actor, v_reason)');
    expect(d).not.toMatch(/fn_lightning_settlement_freeze\(/);
  });
});

describe('the emergency drain', () => {
  it('waits while a hand deals, abandons only what never dealt, and ends through the reversion', () => {
    const f = fn('fn_lightning_drain_advance');
    const wait = f.indexOf('IF v_live > 0 OR v_wait > 0 THEN');
    const begin = f.indexOf(
      "public.fn_cash_cluster_begin_pending_off(g.id, v_req, 'lightning_drain')"
    );
    const commit = f.indexOf('public.fn_cash_cluster_commit_must_move(g.id, v_req)');
    expect(wait).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(wait);
    expect(commit).toBeGreaterThan(begin);
    expect(f).toMatch(/li\.state IN \('forming', 'reserved'\)\s+ORDER BY li\.id\s+FOR UPDATE/);
    expect(f).toContain('v_now >= d.deadline_at');
    expect(f).toContain('public.fn_lightning_instance_abandon(');
    expect(f).not.toMatch(/SET state = 'abandoned'/);
    expect(f).not.toMatch(
      /UPDATE public\.(table_seats|cash_player_session|lightning_blind_ledger|lightning_pool_session)/
    );
    for (const n of [
      'settle_active_hands',
      'restore_players',
      'rebuild_must_move',
      'preserve_stacks',
      'audit_trail',
    ])
      expect(f, n).toContain(`'${n}'`);
    const d = fn('fn_lightning_operator_control');
    for (const n of ['stop_new_joins', 'stop_new_formation', 'let_active_hands_finish'])
      expect(d, n).toContain(`'${n}'`);
  });
  it('the drive and the tick drive it, and the commit names the exit lightning_drained', () => {
    expect(rewrite('fn_cash_cluster_lightning_drive(uuid)')).toContain(
      'v_drain := public.fn_lightning_drain_advance(g.id);'
    );
    expect(rewrite('fn_cash_clusters_tick_all(jsonb)')).toContain(
      "OR cg.cluster_mode IN ('pending_on', 'lightning', 'pending_off', 'draining')"
    );
    expect(rewrite('fn_cash_cluster_commit_must_move(uuid,uuid)')).toContain(
      "exit_reason = CASE WHEN v_drained THEN 'lightning_drained' ELSE 'lightning_off' END"
    );
    expect(rewrite('fn_cash_cluster_begin_pending_off(uuid,uuid,text)')).toContain(
      "AND NOT (g.cluster_mode = 'draining' AND p_reason IS NOT DISTINCT FROM 'lightning_drain')"
    );
  });
});

describe('the substitutions', () => {
  it('every existing body is changed by an asserted substitution, never rewritten', () => {
    for (const s of SUBSTITUTED)
      expect(SQL, s).toContain(`SELECT pg_temp.lp13_rewrite(\n  'public.${s}'`);
    expect(count(SQL, /SELECT pg_temp\.lp13_rewrite\(/g)).toBe(SUBSTITUTED.length);
    for (const s of SUBSTITUTED) {
      const name = s.slice(0, s.indexOf('('));
      expect(SQL, name).not.toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
    }
    expect(SQL).toContain(
      "RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind'"
    );
    expect(SQL).toContain("RAISE EXCEPTION '% did not keep who may execute (%) and its comment'");
  });
  it('the configuration answers the new keys in its third object and clamps the live matcher to the SQL matcher', () => {
    const c = rewrite('fn_lightning_config(uuid)');
    for (const k of [
      'drain_timeout_ms',
      'lightning_joins_enabled',
      'lightning_joins_disabled_at',
      'matcher_version_previous',
      'matcher_versions_disabled',
      'shadow_matcher_disabled',
      'lightning_fast_fold',
      'lightning_fold_watch',
    ])
      expect(c, k).toContain(`'${k}'`);
    expect(c).toContain("'drain_timeout_ms', 120000, 10000, 3600000, true");
    expect(c).toContain("'not_a_sql_matcher'");
    expect(c).toContain("'version_disabled'");
    expect(c).toContain("    'alert_latency_p95_ms', v_lc,\n");
  });
  it('the seating path reads the joins key and calls no operator function', () => {
    const l = rewrite('fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)');
    expect(l).toContain("'LIGHTNING_JOINS_DISABLED'");
    expect(l).toContain("g.lcfg ->> 'lightning_joins_enabled'");
    for (const s of [l, rewrite('fn_cash_clusters_tick_all(jsonb)')]) {
      const replaced = s.slice(s.indexOf('ARRAY[$b$'));
      expect(replaced).not.toMatch(
        /integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_/
      );
    }
    expect(rewrite('fn_lightning_pool_enter(uuid,timestamp with time zone)')).toContain(
      'IF NOT public.fn_lightning_joins_enabled(g.id) THEN'
    );
  });
  it('nothing in the file reads a horse flag', () => {
    expect(CODE).not.toMatch(/is_horse|horse_id/);
  });
  it('declares sixteen live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(16);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the proof harness, CI and the documents', () => {
  it('the harness runs the real chain through 20261009181945 and the file on port 55564', () => {
    expect(HARNESS).toContain('LIGHTNING_P13_PORT:-55564');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain(
      '20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an'
    );
    expect(HARNESS).toContain('PASS: Lightning Phase 13');
    expect(HARNESS).toContain('if [ "$oks" != 20 ]; then');
  });
  it('CI runs the harness on shard 1 after the Phase 11 remediation, and the load rig over the Phase 13 chain', () => {
    const p11r = CI.indexOf('test-lightning-phase11-remediation.sh');
    const p13 = CI.indexOf('test-lightning-phase13-rollout-drain.sh');
    expect(p11r).toBeGreaterThan(0);
    expect(p13).toBeGreaterThan(p11r);
    const step = CI.slice(CI.lastIndexOf('- name:', p13), p13);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
    const lc = CI.indexOf('scripts/dev/fixtures/lightning-phase13-operator-ground.sql');
    expect(lc).toBeGreaterThan(p13);
    expect(CI.slice(lc, CI.indexOf('run:', lc))).toContain(FILE);
  });
  it('the schema manifest fragment promises exactly the three tables and the eight functions', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...BROWSER, ...SERVICE].sort());
    expect([...FRAGMENT.tables].sort()).toEqual([...TABLES].sort());
  });
  it('the changelog and the rollout plan name the doors and the stages, in title case, with no em dash', () => {
    for (const p of [...BROWSER, ...TABLES, 'lightning_drained', 'drain_timeout_ms', FILE])
      expect(CHANGELOG, p).toContain(p);
    for (const p of [
      'Dark',
      'Shadow',
      'Pilot',
      'Limited',
      'General',
      'fn_lightning_rollout_readiness',
      'drain',
    ])
      expect(ROLLOUT, p).toContain(p);
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
      'per',
      'with',
    ];
    for (const doc of [CHANGELOG, ROLLOUT]) {
      expect(doc).not.toContain('—');
      for (const h of doc.match(/^#{1,4} .+$/gm) ?? []) {
        for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
          if (/^[a-z]/.test(w) && !small.includes(w))
            throw new Error(`heading word not in title case: ${w} in ${h}`);
        }
      }
    }
  });
});
