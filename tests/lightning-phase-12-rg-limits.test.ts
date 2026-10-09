/**
 * LIGHTNING PHASE 12 CARRY-FORWARD (THE DATABASE SIDE): RESPONSIBLE GAMING
 * LIMITS AT THE LIGHTNING DOOR, AND THE AUTO-REBUY STATUS LINE.
 *
 * A static reading of ONE migration, 20261009143757. The harness
 * scripts/dev/test-lightning-phase12-rg-limits.sh proves every claim against
 * a running catalogue and estate; this file proves what a catalogue cannot
 * see: the transaction shape, that both body changes are asserted
 * substitutions in place, that the reaper ends a responsible-gaming refusal
 * through the SAME helper and in the Stop Playing discipline, that pool
 * status answers the auto-rebuy contract from fn_lightning_config without
 * loosening it, that nothing feeds the matcher, and that horses are never
 * singled out.
 *
 * LIGHTNING_P12_RG_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261009143757_lightning_phase_12_responsible_gaming_limits_and_auto_rebuy_.sql';
const MIGRATION =
  process.env.LIGHTNING_P12_RG_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase12-rg-limits.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-09-lightning-phase-12-rg-limits.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase12-rg-limits.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** One asserted substitution, by the signature it rewrites. */
function rewrite(oldSig: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp12_rewrite(\n  '${oldSig}',`);
  expect(start, oldSig).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(']);', start) + 3);
}
/** The replacement half ($b$ blocks) of one substitution. */
const replacements = (r: string) => (r.match(/\$b\$[\s\S]*?\$b\$/g) ?? []).join('\n');

const REAPER =
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)';
const STATUS = 'public.fn_lightning_pool_status(uuid)';

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('creates and alters no table and grants or revokes nothing outside the rewriter', () => {
    expect(CODE).not.toMatch(/\b(CREATE|ALTER) TABLE\b/);
    expect(CODE).not.toMatch(/\bTRUNCATE\b|\bDELETE FROM\b/);
    const outside = CODE.slice(CODE.indexOf('$rw$;', CODE.indexOf('$rw$') + 4));
    expect(outside).not.toMatch(/\bGRANT\b|\bREVOKE\b/);
  });
  it('never touches the configuration reader, the tick or the operator and alert doors', () => {
    for (const f of [
      'fn_lightning_config',
      'fn_cash_clusters_tick_all',
      'fn_lightning_operator_',
      'fn_lightning_alert_sweep',
      'fn_lightning_latency_report',
      'fn_lightning_player_legality',
    ]) {
      expect(CODE, f).not.toMatch(new RegExp(`lp12_rewrite\\(\\s*'public\\.${f}`));
      expect(CODE, f).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${f}`));
    }
  });
});

describe('every substitution is asserted', () => {
  it('the rewriter reads production, counts each anchor, refuses a blind replace and reads back who may execute', () => {
    expect(SQL).toContain('pg_get_functiondef(p_old::regprocedure)');
    expect(SQL).toContain('refusing to substitute blind');
    expect(SQL).toContain("has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE')");
    expect(SQL).toContain('does not read back carrying');
  });
  it('rewrites exactly the reaper and pool status, each in place with every anchor counted once', () => {
    const sigs = [
      ...SQL.matchAll(/SELECT pg_temp\.lp12_rewrite\(\n {2}'([^']+)',\n {2}'([^']+)'/g),
    ];
    expect(sigs.map((m) => m[1])).toEqual([REAPER, STATUS]);
    for (const m of sigs) expect(m[2]).toBe(m[1]);
    expect(rewrite(REAPER)).toContain('ARRAY[1, 1, 1, 1, 1, 1, 1, 1, 1]);');
    expect(rewrite(STATUS)).toContain('ARRAY[1, 1, 1]);');
  });
});

describe('the reaper ends a responsible-gaming refusal like Stop Playing', () => {
  const r = replacements(rewrite(REAPER));
  it('asks the SAME helper every Lightning door asks, no second implementation', () => {
    expect(r).toContain(
      "public.fn_rg_require_not_excluded(ps.player_id) ->> 'ok')::boolean IS DISTINCT FROM true"
    );
    expect(r).not.toMatch(
      /self_excluded_until|cooling_off_until|daily_loss_limit|session_time_limit/
    );
    expect(r).toContain('OR rg.refused)');
  });
  it('names the distinct exit_reason, lets a standing stop keep its own, and never counts it as an expired disconnect', () => {
    expect(r).toMatch(
      /WHEN s\.stop_requested_at IS NOT NULL THEN 'stop_playing'\s+WHEN s\.rg_refused THEN 'rg_limit'\s+ELSE 'disconnect_expired' END/
    );
    expect(count(r, /WHEN s\.rg_refused THEN 'rg_limit'/g)).toBe(2);
    expect(r).toContain("- 'stopped' - 'rg_limit' ORDER BY");
    expect(r).toContain("AND (x ->> 'rg_limit')::boolean IS NOT TRUE");
  });
  it('leaves the in-hand skip, the frozen skip, the clamp and the locks alone', () => {
    const anchors =
      rewrite(REAPER)
        .match(/\$a\$[\s\S]*?\$a\$/g)
        ?.join('\n') ?? '';
    for (const keep of [
      'fn_lightning_player_in_hand',
      'FOR UPDATE OF ps SKIP LOCKED',
      "fz.cluster_mode = 'frozen'",
      'LIMIT LEAST',
    ])
      expect(anchors + r, keep).not.toContain(keep);
    expect(r).not.toMatch(/UPDATE public\.table_seats|cash_player_session|atomic_table/);
  });
});

describe('pool status answers the auto-rebuy status', () => {
  const r = replacements(rewrite(STATUS));
  it('reads every setting from fn_lightning_config and usage from the caller own open session', () => {
    for (const k of [
      'enabled',
      'trigger',
      'threshold_bb',
      'threshold_pct',
      'target',
      'max_count',
      'session_cap',
    ])
      expect(r, k).toContain(`'${k}', v_cfg -> 'auto_rebuy_${k}'`);
    expect(r).toContain("'used_count', to_jsonb(v_ar_used)");
    expect(r).toContain("'used_total', to_jsonb(v_ar_total)");
    expect(r).toContain('ps.player_id = v_uid AND ps.exited_at IS NULL');
  });
  it('keeps the four existing keys, never answers cluster_mode and writes nothing', () => {
    expect(r).toContain("'multi_table_limit', v_cfg -> 'multi_table_limit',");
    expect(r).not.toMatch(
      /'cluster_mode'|INSERT INTO|UPDATE public|DELETE FROM|lightning_instance_id/
    );
  });
});

describe('law 10.5, the matcher pin and the live proofs', () => {
  const bodies = replacements(rewrite(REAPER)) + replacements(rewrite(STATUS));
  it('no body reads is_horse or horse_id', () => {
    expect(bodies).not.toMatch(/is_horse|horse_id/);
  });
  it('nothing the file writes into a body names integrity, shadow or quality data', () => {
    expect(bodies).not.toMatch(/integrity|shadow_comparison|quality_/);
  });
  it('declares eight live proofs, every one a single line, including the cash parity and the anti-manipulation pin', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(8);
    expect(
      proofs.some((p) => p.includes("'fn_cash_game_join'") && p.includes("'atomic_table_rebuy'"))
    ).toBe(true);
    expect(proofs.some((p) => p.includes("!~ 'integrity|shadow_comparison|quality_'"))).toBe(true);
    expect(
      proofs.some(
        (p) =>
          p.includes("NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')") &&
          p.includes("'public.fn_lightning_config(uuid)'::regprocedure")
      )
    ).toBe(true);
    expect(proofs.some((p) => p.includes("'is_horse|horse_id'"))).toBe(true);
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through Phase 11 and the migration under test on port 55560', () => {
    expect(HARNESS).toContain('LIGHTNING_P12_RG_PORT:-55560');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('20261008161509_lightning_phase_11_integrity_telemetry');
    expect(HARNESS).toContain('PASS: Lightning Phase 12 RG limits');
  });
  it('CI runs the harness on shard 1 after the Phase 11 step', () => {
    const p11 = CI.indexOf('test-lightning-phase11-integrity-shadow.sh');
    const p12 = CI.indexOf('test-lightning-phase12-rg-limits.sh');
    expect(p11).toBeGreaterThan(0);
    expect(p12).toBeGreaterThan(p11);
    const step = CI.slice(CI.lastIndexOf('- name:', p12), p12);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises the two rewritten doors and no table or column', () => {
    expect([...FRAGMENT.functions].sort()).toEqual(
      ['fn_lightning_pool_status', 'fn_lightning_reap_expired_disconnects'].sort()
    );
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.columns ?? {}).toEqual({});
  });
  it('the changelog names the contract, the gap and the file, uses title case headings and no em dash', () => {
    for (const p of [
      'rg_limit',
      'auto_rebuy',
      'used_count',
      'fn_rg_require_not_excluded',
      'daily_loss_limit',
      'session_time_limit_minutes',
      'fn_lightning_pool_status',
      FILE,
    ])
      expect(CHANGELOG, p).toContain(p);
    expect(CHANGELOG).not.toContain('—');
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      for (const w of h.replace(/^#+ /, '').split(/\s+/)) {
        if (
          /^[a-z]/.test(w) &&
          ![
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
          ].includes(w)
        )
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
