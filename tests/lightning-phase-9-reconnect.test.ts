/**
 * LIGHTNING PHASE 9 (SPECIFICATION PHASES 14 AND 15, THE DATABASE SIDE):
 * DISCONNECT / RECONNECT AND THE EVENT LEDGER / AUDIT / FORENSICS.
 *
 * A static reading of ONE migration, 20261008050805. The harness
 * scripts/dev/test-lightning-phase9-reconnect.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, the signatures and grants the engine and client are
 * built against, that every change to an existing body is an asserted
 * substitution, that the browser door asks who is calling and the service
 * doors do not, and that horses are never singled out.
 *
 * LIGHTNING_P9_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261008050805_lightning_phase_9_disconnect_reconnect_and_the_forensic_ledg.sql';
const MIGRATION =
  process.env.LIGHTNING_P9_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase9-reconnect.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-08-lightning-phase-9-reconnect.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase9-reconnect.json')
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

/** One asserted substitution, by the signature it rewrites. */
function rewrite(oldSig: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp9_rewrite(\n  '${oldSig}',`);
  expect(start, oldSig).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(']);', start) + 3);
}

/** The five functions this file creates new. */
const DOORS = [
  'fn_lightning_presence_report',
  'fn_lightning_reap_expired_disconnects',
  'fn_lightning_reconnect_state',
  'fn_lightning_cluster_forensics',
  'fn_lightning_hand_replay_check',
];
/** The three existing bodies it substitutes into. */
const REWRITTEN = [
  'public.fn_lightning_config(uuid)',
  'public.fn_cash_clusters_tick_all(jsonb)',
  'public.fn_cash_cluster_unfreeze(uuid,uuid,text)',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('alters only lightning_pool_session, creates no table and locks neither tables nor table_seats', () => {
    expect(
      CODE.match(/ALTER TABLE public\.\w+/g)?.every((m) => m.endsWith('lightning_pool_session'))
    ).toBe(true);
    expect(CODE).not.toMatch(/\bCREATE TABLE\b/);
    expect(CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(CODE).not.toMatch(/ALTER TABLE public\.(tables|table_seats)\b/);
    expect(CODE).not.toMatch(/ON public\.(tables|table_seats)\b/);
  });
  it('the column, constraint and index are guarded so the file re-applies', () => {
    expect(CODE).toMatch(/ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;/);
    expect(CODE).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_constraint[\s\S]+lightning_pool_session_disconnect_is_dated/
    );
    expect(CODE).toMatch(/CREATE INDEX IF NOT EXISTS lightning_pool_session_expiring_disconnects/);
  });
  it('the disconnect constraint says a disconnected session must be dated', () => {
    expect(CODE).toMatch(/CHECK \(state <> 'disconnected' OR disconnected_at IS NOT NULL\)/);
  });
});

describe('the presence door', () => {
  it('is service_role only: created, revoked from PUBLIC/anon/authenticated, granted to service_role', () => {
    const f = fn('fn_lightning_presence_report');
    expect(f).toContain('LANGUAGE plpgsql');
    expect(f).not.toContain('SECURITY DEFINER');
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_presence_report\([^)]*\) FROM PUBLIC, anon, authenticated;/
    );
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_presence_report\([^)]*\) TO service_role;/
    );
  });
  it('is idempotent and event-light: only an unstamped session stamps, only a stamped one clears, each guarded', () => {
    const f = fn('fn_lightning_presence_report');
    expect(f).toContain('disconnected_at = coalesce(s.disconnected_at, v_now)');
    expect(f).toMatch(/s\.disconnected_at IS NULL\s+AND s\.player_id = ANY/);
    expect(f).toMatch(/s\.disconnected_at IS NOT NULL\s+AND s\.player_id = ANY/);
    // One event per call per direction, guarded by whether anything changed.
    expect(f).toMatch(/IF v_down IS NOT NULL THEN\s+INSERT INTO public\.cash_cluster_events/);
    expect(f).toMatch(/IF v_up IS NOT NULL THEN\s+INSERT INTO public\.cash_cluster_events/);
    expect(count(f, /'player_disconnected'/g)).toBe(1);
    expect(count(f, /'player_reconnected'/g)).toBe(1);
  });
  it('flips only active<->disconnected, leaving every other state its own', () => {
    const f = fn('fn_lightning_presence_report');
    expect(f).toContain("CASE WHEN s.state = 'active' THEN 'disconnected' ELSE s.state END");
    expect(f).toContain("CASE WHEN s.state = 'disconnected' THEN 'active' ELSE s.state END");
  });
  it('clamps a future clock so a stamp is never born aged', () => {
    expect(fn('fn_lightning_presence_report')).toContain(
      'LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp())'
    );
  });
  it('a player in both lists ends connected: the disconnect excludes the reconnected set', () => {
    expect(fn('fn_lightning_presence_report')).toMatch(
      /AND NOT \(s\.player_id = ANY \(coalesce\(p_reconnected/
    );
  });
});

describe('the expiry reaper', () => {
  const f = () => fn('fn_lightning_reap_expired_disconnects');
  it('is service_role only and not a definer', () => {
    expect(f()).not.toContain('SECURITY DEFINER');
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_reap_expired_disconnects\([^)]*\) TO service_role;/
    );
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_reap_expired_disconnects\([^)]*\) FROM PUBLIC, anon, authenticated;/
    );
  });
  it('reaps only past the configured timeout, clock-guarded, bounded, SKIP LOCKED', () => {
    expect(f()).toContain('LEAST(coalesce(p_now, clock_timestamp()), clock_timestamp())');
    expect(f()).toContain("fn_lightning_config(ps.cluster_id) ->> 'disconnect_timeout_ms'");
    expect(f()).toContain('make_interval(secs => cfg.timeout_ms / 1000.0) <= p_now');
    expect(f()).toMatch(
      /LIMIT GREATEST\(1, coalesce\(p_limit, 200\)\)\s+FOR UPDATE OF ps SKIP LOCKED/
    );
  });
  it('releases nothing in-hand or reserved: a live hand or a live reservation is skipped, not exited', () => {
    expect(f()).toContain('public.fn_lightning_player_in_hand(s.player_id, s.cluster_id)');
    expect(f()).toMatch(/r\.state IN \('pending', 'committed'\)[\s\S]+'in_hand_or_reserved'/);
    expect(f()).toMatch(/v_skipped := v_skipped \|\|[\s\S]+CONTINUE;/);
  });
  it('exits as disconnect_expired with the pool stack, closes the slot, and says pool_player_left and player_expired', () => {
    expect(f()).toContain("exit_reason = 'disconnect_expired'");
    expect(f()).toContain("state = 'closed'");
    expect(f()).toContain('ending_stack = public.fn_lightning_pool_stack(ps.id)');
    expect(f()).toContain("close_reason = 'pool_session_exited'");
    expect(f()).toContain("'pool_player_left'");
    expect(f()).toContain("'player_expired'");
  });
  it('isolates each session in its own sub-block and emits one player_expired per Cluster after the loop', () => {
    expect(f()).toMatch(/BEGIN[\s\S]+EXCEPTION WHEN OTHERS THEN[\s\S]+v_errors := v_errors/);
    const body = f();
    expect(body.indexOf("'player_expired'")).toBeGreaterThan(body.indexOf('END LOOP;'));
    expect(body).toMatch(/GROUP BY 1\s+LOOP[\s\S]+'player_expired'/);
  });
});

describe('the reconnect snapshot', () => {
  const f = () => fn('fn_lightning_reconnect_state');
  it('is the only browser door: SECURITY DEFINER, auth.uid() scoped, authenticated and service_role', () => {
    expect(f()).toContain('SECURITY DEFINER');
    expect(f()).toContain('v_uid := auth.uid();');
    expect(f()).toMatch(/IF v_uid IS NULL OR p_cluster_id IS NULL THEN\s+RETURN NULL;/);
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_reconnect_state\(uuid\) FROM PUBLIC, anon;/
    );
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_reconnect_state\(uuid\) TO authenticated, service_role;/
    );
  });
  it('returns the caller own session only: the pool session is filtered by auth.uid()', () => {
    expect(f()).toMatch(/s\.player_id = v_uid AND s\.exited_at IS NULL/);
  });
  it('carries no instance id and no raw cluster_mode, and joinable is the pool-status formula', () => {
    const b = fn('fn_lightning_reconnect_state')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(b).not.toMatch(/'instance_id'|'lightning_instance_id'/);
    expect(b).not.toMatch(/'cluster_mode'/);
    expect(b).toContain(
      "'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE)"
    );
    expect(b).toContain("'hand_id', v_hand");
    expect(b).toContain("'disconnected_at', ps.disconnected_at");
  });
});

describe('the forensic reader and the replay check are read-only and operators only', () => {
  it('the forensic window is bounded, read-only, service_role only', () => {
    const f = fn('fn_lightning_cluster_forensics');
    expect(f).not.toContain('SECURITY DEFINER');
    expect(f).toContain('LEAST(GREATEST(coalesce(p_limit, 500), 1), 2000)');
    const b = f
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(b).not.toMatch(/\bINSERT\b|\bUPDATE public\b|\bDELETE\b/);
    expect(count(f, /LIMIT v_limit\)/g)).toBe(5);
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_cluster_forensics\([^)]*\) TO service_role;/
    );
    expect(CODE).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_lightning_cluster_forensics\([^)]*\) FROM PUBLIC, anon, authenticated;/
    );
  });
  it('the replay check is read-only, service_role only, and names every defect clause', () => {
    const f = fn('fn_lightning_hand_replay_check');
    expect(f).not.toContain('SECURITY DEFINER');
    const b = f
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    expect(b).not.toMatch(/\bINSERT\b|\bUPDATE public\b|\bDELETE\b/);
    for (const code of [
      'hand_not_found',
      'hand_not_terminal',
      'participant_count',
      'version_missing',
      'stack_arithmetic',
      'conservation',
      'receipt_disagrees',
      'event_missing',
      'event_order',
    ])
      expect(f, code).toContain(`'${code}'`);
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_hand_replay_check\(uuid\) TO service_role;/
    );
  });
  it('the replay check verifies the stack identity, conservation against rake and BBJ, and the real event kinds in order', () => {
    const f = fn('fn_lightning_hand_replay_check');
    expect(f).toContain(
      'round(hp.stack_before + hp.net_result, 2) IS DISTINCT FROM round(hp.stack_after, 2)'
    );
    expect(f).toContain('v_sum + v_rake + v_bbj <> 0');
    expect(f).toContain("e.kind = 'hand_created'");
    expect(f).toContain("e.kind = 'hand_settled'");
    expect(f).toContain("e.kind = 'instance_destroyed'");
  });
});

describe('every substitution is asserted', () => {
  const rw = () =>
    SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION pg_temp.lp9_rewrite('), SQL.indexOf('$rw$;'));
  it('the rewriter reads production, counts each anchor, refuses a blind replace and reads back', () => {
    expect(rw()).toMatch(/v_src := pg_get_functiondef\(p_old::regprocedure\);/);
    expect(rw()).toMatch(/refusing to substitute blind/);
    expect(rw()).toMatch(/EXECUTE v_new;/);
    expect(rw()).toMatch(/does not read back carrying/);
  });
  it('rewrites exactly the three existing bodies, each in place (same signature)', () => {
    for (const sig of REWRITTEN) {
      const r = rewrite(sig);
      expect(r, sig).toContain(`'${sig}',\n  '${sig}',`);
    }
    expect(count(SQL, /SELECT pg_temp\.lp9_rewrite\(/g)).toBe(REWRITTEN.length);
  });
  it('the config gains disconnect_timeout_ms with the 30s..30min clamp, default 180000', () => {
    const r = rewrite('public.fn_lightning_config(uuid)');
    expect(r).toContain("'disconnect_timeout_ms', 180000, 30000, 1800000, true");
    expect(r).toContain("'disconnect_timeout_ms', v_disc,");
  });
  it('the tick runs the reaper beside the formation reaper, isolated the same way', () => {
    const r = rewrite('public.fn_cash_clusters_tick_all(jsonb)');
    expect(r).toContain('v_disconnects_reaped := public.fn_lightning_reap_expired_disconnects();');
    expect(r).toContain("'disconnects_reaped', v_disconnects_reaped,");
    expect(r).toMatch(/BEGIN\s+v_disconnects_reaped[\s\S]+EXCEPTION WHEN OTHERS THEN/);
  });
  it('the unfreeze records one pool_player_left per session it exits', () => {
    const r = rewrite('public.fn_cash_cluster_unfreeze(uuid,uuid,text)');
    expect(r).toContain("'pool_player_left'");
    expect(r).toContain('FOR r_exit IN');
    expect(r).toContain("'reason', 'cluster_unfrozen'");
  });
});

describe('versioning on conversions is verified, not rebuilt', () => {
  it('no cash_cluster_conversion column is added; a live proof pins the eight it must carry', () => {
    expect(CODE).not.toMatch(/ALTER TABLE public\.cash_cluster_conversion/);
    expect(SQL).toMatch(
      /table_name = 'cash_cluster_conversion' AND column_name IN \('from_mode', 'to_mode', 'trigger_population', 'on_threshold', 'off_threshold', 'epoch_before', 'epoch_after', 'conversion_request_id'\)/
    );
  });
});

describe('law 10.5 and the live proofs', () => {
  it('no body reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
    expect(SQL).toMatch(/~ 'is_horse\|horse_id'\)\)/);
  });
  it('declares thirteen live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(13);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through the migration under test on port 55556', () => {
    expect(HARNESS).toContain('LIGHTNING_P9_PORT:-55556');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('20261008043021_lightning_phase_7_and_8_review_fixes');
    expect(HARNESS).toContain('PASS: Lightning Phase 9');
  });
  it('CI runs the harness on shard 1 after the Phase 8 step', () => {
    const p8 = CI.indexOf('test-lightning-phase8-session.sh');
    const p9 = CI.indexOf('test-lightning-phase9-reconnect.sh');
    expect(p8).toBeGreaterThan(0);
    expect(p9).toBeGreaterThan(p8);
    const step = CI.slice(CI.lastIndexOf('- name:', p9), p9);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises exactly the five new functions and the one column', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...DOORS].sort());
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.columns).toEqual({ lightning_pool_session: ['disconnected_at'] });
  });
  it('the changelog names every door, uses title case headings and no em dash', () => {
    for (const p of [
      ...DOORS,
      'disconnect_timeout_ms',
      'disconnected_at',
      'pool_player_left',
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
          ].includes(w)
        )
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
