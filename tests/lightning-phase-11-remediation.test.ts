/**
 * LIGHTNING PHASE 11 REMEDIATION (THE DATABASE HALF): INTEGRITY SIGNALS ARE
 * FAIR, A FINDING IS ONE ROW THAT EXTENDS, AND THE SHADOW IS SCORED LIKE FOR
 * LIKE.
 *
 * A static reading of ONE migration, 20261009181945, and of its harness
 * scripts/dev/test-lightning-phase11-remediation.sh. The harness reproduces
 * every finding on the production bodies and proves it gone against a running
 * catalogue and estate; this file proves what a catalogue cannot see: the
 * transaction shape, that every change is an asserted substitution into a
 * body production carries (and into which ones), the thresholds and keys the
 * app and the operators read, that the new store is closed, that nothing in
 * the seating path can read any of it, that horses are never singled out, and
 * that the harness keeps reproducing each finding before proving it fixed.
 *
 * LIGHTNING_P11R_MIGRATION and LIGHTNING_P11R_HARNESS override the files
 * under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261009181945_lightning_phase_11_remediation_integrity_signals_are_fair_an.sql';
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SQL = fs.readFileSync(
  process.env.LIGHTNING_P11R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE),
  'utf8'
);
const HARNESS = fs.readFileSync(
  process.env.LIGHTNING_P11R_HARNESS ??
    path.join(ROOT, 'scripts', 'dev', 'test-lightning-phase11-remediation.sh'),
  'utf8'
);
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-11-remediation.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase11-remediation.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** The six bodies the migration substitutes into, and nothing else. */
const REWRITTEN = [
  'fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)',
  'fn_lightning_integrity_report(uuid,jsonb,timestamp with time zone)',
  'fn_lightning_shadow_record(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb)',
  'fn_lightning_shadow_report(uuid,timestamp with time zone,timestamp with time zone)',
  'fn_lightning_alert_sweep(timestamp with time zone)',
  'fn_lightning_operator_cluster(uuid,timestamp with time zone,timestamp with time zone)',
];

/** One rewrite call: its anchors, replacements and counts. */
function rewrite(sig: string): { from: string[]; to: string[]; counts: number[] } {
  const start = SQL.indexOf(`SELECT pg_temp.lp11r_rewrite(\n  'public.${sig}'`);
  expect(start, sig).toBeGreaterThan(0);
  const end = SQL.indexOf(']);\n', start);
  const call = SQL.slice(start, end + 3);
  const from = [...call.matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
  const to = [...call.matchAll(/\$b\$([\s\S]*?)\$b\$/g)].map((m) => m[1]);
  const counts = (call.match(/ARRAY\[([0-9, ]+)\]\);$/)?.[1] ?? '')
    .split(',')
    .map((x) => Number(x.trim()));
  return { from, to, counts };
}

describe('the migration is one guarded transaction of asserted substitutions', () => {
  it('is one BEGIN and one COMMIT with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '3s';/m);
  });
  it('substitutes into exactly the six bodies, each anchor counted, each with a marker', () => {
    const targets = [...CODE.matchAll(/SELECT pg_temp\.lp11r_rewrite\(\s*'public\.([^']+)'/g)].map(
      (m) => m[1]
    );
    expect(targets.sort()).toEqual([...REWRITTEN].sort());
    expect(CODE).toContain('refusing to substitute blind');
    expect(CODE).toContain('did not keep who may execute it');
    for (const sig of REWRITTEN) {
      const r = rewrite(sig);
      expect(r.from.length, sig).toBeGreaterThan(0);
      expect(r.from.length, sig).toBe(r.to.length);
      expect(r.counts.length, sig).toBe(r.from.length);
    }
    expect(rewrite(REWRITTEN[0]).from.length).toBe(20);
  });
  it('creates no function, no foreign key and no fn_lightning_config key', () => {
    expect(CODE).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\./);
    expect(CODE).not.toMatch(/REFERENCES/);
    expect(CODE).not.toContain("'public.fn_lightning_config(uuid)'");
    expect(CODE).not.toMatch(/DROP (FUNCTION|TABLE|INDEX)/);
  });
  it('never touches a seating, settlement or legality body', () => {
    for (const f of [
      'fn_lightning_player_legality',
      'fn_lightning_match',
      'fn_lightning_form_hand',
      'fn_lightning_settle_hand',
      'fn_cash_clusters_tick_all',
      'fn_lightning_presence_report',
    ])
      expect(CODE, f).not.toContain(`lp11r_rewrite(\n  'public.${f}`);
  });
});

