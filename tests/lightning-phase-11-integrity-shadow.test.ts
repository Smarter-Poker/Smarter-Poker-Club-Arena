/**
 * LIGHTNING PHASE 11 (SPECIFICATION PHASES 18 AND 19, THE DATABASE SIDE):
 * INTEGRITY TELEMETRY AND THE SHADOW MATCHER LEDGER.
 *
 * A static reading of ONE migration, 20261008161509. The harness
 * scripts/dev/test-lightning-phase11-integrity-shadow.sh proves every claim
 * against a running catalogue and estate; this file proves what a catalogue
 * cannot see: the transaction shape, the signatures and grants the engine is
 * built against, that the one change to an existing body is an asserted
 * substitution, that the existing integrity store is written in its own
 * convention while the external worker's store is left alone, that nothing
 * in the seating path can read the telemetry, and that horses are never
 * singled out.
 *
 * LIGHTNING_P11_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche.sql';
const MIGRATION =
  process.env.LIGHTNING_P11_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase11-integrity-shadow.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-08-lightning-phase-11-integrity-shadow.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase11-integrity-shadow.json')
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

/** The six doors this file creates. */
const DOORS = [
  'fn_lightning_integrity_scan',
  'fn_lightning_integrity_report',
  'fn_lightning_quality_components',
  'fn_lightning_quality_score',
  'fn_lightning_shadow_record',
  'fn_lightning_shadow_report',
];
/** The four that touch the new tables, and so run as their owner. */
const DEFINERS = [
  'fn_lightning_integrity_scan',
  'fn_lightning_integrity_report',
  'fn_lightning_shadow_record',
  'fn_lightning_shadow_report',
];
const TABLES = ['lightning_integrity_signal', 'lightning_matcher_shadow_comparison'];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('creates exactly the two tables, alters none, and puts no foreign key on cash_games', () => {
    const created = [...CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map(
      (m) => m[1]
    );
    expect(created.sort()).toEqual([...TABLES].sort());
    expect(CODE).not.toMatch(/ALTER TABLE public\.\w+\s+(ADD|DROP|ALTER) /);
    expect(CODE).not.toMatch(/REFERENCES/);
  });
  it('the two scan indexes land only on the Lightning tables and are guarded', () => {
    expect(CODE).toContain(
      'CREATE INDEX IF NOT EXISTS lightning_hand_by_formed_at\n  ON public.lightning_hand (formed_at, cluster_id);'
    );
    expect(CODE).toContain(
      'CREATE INDEX IF NOT EXISTS lightning_pool_session_by_entered\n  ON public.lightning_pool_session (cluster_id, entered_at);'
    );
    for (const m of CODE.matchAll(/CREATE (UNIQUE )?INDEX (\w+ )*(\w+)/g))
      expect(m[0]).toContain('IF NOT EXISTS');
  });
});

