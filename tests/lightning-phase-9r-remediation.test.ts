/**
 * LIGHTNING PHASE 9 REMEDIATION (THE DATABASE SIDE): THE ENDED SESSION
 * ANSWERS, THE REAPER CLAMPS AND SKIPS THE FROZEN, AND PRESENCE SELF-HEALS.
 *
 * A static reading of ONE migration, 20261008142857. The harness
 * scripts/dev/test-lightning-phase9r-remediation.sh proves every claim
 * against a running catalogue and estate over the real chain through Phase
 * 10; this file proves what a catalogue cannot see: the transaction shape,
 * that no table is touched, that every change is an asserted substitution
 * into the body production carries, that the shared live-hand reader is left
 * alone for its other callers, and that horses are never singled out.
 *
 * LIGHTNING_P9R2_MIGRATION overrides the file under test, for mutation
 * testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261008142857_lightning_phase_9_remediation_the_ended_session_answers_the_.sql';
const MIGRATION =
  process.env.LIGHTNING_P9R2_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase9r-remediation.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-08-lightning-phase-9-remediation-db.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase9r-remediation.json')
);

/** The SQL with line comments removed. */
const CODE = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** One asserted substitution, by the signature it rewrites. */
function rewrite(oldSig: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp9r2_rewrite(\n  '${oldSig}',`);
  expect(start, oldSig).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(']);', start) + 3);
}

/** The four existing bodies it substitutes into (no body is created new). */
const REWRITTEN = [
  'public.fn_lightning_reconnect_state(uuid)',
  'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)',
  'public.fn_lightning_stop_playing(uuid)',
  'public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('touches no table at all: no CREATE, ALTER, LOCK or DROP TABLE', () => {
    expect(CODE).not.toMatch(/\bCREATE TABLE\b/);
    expect(CODE).not.toMatch(/\bALTER TABLE\b/);
    expect(CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(CODE).not.toMatch(/\bDROP TABLE\b/);
  });
  it('creates no function of its own but the pg_temp rewriter', () => {
    const creates = CODE.match(/CREATE OR REPLACE FUNCTION [\w.]+/g) ?? [];
    expect(creates).toEqual(['CREATE OR REPLACE FUNCTION pg_temp.lp9r2_rewrite']);
  });
});

describe('finding 1: the ended session answers', () => {
  const r = () => rewrite('public.fn_lightning_reconnect_state(uuid)');
  it('answers the most recent exited session with state ended and the row verbatim exit_reason', () => {
    expect(r()).toContain('s.exited_at IS NOT NULL');
    expect(r()).toContain('ORDER BY s.exited_at DESC, s.id');
    expect(r()).toContain("'state', 'ended'");
    expect(r()).toContain("'exit_reason', ps.exit_reason");
    expect(r()).toContain("'stack', ps.ending_stack");
  });
  it('points at the anchor seat only while the caller still owns it', () => {
    expect(r()).toContain(
      'ts.id = ps.anchor_seat_id AND ts.user_id = v_uid AND ts.left_at IS NULL'
    );
  });
  it('the open answer keeps its shape and gains exit_reason null, leaking nothing new', () => {
    expect(r()).toContain("'exit_reason', NULL::text");
    expect(r()).toContain("'stop_requested', ps.stop_requested_at IS NOT NULL");
    // The ended answer builds no instance id and no cluster_mode key: the
    // new body only ever emits the eleven caller-own keys.
    expect(r()).not.toMatch(/'instance_id',/);
    expect(r()).not.toMatch(/'cluster_mode',/);
    expect(r()).toContain('EXACTLY ELEVEN KEYS');
  });
});

describe('finding 4: the snapshot hand_id is a dealt hand id alone', () => {
  const r = () => rewrite('public.fn_lightning_reconnect_state(uuid)');
  it('scopes the snapshot key to an id lightning_hand carries, in reconnect_state alone', () => {
    expect(r()).toContain('lh.hand_id = v_hand');
    expect(r()).toContain("'hand_id', v_hand_id");
    // The file pins, as a live proof, that the open body no longer emits the
    // raw live-hand value in the key (only the lightning_hand-scoped one).
    expect(SQL).toMatch(/s !~ '''hand_id'', v_hand,'/);
  });
  it('leaves the shared fn_lightning_player_live_hand and its coalesce untouched for its other callers', () => {
    expect(CODE).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_lightning_player_live_hand/);
    expect(SQL).toMatch(/coalesce\(i\.hand_id, i\.id\)/);
    expect(SQL).toContain('load-bearing for its other callers');
  });
});

describe('finding 3: the reaper clamps above as well as below', () => {
  const r = () =>
    rewrite('public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)');
  it('replaces the one-sided floor with a floor and a ceiling of 2000', () => {
    expect(r()).toContain('LIMIT LEAST(GREATEST(1, coalesce(p_limit, 200)), 2000)');
  });
});

describe('finding 6: a frozen cluster is evidence', () => {
  it('the reaper skips a frozen cluster row', () => {
    const r = rewrite(
      'public.fn_lightning_reap_expired_disconnects(uuid,timestamp with time zone,integer)'
    );
    expect(r).toContain("fz.cluster_mode = 'frozen'");
    expect(r).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.cash_games fz/);
  });
  it('the stop door defers its idle exit for a freeze while still recording the mark', () => {
    const r = rewrite('public.fn_lightning_stop_playing(uuid)');
    expect(r).toContain('v_frozen  boolean := false');
    expect(r).toContain("fz.cluster_mode = 'frozen'");
    expect(r).toContain('IF NOT v_in_hand AND NOT v_frozen THEN');
  });
});

describe('finding 2: an action is a heartbeat', () => {
  it('the fold door heals the folder only, never on a frozen cluster, one event in the presence shape', () => {
    const r = rewrite('public.fn_lightning_fast_fold(uuid,uuid,uuid,text,numeric)');
    expect(r).toContain("'player_reconnected'");
    expect(r).toContain('disconnected_at = NULL');
    expect(r).toContain('s.exited_at IS NULL AND s.disconnected_at IS NOT NULL');
    expect(r).toContain("fz.cluster_mode = 'frozen'");
    expect(r).toMatch(/s\.player_id = p_player_id/);
  });
  it('the stop door heals the caller when the session stays open, never on a freeze', () => {
    const r = rewrite('public.fn_lightning_stop_playing(uuid)');
    expect(r).toContain("'player_reconnected'");
    expect(r).toContain('IF NOT v_frozen THEN');
    expect(r).toMatch(
      /ps\.id = s\.id AND ps\.exited_at IS NULL AND ps\.disconnected_at IS NOT NULL/
    );
  });
  it('does not touch any engine-spoken door', () => {
    expect(CODE).not.toMatch(/fn_lightning_presence_report/);
    expect(CODE).not.toMatch(/fn_lightning_reap_formations/);
    expect(CODE).not.toMatch(/fn_lightning_auto_rebuy/);
    expect(CODE).not.toMatch(/fn_lightning_settle_hand/);
  });
});

describe('every substitution is asserted and grant-preserving', () => {
  const rw = () =>
    SQL.slice(
      SQL.indexOf('CREATE OR REPLACE FUNCTION pg_temp.lp9r2_rewrite('),
      SQL.indexOf('$rw$;')
    );
  it('the rewriter reads production, counts each anchor, refuses a blind replace, carries the ACL and reads back', () => {
    expect(rw()).toMatch(/v_src := pg_get_functiondef\(p_old::regprocedure\);/);
    expect(rw()).toMatch(/refusing to substitute blind/);
    expect(rw()).toMatch(/did not keep who may execute/);
    expect(rw()).toMatch(/does not read back carrying/);
  });
  it('rewrites exactly the four existing bodies, each in place (same signature)', () => {
    for (const sig of REWRITTEN) {
      const r = rewrite(sig);
      expect(r, sig).toContain(`'${sig}',\n  '${sig}',`);
    }
    expect(count(SQL, /SELECT pg_temp\.lp9r2_rewrite\(/g)).toBe(REWRITTEN.length);
  });
  it('the read-back asserts who may execute per role for every touched door', () => {
    expect(CODE).toContain("has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    expect(CODE).toContain("NOT has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(CODE).toContain('LIGHTNING_P9R_DB_READBACK');
  });
});

describe('law 10.5 and the live proofs', () => {
  it('no body reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/\bis_horse\b|\bhorse_id\b/);
    expect(SQL).toMatch(/~ 'is_horse\|horse_id'\)\)/);
  });
  it('declares ten live proofs, every one a single line', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(10);
    for (const p of proofs) expect(p).not.toContain('\n');
  });
});

describe('the proof harness and CI', () => {
  it('the harness runs the real chain through the migration under test on port 55558', () => {
    expect(HARNESS).toContain('LIGHTNING_P9R2_PORT:-55558');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('20261008111425_lightning_phase_10_responsible_gaming');
    expect(HARNESS).toContain('PASS: Lightning Phase 9 remediation (DB)');
  });
  it('CI runs the harness on shard 1 after the Phase 10 step', () => {
    const p10 = CI.indexOf('test-lightning-phase10-rg-rebuy.sh');
    const p9r = CI.indexOf('test-lightning-phase9r-remediation.sh');
    expect(p10).toBeGreaterThan(0);
    expect(p9r).toBeGreaterThan(p10);
    const step = CI.slice(CI.lastIndexOf('- name:', p9r), p9r);
    expect(step).toContain('if: matrix.shard == 1');
    expect(step).toContain('PG_BIN: /usr/lib/postgresql/17/bin');
  });
  it('the schema manifest fragment promises no new table, function or column (every change is a body substitution)', () => {
    expect(FRAGMENT.functions).toEqual([]);
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.columns).toEqual({});
  });
  it('the changelog names the findings, the touched doors and the file, title case and no em dash', () => {
    for (const p of [
      'fn_lightning_reconnect_state',
      'fn_lightning_reap_expired_disconnects',
      'fn_lightning_fast_fold',
      'fn_lightning_stop_playing',
      'disconnect_expired',
      'stop_playing',
      'player_reconnected',
      'cluster_unfrozen',
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
            'through',
            'with',
          ].includes(w)
        )
          throw new Error(`heading word not in title case: ${w} in ${h}`);
      }
    }
  });
});