describe('finding 1: only player-initiated joins and leaves are compared', () => {
  const r = rewrite(REWRITTEN[0]);
  const to = r.to.join('\n');
  it('an entry near an epoch start is the system, only Stop Playing and standing up are the player', () => {
    expect(to).toContain('FROM public.cash_cluster_epoch ce');
    expect(to).toContain(
      "coalesce(ps.exit_reason IN ('stop_playing', 'anchor_seat_left'), false) AS own_exit"
    );
    expect(to).toContain('AND a.own_entry AND b.own_entry AND a.own_exit AND b.own_exit');
    expect(to).toContain("'player_initiated_only', true");
  });
});

describe('finding 2: pairing is judged against co-presence', () => {
  const to = rewrite(REWRITTEN[0]).to.join('\n');
  it('the pool size at each hand comes from one ordered sweep and weights each hand', () => {
    expect(to).toContain('pres AS MATERIALIZED');
    expect(to).toContain('sum(e.d) OVER (ORDER BY e.t, e.k ROWS UNBOUNDED PRECEDING) AS present');
    expect(to).toContain('(sz.n - 1)::numeric / GREATEST(GREATEST(pl.present, sz.n) - 1, 1) AS w');
    expect(to).toContain('sum(hw.w) / 2 AS expected');
    expect(to).toContain("'co_presence' ELSE 'whole_window' END AS expectation");
  });
});

describe('finding 5: chip flow needs significance and size', () => {
  const to = rewrite(REWRITTEN[0]).to.join('\n');
  it('30 opposed hands, z >= 4 and 50 big blinds gross', () => {
    expect(to).toContain('c_flow_min_hands constant integer := 30;');
    expect(to).toContain('c_flow_min_z     constant numeric := 4.0;');
    expect(to).toContain('c_flow_min_gross_bb constant numeric := 50;');
    expect(to).toContain(
      '(GREATEST(s.b_won, s.opposed - s.b_won) - s.opposed / 2.0) / sqrt(s.opposed / 4.0) >= c_flow_min_z'
    );
    expect(to).toContain('AND s.gross >= c_flow_min_gross_bb * coalesce(v_bb, 0)');
  });
});

