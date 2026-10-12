/**
 * LIGHTNING PHASE 12 (SPECIFICATION PHASE 21, THE DATABASE SIDE): THE
 * OPERATOR DASHBOARD, ITS ALERTS, THE LATENCY LEDGER AND A CALLER FOR THE
 * INTEGRITY SCAN.
 *
 * A static reading of ONE migration, 20261009144343. The harness
 * scripts/dev/test-lightning-phase12-operator-alerts.sh proves every claim
 * against a running catalogue and estate; this file proves what a catalogue
 * cannot see: the transaction shape, the signatures and grants the app is
 * built against, that the one change to an existing body is an asserted
 * substitution into a third object, that every operator answer is redacted
 * and none reads a hidden card, that the sweep is isolated, scheduled through
 * the managed cron API and never writes a Cluster's state, that nothing in
 * the seating path can read any of it, and that horses are never singled out.
 *
 * LIGHTNING_P12_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261009144343_lightning_phase_12_operator_dashboard_and_alerting.sql';
const MIGRATION =
  process.env.LIGHTNING_P12_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase12-operator-alerts.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-12-operator-alerts.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase12-operator-alerts.json')
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

/** The six browser doors: authenticated and service_role, never anon. */
const BROWSER = [
  'fn_lightning_operator_overview',
  'fn_lightning_operator_cluster',
  'fn_lightning_operator_hand_replay',
  'fn_lightning_operator_session_trail',
  'fn_lightning_operator_forensics',
  'fn_lightning_operator_signal_review',
];
/** The service's own: the engine's door, the sweep and four helpers. */
const SERVICE = [
  'fn_lightning_latency_report',
  'fn_lightning_alert_sweep',
  'fn_lightning_operator_redact',
  'fn_lightning_operator_may',
  'fn_lightning_operator_cluster_row',
  'fn_lightning_alert_raise',
  'fn_lightning_latency_regression',
];
/** Those that run as their owner. */
const DEFINERS = [
  ...BROWSER,
  'fn_lightning_latency_report',
  'fn_lightning_alert_sweep',
  'fn_lightning_operator_cluster_row',
];
const TABLES = ['lightning_latency_window', 'lightning_alert_sweep_state'];
const LEGS = [
  'fold_ack',
  'ack_to_idle',
  'idle_to_match',
  'match_to_hand',
  'hand_to_first_render',
  'fast_fold_to_next_hand',
  'normal_fold_to_next_hand',
  'fold_watch_to_next_hand',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, the managed cron isolation and a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(
      /^BEGIN;\s+SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;\s+SET LOCAL lock_timeout = '2s';/m
    );
  });
  it('creates exactly the two tables, alters none, and puts no foreign key anywhere', () => {
    const created = [...CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map(
      (m) => m[1]
    );
    expect(created.sort()).toEqual([...TABLES].sort());
    expect(CODE).not.toMatch(/ALTER TABLE public\.\w+\s+(ADD|DROP|ALTER) /);
    expect(CODE).not.toMatch(/REFERENCES/);
    for (const m of CODE.matchAll(/CREATE (UNIQUE )?INDEX (\w+ )*(\w+)/g))
      expect(m[0]).toContain('IF NOT EXISTS');
  });
  it('touches neither tables nor table_seats nor cash_games with DDL', () => {
    expect(CODE).not.toMatch(/(ALTER|LOCK) TABLE (public\.)?(tables|table_seats|cash_games)\b/);
    expect(CODE).not.toMatch(/ON public\.(tables|table_seats|cash_games|cash_cluster_events) /);
  });
});