describe('the tables', () => {
  it('both have RLS on, no policy and no table privilege for any role', () => {
    for (const t of TABLES) {
      expect(CODE).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(CODE).toContain(
        `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`
      );
      expect(CODE).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON TABLE public\\.${t}`));
    }
    expect(CODE).not.toMatch(/CREATE POLICY/);
  });
  it('the signal store is keyed for idempotency with the single-player NULL as a value, and shaped on collusion_tracking', () => {
    expect(CODE).toMatch(
      /lightning_integrity_signal_one_per_key\s+ON public\.lightning_integrity_signal \(cluster_id, pattern_type, window_start, window_end, player_a, player_b\)\s+NULLS NOT DISTINCT;/
    );
    for (const c of [
      'player_a',
      'player_b',
      'pattern_type',
      'suspicion_score',
      'evidence',
      'window_start',
      'window_end',
      'status',
    ])
      expect(CODE).toMatch(new RegExp(`^  ${c}\\s+`, 'm'));
    expect(CODE).toContain("status IN ('open', 'reviewed', 'cleared', 'actioned')");
    expect(CODE).toContain(
      "(source = 'engine') = (pattern_type IN ('DECISION_LATENCY', 'TIMING_CORRELATION'))"
    );
  });
  it('the ledger records both versions, both sides, both components and the weights per comparison', () => {
    for (const c of [
      'live_matcher_version',
      'shadow_matcher_version',
      'live_metrics',
      'shadow_metrics',
      'live_components',
      'shadow_components',
      'live_quality_score',
      'shadow_quality_score',
      'quality_weights',
    ])
      expect(CODE).toMatch(new RegExp(`^  ${c}\\s+`, 'm'));
    expect(CODE).toContain(
      '(cluster_id, window_from, window_to, live_matcher_version, shadow_matcher_version)'
    );
  });
});

describe('the doors', () => {
  it('all six are service_role alone; the four that touch the tables run as their owner', () => {
    for (const d of DOORS) {
      const f = fn(d);
      expect(f.includes('SECURITY DEFINER'), d).toBe(DEFINERS.includes(d));
      expect(CODE).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${d}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`
        )
      );
      expect(CODE).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${d}\\([^)]*\\) TO service_role;`)
      );
      expect(CODE).not.toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${d}\\([^)]*\\) TO [^;]*(authenticated|anon)`
        )
      );
    }
  });
  it('the signatures the engine is built against', () => {
    expect(SQL).toContain(
      'public.fn_lightning_integrity_scan(\n  p_cluster_id uuid DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_integrity_report(\n  p_cluster_id uuid, p_signals jsonb, p_now timestamptz DEFAULT clock_timestamp())'
    );
    expect(SQL).toContain(
      'public.fn_lightning_shadow_record(\n  p_cluster_id uuid, p_live_version text, p_shadow_version text,\n  p_window_from timestamptz, p_window_to timestamptz, p_live jsonb, p_shadow jsonb)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_shadow_report(\n  p_cluster_id uuid DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_quality_score(p_metrics jsonb, p_weights jsonb DEFAULT NULL)'
    );
    expect(SQL).toContain('public.fn_lightning_quality_components(p_metrics jsonb)');
  });
  it('the scan writes the existing pair store in its own convention, and never the external worker store or the club flags', () => {
    const s = fn('fn_lightning_integrity_scan').replace(/--.*$/gm, '');
    expect(s).toContain('INSERT INTO public.ca_collusion_signals');
    expect(s).toContain("'signal', 'lightning_chip_flow'");
    expect(s).toContain("x.detail ->> 'lightning_key'");
    expect(s).not.toMatch(/collusion_tracking|anti_cheat_flags|fn_ca_raise_drift_incident/);
    expect(s).toContain('public.user_sessions');
    expect(s).toContain('referred_by');
  });
  it('the scan is bounded and never reaches the tick', () => {
    const s = fn('fn_lightning_integrity_scan');
    expect(s).toContain('c_max_hands      constant integer := 20000;');
    expect(s).toContain('c_max_sessions   constant integer := 5000;');
    expect(s).toContain('c_max_clusters   constant integer := 50;');
    expect(s).toContain("interval '7 days'");
    expect(CODE).not.toMatch(/fn_cash_clusters_tick_all/);
  });
  it('every upsert leaves an operator status alone and writes nothing when the numbers are the same', () => {
    const sets = CODE.match(/DO UPDATE SET [^;]+?RETURNING/gs) ?? [];
    expect(sets.length).toBe(3);
    for (const u of sets) {
      expect(u).not.toMatch(/\bstatus\b/);
      expect(u).toContain(
        'IS DISTINCT FROM (EXCLUDED.suspicion_score, EXCLUDED.severity, EXCLUDED.evidence)'
      );
    }
  });
  it('the ingest door takes the engine object, caps both lists, refuses card keys and decides with stated thresholds', () => {
    const s = fn('fn_lightning_integrity_report');
    expect(s).toContain('c_max_players   constant integer := 500;');
    expect(s).toContain('c_max_pairs     constant integer := 200;');
    expect(s).toContain("'evidence_carries_cards'");
    for (const k of [
      'player_id',
      'decisions',
      'timeouts',
      'p50_ms',
      'p95_ms',
      'mean_ms',
      'stddev_ms',
      'cv',
      'fast_share',
      'player_a',
      'player_b',
      'hands_together',
      'sequential_actions',
      'fast_follows',
      'latency_corr',
      'dropped_players',
      'dropped_pairs',
      'fast_ms',
    ])
      expect(s, k).toContain(`'${k}'`);
  });
  it('the shadow record validates the engine side objects and falls back for a missing live version', () => {
    const s = fn('fn_lightning_shadow_record');
    for (const k of [
      'passes',
      'quorum_passes',
      'failed_passes',
      'groups',
      'seated',
      'formation_success_rate',
      'failure_rate',
      'wait_ms',
      'bb_fairness',
      'position_fairness',
      'opponent_diversity',
      'instance_occupancy',
    ])
      expect(s, k).toContain(`'${k}'`);
    expect(s).toContain("p_live ->> 'matcher_version'");
    expect(s).toContain("'SAME_VERSION'");
    expect(s).toContain("'IDEMPOTENCY_CONFLICT'");
  });
});