describe('finding 6: one finding per subject extends; one mirror per finding', () => {
  const r = rewrite(REWRITTEN[0]);
  it('the exact-window upsert is gone from both statements and replaced by extend-or-insert', () => {
    expect(r.from.filter((a) => a.includes('DO UPDATE SET suspicion_score')).length).toBe(1);
    expect(r.counts[r.from.findIndex((a) => a.includes('DO UPDATE SET suspicion_score'))]).toBe(2);
    const to = r.to.join('\n');
    expect(to).not.toContain('DO UPDATE SET suspicion_score');
    expect(to).toContain('window_end = GREATEST(t.window_end, v_to)');
    expect(to).toContain('suspicion_score = GREATEST(t.suspicion_score, k.score)');
    expect(to).not.toMatch(/SET[^;]*\bstatus\s*=/);
  });
  it('overlapping runs serialize on one advisory lock per Cluster, in the scan and the report', () => {
    expect(SQL).toContain(
      "PERFORM pg_advisory_xact_lock(hashtext('lightning-integrity:' || v_cluster::text));"
    );
    expect(SQL).toContain(
      "PERFORM pg_advisory_xact_lock(hashtext('lightning-integrity:' || p_cluster_id::text));"
    );
  });
  it('the mirror is keyed by the finding and guarded by a partial unique index', () => {
    expect(CODE).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS ca_collusion_signals_one_per_lightning_finding'
    );
    expect(CODE).toContain("WHERE (detail ->> 'signal') = 'lightning_chip_flow';");
    expect(SQL).toContain(
      "ON CONFLICT ((detail ->> 'lightning_signal_id')) WHERE ((detail ->> 'signal') = 'lightning_chip_flow') DO NOTHING;"
    );
  });
  it('session length reads at most the session budget', () => {
    expect(SQL).toContain('LIMIT c_max_sessions) ps');
  });
  it('the sweep passes the previous full UTC day, once a UTC day', () => {
    const s = rewrite(REWRITTEN[4]).to.join('\n');
    expect(s).toContain(
      "public.fn_lightning_integrity_scan(c.id, date_trunc('day', v_now, 'UTC') - interval '1 day', date_trunc('day', v_now, 'UTC'));"
    );
    expect(s).toContain("st.last_at < date_trunc('day', v_now, 'UTC')");
  });
});

describe('finding 7: engine evidence is kept and judged over a day', () => {
  const to = rewrite(REWRITTEN[1]).to.join('\n');
  it('every window is stored and the decision aggregates 24 hours', () => {
    expect(to).toContain('INSERT INTO public.lightning_integrity_engine_window AS w');
    expect(to).toContain('c_agg_hours  constant integer := 24;');
    expect(to).toContain('ew.window_to > v_to - make_interval(hours => c_agg_hours)');
    expect(to).toContain('sum(ev.dn * (ev.sd * ev.sd + ev.mn * ev.mn))');
    expect(to).toContain('c_keep_hours constant integer := 48;');
  });
  it('the thresholds are the ones a single window used', () => {
    expect(SQL).not.toMatch(/c_lat_min_dec\s+constant integer := (?!50)/);
    expect(to).toContain('coalesce(a.decisions, 0) >= c_lat_min_dec');
    expect(to).toContain('coalesce(a.hands_together, 0) >= c_tc_min_hands');
  });
  it('the new store is closed to every role', () => {
    expect(CODE).toContain('CREATE TABLE IF NOT EXISTS public.lightning_integrity_engine_window (');
    expect(CODE).toContain(
      'ALTER TABLE public.lightning_integrity_engine_window ENABLE ROW LEVEL SECURITY;'
    );
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.lightning_integrity_engine_window FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CODE).toContain(
      'REVOKE ALL ON SEQUENCE public.lightning_integrity_engine_window_id_seq FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CODE).not.toMatch(
      /GRANT [A-Z, ]+ ON (TABLE )?public\.lightning_integrity_engine_window/
    );
  });
});

describe('findings 3, 10 and 12', () => {
  it('a component null on either side is null on both before scoring', () => {
    const to = rewrite(REWRITTEN[2]).to.join('\n');
    expect(to).toContain("CASE WHEN b.paired THEN v_live_c -> x.k ELSE 'null'::jsonb END");
    expect(to).toContain("AND jsonb_typeof(v_shadow_c -> x.k) = 'number' AS paired");
    expect(rewrite(REWRITTEN[2]).from.join('\n')).not.toContain('SAME_VERSION');
  });
  it('the report counts scored windows only and labels A/A', () => {
    const to = rewrite(REWRITTEN[3]).to.join('\n');
    expect(to).toContain(
      'count(*) FILTER (WHERE c.live_quality_score IS NOT NULL AND c.shadow_quality_score IS NOT NULL) AS n,'
    );
    expect(to).toContain("'aa_calibration', g.sv = g.lv || '-port',");
    expect(to).toContain("ORDER BY (g.sv = g.lv || '-port'), g.n DESC, g.lv, g.sv");
  });
  it('session length is capped at medium', () => {
    expect(SQL).toContain('c_long_max_score constant integer := 69;');
    expect(SQL).toContain(
      'LEAST(c_long_max_score, round(50 + (l.hours - c_long_hours) * 10 / 3))::integer'
    );
  });
});

