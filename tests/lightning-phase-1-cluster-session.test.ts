/**
 * LIGHTNING 2.0 PHASE 1 - CASH SESSION / CLUSTER INTEGRATION
 *
 * Phase 1's whole job is to give the existing continuous cash session a
 * durable pointer to its Cluster, and to give the Cluster the authoritative
 * Lightning mode the specification's state machine needs - without changing
 * one byte of runtime behaviour.
 *
 * The behavioural proof runs against a real PostgreSQL 17 in
 * scripts/dev/test-lightning-phase1-cluster-session.sh. This file pins the
 * things that are only visible in the source, and that a later phase could
 * quietly undo:
 *
 *   1. the mode did NOT get parked in cash_games.state, which
 *      fn_cash_cluster_tick rewrites from occupancy every five seconds;
 *   2. the session was NOT flipped to scope_type='cluster', which would make
 *      it invisible to both close triggers and let it outlive its seat;
 *   3. the hot tick path was not touched at all;
 *   4. no matcher, no threshold, no conversion arrived early.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql'
);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const FRAGMENT = path.join(
  ROOT,
  'scripts',
  'ci',
  'schema-manifest.d',
  'lightning-phase1-cluster-session.json'
);
const HARNESS = path.join(ROOT, 'scripts', 'dev', 'test-lightning-phase1-cluster-session.sh');

/** The SQL with comments stripped, so a pin cannot be satisfied by prose. */
const CODE = SQL.replace(/--[^\n]*/g, '');

describe('Lightning Phase 1: the cluster state machine has its own column', () => {
  it('adds cluster_mode, lightning_enabled and cluster_epoch to cash_games', () => {
    expect(CODE).toMatch(
      /ALTER TABLE public\.cash_games\s+ADD COLUMN IF NOT EXISTS cluster_mode text NOT NULL DEFAULT 'must_move';/
    );
    expect(CODE).toMatch(
      /ALTER TABLE public\.cash_games\s+ADD COLUMN IF NOT EXISTS lightning_enabled boolean NOT NULL DEFAULT false;/
    );
    expect(CODE).toMatch(
      /ALTER TABLE public\.cash_games\s+ADD COLUMN IF NOT EXISTS cluster_epoch integer NOT NULL DEFAULT 0;/
    );
  });

  it('declares one ADD COLUMN per ALTER TABLE, because the applied-check anchors them that way', () => {
    // scripts/ci/check-migrations-applied.mjs pairs each added column with its
    // own ALTER TABLE. A comma-separated list would declare only the first,
    // and the other two would reach production undeclared.
    //
    // Counted on ADD COLUMN, not on ADD COLUMN IF NOT EXISTS, because the gate
    // makes IF NOT EXISTS optional in its own regex. Anchoring on the longer
    // phrase left a hole: a mixed statement such as
    //   ALTER TABLE public.cash_games ADD COLUMN IF NOT EXISTS a text,
    //     ADD COLUMN b boolean;
    // scored added=1, alters=1 and passed, while the gate declared only `a`
    // and `b` reached production undeclared - the exact failure this pins.
    const added = [...CODE.matchAll(/ADD\s+COLUMN\b/gi)];
    const alters = [...CODE.matchAll(/ALTER TABLE public\.\w+\s+ADD\s+COLUMN\b/gi)];
    expect(alters.length).toBe(added.length);
  });

  it('carries every one of the ten Cluster states, under a NAMED constraint', () => {
    expect(CODE).toContain('CONSTRAINT cash_games_cluster_mode_check');
    for (const state of [
      'created',
      'opening',
      'must_move',
      'pending_on',
      'lightning',
      'pending_off',
      'draining',
      'paused',
      'frozen',
      'dead',
    ]) {
      expect(CODE).toContain(`'${state}'`);
    }
  });

  it('defaults every existing cluster to exactly what it already is', () => {
    expect(CODE).toContain("DEFAULT 'must_move'");
    expect(CODE).toContain('DEFAULT false');
    expect(CODE).toContain('DEFAULT 0');
  });

  it('does NOT widen cash_games.state, which the tick derives from occupancy', () => {
    // fn_cash_cluster_tick section 7 recomputes state on every pass and writes
    // it back unconditionally. A mode parked there dies in five seconds.
    expect(CODE).not.toMatch(/cash_games_state_check/);
    expect(CODE).not.toMatch(
      /ALTER TABLE public\.cash_games[\s\S]{0,120}?\bstate\b\s+(?:text|SET|DROP|TYPE)/
    );
  });
});