describe('the tables', () => {
  it('both have RLS on, no policy and no table or sequence privilege for any role', () => {
    for (const t of TABLES) {
      expect(CODE).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(CODE).toContain(
        `REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`
      );
      expect(CODE).not.toMatch(new RegExp(`GRANT [A-Z, ]+ ON TABLE public\\.${t}`));
    }
    expect(CODE).toContain(
      'REVOKE ALL ON SEQUENCE public.lightning_latency_window_id_seq FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CODE).not.toMatch(/CREATE POLICY/);
  });
  it('the latency ledger is one row per Cluster and window start, and carries no card column', () => {
    expect(CODE).toMatch(
      /lightning_latency_window_one_per_window\s+ON public\.lightning_latency_window \(cluster_id, window_from\);/
    );
    expect(CODE).not.toMatch(/^\s+\w*(card|hole|deck|seed)\w*\s+(text|jsonb|uuid)/im);
  });
});

describe('the doors', () => {
  it('the six browser doors are definers for authenticated and service_role, never anon', () => {
    for (const d of BROWSER) {
      const f = fn(d);
      expect(f, d).toContain('SECURITY DEFINER');
      expect(f, d).toContain("SET search_path TO 'public', 'pg_temp'");
      expect(f, d).toContain('public.fn_lightning_operator_may(');
      expect(f, d).toContain("'NOT_AUTHORIZED'");
      expect(f, d).toContain('public.fn_lightning_operator_redact(');
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
  it('the service doors and helpers are the service alone', () => {
    for (const d of SERVICE) {
      const f = fn(d);
      expect(f.includes('SECURITY DEFINER'), d).toBe(DEFINERS.includes(d));
      expect(f, d).toContain("SET search_path TO 'public', 'pg_temp'");
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
  it('the signatures the app and the engine are built against', () => {
    expect(SQL).toContain('public.fn_lightning_operator_overview(p_club_id uuid)');
    expect(SQL).toContain(
      'public.fn_lightning_operator_cluster(\n  p_cluster_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_operator_hand_replay(p_cluster_id uuid, p_hand_id uuid)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_operator_session_trail(p_cluster_id uuid, p_pool_session_id uuid)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_operator_forensics(\n  p_cluster_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit integer DEFAULT 500)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_operator_signal_review(\n  p_signal_id bigint, p_status text, p_note text DEFAULT NULL)'
    );
    expect(SQL).toContain(
      'public.fn_lightning_latency_report(\n  p_cluster_id uuid, p_window_from timestamptz, p_window_to timestamptz, p_legs jsonb)'
    );
    expect(SQL).toContain('public.fn_lightning_alert_sweep(p_now timestamptz DEFAULT now())');
  });
  it('the gate is the service, a platform admin or the club integrity reviewer, and nothing else', () => {
    const g = fn('fn_lightning_operator_may');
    expect(g).toContain("coalesce(auth.role(), '') = 'service_role'");
    expect(g).toContain('public.fn_is_platform_admin()');
    expect(g).toContain('public.fn_ca_can_review_integrity(p_club_id)');
  });
  it('the redactor drops every card, hole, deck, seed and shuffle key at any depth', () => {
    const r = fn('fn_lightning_operator_redact');
    expect(count(r, /'\(card\|hole\|deck\|seed\|shuffle\)'/g)).toBe(2);
    expect(r).toContain('public.fn_lightning_operator_redact(e.value)');
  });
  it('no operator body reads a hidden card or the hand history table', () => {
    for (const d of [...BROWSER, 'fn_lightning_operator_cluster_row']) {
      const f = fn(d);
      expect(f, d).not.toMatch(
        /hole_cards|hand_private_state|table_hole_cards|public\.hand_history\b/
      );
    }
  });
  it('the overview row names counts only, every documented key once', () => {
    const r = fn('fn_lightning_operator_cluster_row');
    for (const k of [
      'cluster_id',
      'name',
      'variant',
      'sb',
      'bb',
      'handedness',
      'lightning_enabled',
      'cluster_mode',
      'cluster_epoch',
      'mode_since',
      'on_threshold',
      'off_threshold',
      'live_eligible',
      'worker_mode',
      'flags',
      'pool',
      'reservations',
      'instances',
      'orphan_reservations',
      'blind_obligations_open',
      'stuck_conversion',
      'frozen',
      'open_alerts',
      'integrity_open_signals',
      'shadow',
      'latency',
    ])
      expect(r, k).toContain(`'${k}', `);
    expect(r).not.toMatch(/'player_id'/);
  });
  it('the latency door names exactly the eight legs and refuses cards, unknown legs and conflicts', () => {
    const f = fn('fn_lightning_latency_report');
    for (const l of LEGS) expect(f, l).toContain(`'${l}'`);
    for (const c of [
      'INVALID_ARGUMENT',
      'CLUSTER_NOT_FOUND',
      'TELEMETRY_OFF',
      'INVALID_WINDOW',
      'INVALID_LEGS',
      'LEGS_TOO_LARGE',
      'CARRIES_CARDS',
      'UNKNOWN_LEG',
      'INVALID_LEG',
      'IDEMPOTENCY_CONFLICT',
    ])
      expect(f, c).toContain(`'${c}'`);
    expect(f).toContain('ON CONFLICT (cluster_id, window_from) DO NOTHING');
  });
  it('the review door writes only the signal and its audit event, as the caller', () => {
    const f = fn('fn_lightning_operator_signal_review');
    expect(f).toContain('auth.uid()');
    expect(f).toContain("p_status NOT IN ('reviewed', 'cleared', 'actioned')");
    expect(f).toContain("'integrity_signal_reviewed'");
    const writes = [
      ...f.replace(/--.*$/gm, '').matchAll(/(UPDATE|INSERT INTO|DELETE FROM) public\.(\w+)/g),
    ].map((m) => m[2]);
    expect(writes.sort()).toEqual(['cash_cluster_events', 'lightning_integrity_signal']);
  });
});

describe('the sweep', () => {
  const S = () => fn('fn_lightning_alert_sweep').replace(/--.*$/gm, '');
  it('takes one pass at a time and isolates every check', () => {
    expect(S()).toContain("pg_try_advisory_xact_lock(hashtext('lightning-alert-sweep'))");
    expect(count(S(), /EXCEPTION WHEN OTHERS/g)).toBeGreaterThanOrEqual(10);
    for (const c of [
      'frozen',
      'stuck_conversion',
      'drive_error',
      'reaper_failure',
      'integrity_spike',
      'latency_regression',
    ])
      expect(S(), c).toContain(`'${c}'`);
  });
  it('pages through the estate path with stable keys and the freeze sources', () => {
    const raise = fn('fn_lightning_alert_raise');
    expect(raise).toContain("'lightning_alerts'");
    expect(raise).toContain('public.fn_raise_server_financial_alert(');
    for (const k of [
      "'lightning_cluster_frozen:'",
      "'lightning_stuck_conversion:'",
      "'lightning_drive_error:'",
      "'lightning_reaper_failure:'",
      "'lightning_integrity_spike:'",
      "'lightning_latency_regression:'",
    ])
      expect(S(), k).toContain(k);
    expect(S()).toContain("('lightning_formation', 'lightning_settlement', 'lightning_alerts')");
    for (const e of [
      "'lightning_drive_error'",
      "'lightning_pending_on_reap_failed'",
      "'lightning_pending_off_reap_failed'",
      "'cluster_frozen'",
    ])
      expect(S(), e).toContain(e);
  });
  it('writes no Cluster state, only pages, its own cadence and latency retention', () => {
    const writes = [...S().matchAll(/(UPDATE|INSERT INTO|DELETE FROM) public\.(\w+)/g)].map(
      (m) => m[2]
    );
    expect([...new Set(writes)].sort()).toEqual([
      'financial_alerts',
      'lightning_alert_sweep_state',
      'lightning_latency_window',
    ]);
  });
  it('is the integrity scan caller, hourly, for Clusters with integrity_telemetry, never frozen ones', () => {
    expect(S()).toContain('public.fn_lightning_integrity_scan(c.id, NULL, NULL)');
    expect(S()).toContain("date_trunc('hour', v_now)");
    expect(S()).toContain("'integrity_telemetry'");
    expect(S()).toContain("cg.cluster_mode IS DISTINCT FROM 'frozen'");
  });
  it('is scheduled every minute through the managed cron API and never from the tick', () => {
    expect(SQL).toContain("PERFORM cron.schedule('lightning-alert-sweep-1m', '* * * * *', c_cmd);");
    expect(SQL).toContain(
      'PERFORM cron.alter_job(v_job.jobid, schedule := c_sched, command := c_cmd, active := true);'
    );
    expect(SQL).toContain(
      "c_cmd  constant text := $cmd$SET statement_timeout = '50s'; SELECT public.fn_lightning_alert_sweep();$cmd$;"
    );
    expect(SQL).toMatch(/^-- periodic-work: \S/m);
    expect(CODE).not.toMatch(/cron\.unschedule/);
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_clusters_tick_all/);
    expect(S()).not.toMatch(/fn_cash_clusters_tick_all/);
  });
});

describe('the one substitution is asserted', () => {
  it('the rewriter counts each anchor, refuses a blind replace and reads back the grants', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION pg_temp.lp12ops_rewrite(');
    expect(SQL).toContain('refusing to substitute blind');
    expect(SQL).toContain('did not keep who may execute');
    expect(count(SQL, /SELECT pg_temp\.lp12ops_rewrite\(/g)).toBe(1);
    expect(SQL).toContain(
      "SELECT pg_temp.lp12ops_rewrite(\n  'public.fn_lightning_config(uuid)',\n  '''latency_window_ms''',"
    );
  });
  it('the configuration gains the Phase 12 keys in a third object, each clamped like every other', () => {
    expect(SQL).toContain(
      "    'invalid', v_inv)\n    -- LIGHTNING PHASE 12 (20261009144343): a third object"
    );
    for (const k of [
      'latency_telemetry',
      'latency_window_ms',
      'alert_window_ms',
      'alert_stuck_conversion_ms',
      'alert_drive_errors',
      'alert_reaper_failures',
      'alert_integrity_high_signals',
      'alert_latency_windows',
      'alert_latency_min_samples',
      'alert_latency_p95_ms',
    ])
      expect(SQL, k).toContain(`    '${k}', v_`);
    expect(SQL).toContain('v_lt_on := true;');
    expect(SQL).toContain("'latency_window_ms', 60000, 10000, 600000, true");
    expect(SQL).toContain("'alert_window_ms', 600000, 60000, 86400000, true");
    expect(SQL).toContain("'alert_stuck_conversion_ms', 1200000, 60000, 86400000, true");
    expect(SQL).toContain("'alert_latency_windows', 3, 2, 60, true");
  });
});

describe('law 10.5, no matchmaking manipulation, and the live proofs', () => {
  it('no body reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
  });
  it('a live proof pins that no seating-path body names the latency ledger, the alerts or the doors', () => {
    expect(SQL).toContain(
      "!~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_'"
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
  it('declares fourteen live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(14);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through Phase 11 and the migration under test on port 55560', () => {
    expect(HARNESS).toContain('LIGHTNING_P12_PORT:-55560');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain(
      '20261008161509_lightning_phase_11_integrity_telemetry_and_the_shadow_matche'
    );
    expect(HARNESS).toContain('PASS: Lightning Phase 12');
    expect(HARNESS).toContain('if [ "$oks" != 18 ]; then');
  });
  it('CI runs the harness on shard 1 after the Phase 11 step', () => {
    const p11 = CI.indexOf('test-lightning-phase11-integrity-shadow.sh');
    const p12 = CI.indexOf('test-lightning-phase12-operator-alerts.sh');
    expect(p11).toBeGreaterThan(0);
    expect(p12).toBeGreaterThan(p11);
    const step = CI.slice(CI.lastIndexOf('- name:', p12), p12);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises exactly the two tables and the thirteen functions', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...BROWSER, ...SERVICE].sort());
    expect([...FRAGMENT.tables].sort()).toEqual([...TABLES].sort());
  });
  it('the changelog names the doors, the tables, the keys and the file, uses title case headings and no em dash', () => {
    for (const p of [
      ...BROWSER,
      'fn_lightning_latency_report',
      'fn_lightning_alert_sweep',
      ...TABLES,
      'latency_telemetry',
      'latency_window_ms',
      'lightning-alert-sweep-1m',
      'lightning_alerts',
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