describe('laws', () => {
  it('no substituted text reads is_horse or horse_id', () => {
    for (const sig of REWRITTEN)
      expect(rewrite(sig).to.join('\n'), sig).not.toMatch(/is_horse|horse_id/);
  });
  it('the seating path is pinned free of telemetry by a live proof', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(
      proofs.some(
        (p) =>
          p.includes(
            "!~ 'integrity|shadow_comparison|quality_|latency|lightning_alert|fn_lightning_operator_'"
          ) && p.includes('fn_lightning_player_legality')
      )
    ).toBe(true);
    expect(proofs.some((p) => p.includes('lightning_integrity_engine_window|'))).toBe(true);
  });
  it('declares twelve live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(12);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the harness, CI, fragment and changelog', () => {
  it('reproduces every finding on the production bodies before the file, then proves it gone', () => {
    expect(HARNESS).toContain('LIGHTNING_P11R_PORT:-55562');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain(
      '20261009151825_lightning_phase_12_load_chaos_the_pass_forms_under_surge.sql'
    );
    expect(HARNESS).toContain('CREATE FUNCTION harness.r_try(p_sql text)');
    for (const k of [
      'R01 REPRODUCED 1 AND 12',
      'R02 REPRODUCED 2',
      'R03 REPRODUCED 5',
      'R04 REPRODUCED 6',
      'R05 REPRODUCED 6 (THE CALLER)',
      'R06 REPRODUCED 7',
      'R07 REPRODUCED 3 AND 10',
      'R09 FIXED 1 AND 12',
      'R10 FIXED 2',
      'R11 FIXED 5',
      'R12 FIXED 6',
      'R13 OVERLAPPING RUNS',
      'R14 FIXED 6 (THE CALLER)',
      'R15 FIXED 7',
      'R16 FIXED 3 AND 10',
      'R19 RE-APPLIABLE',
    ])
      expect(HARNESS, k).toContain(`ok  ${k}`);
    expect(HARNESS).toContain('if [ "$oks" != 20 ]; then');
    expect(HARNESS).toContain('"$mine" "$fixture/reapply.sql"');
  });
  it('plants random pools of 18, 25 and 50 and runs two scans on two backends at once', () => {
    expect(HARNESS).toContain('FOREACH v_n IN ARRAY ARRAY[18, 25, 50] LOOP');
    expect(HARNESS).toContain('( "${PSQL[@]}" -f "$fixture/conc0.sql"');
    expect(HARNESS).toContain('( "${PSQL[@]}" -f "$fixture/conc1.sql"');
  });
  it('CI runs the harness on shard 1 after the Phase 12 load and chaos step', () => {
    const lc = CI.indexOf('test-lightning-phase12-load-chaos.sh');
    const me = CI.indexOf('test-lightning-phase11-remediation.sh');
    expect(lc).toBeGreaterThan(0);
    expect(me).toBeGreaterThan(lc);
    const step = CI.slice(CI.lastIndexOf('- name:', me), me);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises the one new table and no new function', () => {
    expect(FRAGMENT.tables).toEqual(['lightning_integrity_engine_window']);
    expect(FRAGMENT.functions).toEqual([]);
  });
  it('the changelog names the file and the findings, uses title case headings and no em dash', () => {
    for (const p of [
      FILE,
      'lightning_integrity_engine_window',
      'ca_collusion_signals_one_per_lightning_finding',
      'aa_calibration',
      'm1-port',
      'COORDINATED_JOIN_LEAVE',
      'PAIRING_CONCENTRATION',
      'CHIP_FLOW',
      'SESSION_LENGTH',
      'TIMING_CORRELATION',
      'DECISION_LATENCY',
      'fn_ca_integrity_detector_health',
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