describe('Lightning Phase 1: the session learns its cluster without changing scope', () => {
  it('adds a nullable cluster_id to cash_player_session', () => {
    expect(CODE).toMatch(
      /ALTER TABLE public\.cash_player_session\s+ADD COLUMN IF NOT EXISTS cluster_id uuid;/
    );
    expect(CODE).not.toMatch(/cluster_id uuid NOT NULL/);
  });

  it('never flips a session to scope_type=cluster', () => {
    // A cluster-scoped row is invisible to every scope_type='table' reader,
    // including BOTH close triggers, so it would outlive its seat - the exact
    // leak 20260910011838 and 20260910012522 closed.
    expect(CODE).not.toMatch(/scope_type\s*=\s*'cluster'/);
    expect(CODE).not.toMatch(/SET\s+scope_type/i);
  });

  it('keeps the seat as the authority: scope_id and table_id still the table', () => {
    expect(CODE).toMatch(/'table', p_table_id, p_table_id, v_t\.cluster_id/);
  });

  it('backfills open and closed sessions from the table they sit at, touching nothing else', () => {
    expect(CODE).toMatch(/UPDATE public\.cash_player_session s\s+SET cluster_id = t\.cluster_id/);
    // The backfill sets cluster_id and nothing else. No money, no clocks.
    const backfill = CODE.slice(CODE.indexOf('UPDATE public.cash_player_session s'));
    const stmt = backfill.slice(0, backfill.indexOf(';') + 1);
    for (const forbidden of [
      'baseline',
      'closed_at',
      'stay_remaining_ms',
      'stay_running',
      'opened_at',
      'rejoin_window_ms',
    ]) {
      expect(stmt).not.toContain(forbidden);
    }
  });

  it('has a WHERE clause, so check-unqualified-writes stays green', () => {
    const backfill = CODE.slice(CODE.indexOf('UPDATE public.cash_player_session s'));
    expect(backfill.slice(0, backfill.indexOf(';'))).toMatch(/\bWHERE\b/);
  });
});

describe('Lightning Phase 1: fn_cash_session_open keeps its contract', () => {
  it('preserves the three-argument positional signature atomic_table_buyin calls', () => {
    expect(CODE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_cash_session_open(p_user_id uuid, p_table_id uuid, p_buy_in numeric)'
    );
  });

  it('adds cluster_id to the INSERT column list and nothing else', () => {
    expect(CODE).toMatch(/scope_type, scope_id, table_id, cluster_id, variant/);
  });

  it('keeps ON CONFLICT DO NOTHING, so a colliding re-open never rewrites a live row', () => {
    expect(CODE).toContain(
      'ON CONFLICT (player_id, scope_type, scope_id) WHERE closed_at IS NULL DO NOTHING'
    );
  });

  it('restates its grants, because the definer-authorization gate models the file', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_session_open(uuid, uuid, numeric) TO service_role;'
    );
  });
});

describe('Lightning Phase 1: the authoritative reader', () => {
  it('creates fn_cash_cluster_lightning_state as a STABLE definer, service_role only', () => {
    expect(CODE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)'
    );
    expect(CODE).toMatch(/fn_cash_cluster_lightning_state[\s\S]{0,200}?STABLE/);
    expect(CODE).toContain(
      'REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;'
    );
    expect(CODE).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;'
    );
  });

  it('reports the mode, the epoch and the enable flag from persistent state', () => {
    for (const key of ['cluster_mode', 'cluster_epoch', 'lightning_enabled']) {
      expect(CODE).toContain(`'${key}'`);
    }
  });

  it('does not pretend to be the live eligible population, which is Phase 4', () => {
    // Pinned on the reader's BODY, not on the comment that explains it. The
    // old assertion matched a `--` comment, so deleting that comment failed
    // the test while rewriting the function to actually approximate Phase 4's
    // predicate passed it. Phase 4 owns eligibility - watchers, waitlist-only
    // users, expired disconnects - and centralises it there. Phase 1 counts
    // bound sessions and knows none of that vocabulary.
    expect(CODE).toContain('open_cluster_sessions');
    expect(CODE).not.toMatch(/eligible|watcher|waitlist|disconnect/i);
  });
});