describe('the one substitution is asserted', () => {
  it('the rewriter reads production, counts each anchor, refuses a blind replace and reads back the grants', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION pg_temp.lp11_rewrite(');
    expect(SQL).toContain('refusing to substitute blind');
    expect(SQL).toContain('did not keep who may execute');
    expect(count(SQL, /SELECT pg_temp\.lp11_rewrite\(/g)).toBe(1);
    expect(SQL).toContain(
      "SELECT pg_temp.lp11_rewrite(\n  'public.fn_lightning_config(uuid)',\n  '''quality_weights''',"
    );
  });
  it('the configuration gains the seven Phase 11 keys, both engine switches off, in a second object', () => {
    for (const k of [
      'lightning_shadow_matcher',
      'shadow_matcher_version',
      'shadow_window_ms',
      'shadow_max_players',
      'shadow_pass_budget_ms',
      'integrity_telemetry',
      'quality_weights',
    ])
      expect(SQL, k).toContain(`'${k}', v_`);
    expect(SQL).toContain('v_sh_on := false;');
    expect(SQL).toContain('v_it_on := false;');
    expect(SQL).toContain("'shadow_window_ms', 300000, 60000, 3600000, true");
    expect(SQL).toContain("'shadow_max_players', 500, 2, 5000, true");
    expect(SQL).toContain("'shadow_pass_budget_ms', 50, 5, 1000, true");
    expect(SQL).toContain(
      "jsonb_build_object('next_hand_speed', 0.25, 'formation_success', 0.20,\n                                 'bb_fairness', 0.15, 'opponent_diversity', 0.15,\n                                 'instance_utilization', 0.10, 'reliability', 0.15)"
    );
    expect(SQL).toContain("    'invalid', v_inv)\n    -- LIGHTNING PHASE 11");
  });
});

describe('law 10.5, no matchmaking manipulation, and the live proofs', () => {
  it('no body reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
    expect(SQL).toMatch(/~ 'is_horse\|horse_id'\)\)/);
  });
  it('a live proof pins that no seating-path body names the store, the mirror, the ledger or the score', () => {
    expect(SQL).toContain(
      "'lightning_integrity_signal|lightning_matcher_shadow_comparison|ca_collusion_signals|collusion_tracking|anti_cheat_flags|quality_score|quality_weights|fn_lightning_integrity_'"
    );
    for (const f of [
      'fn_lightning_form_hand',
      'fn_lightning_player_legality',
      'fn_lightning_match(',
      'fn_lightning_match_plan',
      'fn_lightning_match_and_form',
      'fn_cash_clusters_tick_all',
    ])
      expect(SQL, f).toContain(`public.${f}`);
  });
  it('declares fifteen live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(15);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through the migration under test on port 55559', () => {
    expect(HARNESS).toContain('LIGHTNING_P11_PORT:-55559');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('20261008142857_lightning_phase_9_remediation_the_ended_session');
    expect(HARNESS).toContain('PASS: Lightning Phase 11');
  });
  it('CI runs the harness on shard 1 after the Phase 9 remediation step', () => {
    const p9r = CI.indexOf('test-lightning-phase9r-remediation.sh');
    const p11 = CI.indexOf('test-lightning-phase11-integrity-shadow.sh');
    expect(p9r).toBeGreaterThan(0);
    expect(p11).toBeGreaterThan(p9r);
    const step = CI.slice(CI.lastIndexOf('- name:', p11), p11);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises exactly the two tables and the six doors', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...DOORS].sort());
    expect([...FRAGMENT.tables].sort()).toEqual([...TABLES].sort());
  });
  it('the changelog names the doors, the tables, the keys and the file, uses title case headings and no em dash', () => {
    for (const p of [
      ...DOORS,
      ...TABLES,
      'quality_weights',
      'integrity_telemetry',
      'lightning_shadow_matcher',
      'ca_collusion_signals',
      FILE,
    ])
      expect(CHANGELOG, p).toContain(p);
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
      'through',
      'with',
    ];
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
        if (/^[a-z]/.test(w) && !small.includes(w))
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