describe('Lightning Phase 1: the phase boundary holds', () => {
  it('leaves the hot five-second tick path completely alone', () => {
    // What this proves, and what it does not. Of the five names only
    // fn_cash_cluster_tick appears in the migration at all, and it appears
    // solely inside a COMMENT ON documentation string, never as a statement
    // target. The other four do not appear anywhere, so those four assertions
    // are weak - true of almost any SQL file - and are kept as tripwires for a
    // later phase that starts editing the tick path in THIS file. The verb set
    // includes GRANT and REVOKE as well as CREATE/ALTER/DROP, so a migration
    // that only re-permissioned one of these functions is caught too.
    for (const untouched of [
      'fn_cash_cluster_tick',
      'fn_cash_clusters_tick_all',
      'fn_cash_clusters_to_tick',
      'fn_cash_cluster_open_table',
      'fn_cash_game_create',
    ]) {
      expect(CODE).not.toMatch(
        new RegExp(`(?:CREATE|ALTER|DROP|GRANT|REVOKE)[\\s\\S]{0,60}?${untouched}\\b`)
      );
    }
  });

  it('ships no matcher, no threshold and no conversion', () => {
    // Phases 4, 5 and 6. Phase 1 is "no matcher yet".
    // Only tokens that could genuinely appear. Three earlier entries could
    // not fail by construction and were removed: "pending_on's" (an
    // apostrophe-possessive; in the CHECK list 'pending_on' is followed by
    // `',`), 'ON threshold' (a two-word English phrase), and 'lightning_pool'
    // (an invented identifier).
    for (const tooEarly of ['matcher', 'instance_id', 'reservation']) {
      expect(CODE.toLowerCase()).not.toContain(tooEarly.toLowerCase());
    }
    // The concept, not three digit strings. The old /\b18\b|\b27\b|\b12\b/
    // proxy also matched numeric(12,2), varchar(12), interval '12 hours' and
    // LIMIT 12 - all legitimate future edits, none a Lightning threshold - and
    // said nothing about 10, 2 or 5, which are present and unforbidden.
    //
    // Pinned on the executable statements: a COMMENT ON documentation string
    // is allowed to say which later phase owns conversion, and two of them do.
    const executable = CODE.replace(/COMMENT\s+ON[\s\S]*?;\s*$/gim, '');
    expect(executable).not.toMatch(/thresholds?|convert|conversion/i);
  });

  it('is a single transaction, as the production DDL policy requires', () => {
    expect((CODE.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((CODE.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    expect(CODE.indexOf('BEGIN;')).toBeLessThan(CODE.indexOf('COMMIT;'));
  });

  it('declares its own live proofs, as every migration from 20260920 must', () => {
    const proofs = [...SQL.matchAll(/--\s*@live-proof:\s*(.+?)\s*$/gim)].map((m) => m[1]);
    expect(proofs.length).toBeGreaterThanOrEqual(4);
    for (const p of proofs) expect(p).not.toContain(';');
  });

  it('adds no foreign key onto a hot relation', () => {
    expect(CODE).not.toMatch(/REFERENCES\s+public\.(tables|cash_games)/);
  });

  it('declares its new objects to the schema manifest', () => {
    const frag = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8'));
    expect(frag.functions).toContain('fn_cash_cluster_lightning_state');
    expect(frag.columns.cash_games.sort()).toEqual([
      'cluster_epoch',
      'cluster_mode',
      'lightning_enabled',
    ]);
    expect(frag.columns.cash_player_session).toEqual(['cluster_id']);
    expect(frag.tables).toBeUndefined();
  });

  it('actually runs that harness in CI, because a test file is not enforcement', () => {
    // Hardening standard 9: "Required checks must actually execute; test-file
    // existence is not enforcement." The accounting job names every
    // scripts/dev/test-*.sh explicitly - there is no glob - so a harness that
    // is not listed there never runs, and nothing would say so.
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('bash scripts/dev/test-lightning-phase1-cluster-session.sh');
  });

  it('is qualified by a real PostgreSQL harness, not by mocks', () => {
    expect(fs.existsSync(HARNESS)).toBe(true);
    const sh = fs.readFileSync(HARNESS, 'utf8');
    expect(sh).toContain('initdb');
    expect(sh).toContain('20260920172736_lightning_phase_1_the_cash_session_knows_its_cluster.sql');
  });

  it('has the harness assert the new index exists, not just the columns', () => {
    // cash_player_session_open_by_cluster is what keeps every open-by-cluster
    // read off a sequential scan of a hot table. A migration that quietly lost
    // it would still pass every column and function check above.
    const sh = fs.readFileSync(HARNESS, 'utf8');
    expect(sh).toContain('cash_player_session_open_by_cluster');
  });
});
