/**
 * LIGHTNING PHASE 8 (SPECIFICATION PHASES 11, 12 AND 13, THE DATABASE SIDE):
 * MULTI-TABLE LIMITS PER PLATFORM, SESSION STATISTICS, POOL STATUS, THE
 * SESSION SUMMARY AND RECENT HANDS.
 *
 * A static reading of ONE migration, 20261007212735. The harness
 * scripts/dev/test-lightning-phase8-session.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, the contract the engine and client are built
 * against, that every change to an existing body is an asserted substitution,
 * that the browser doors ask who is calling and write nothing, and that
 * horses are never singled out.
 *
 * LIGHTNING_P8_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql';
const MIGRATION =
  process.env.LIGHTNING_P8_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase8-session.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-07-lightning-phase-8-session.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase8-session.json')
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
  const end = SQL.indexOf('$function$;', start);
  return SQL.slice(start, end);
}
/** The same function body with its comments removed. */
const fnCode = (name: string) =>
  fn(name)
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

/** One asserted substitution, by the signature it rewrites. */
function rewrite(oldSig: string): string {
  const start = SQL.indexOf(`SELECT pg_temp.lp8_rewrite(\n  '${oldSig}',`);
  expect(start, oldSig).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(']);', start) + 3);
}

const DOORS = [
  'fn_lightning_session_stats',
  'fn_lightning_session_summary',
  'fn_lightning_my_sessions',
  'fn_lightning_pool_status',
  'fn_lightning_recent_hands',
];
const RESIGNED: [string, string][] = [
  [
    'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[])',
    'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  ],
  [
    'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)',
    'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer,jsonb)',
  ],
  [
    'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text)',
    'public.fn_lightning_match(uuid,timestamp with time zone,uuid[],text,jsonb)',
  ],
  [
    'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)',
    'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  ],
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('alters only lightning_hand_player, creates no table and locks neither tables nor table_seats', () => {
    expect(CODE).not.toMatch(/\bCREATE TABLE\b/);
    expect(CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(
      CODE.match(/ALTER TABLE public\.\w+/g)?.every((m) => m.endsWith('lightning_hand_player'))
    ).toBe(true);
    expect(CODE).not.toMatch(/ALTER TABLE public\.(tables|table_seats)\b/);
    expect(CODE).not.toMatch(/ON public\.(tables|table_seats)\b/);
  });
  it('the columns, constraint and index are guarded so the file re-applies', () => {
    expect(CODE).toMatch(
      /ADD COLUMN IF NOT EXISTS waited_ms integer,\s+ADD COLUMN IF NOT EXISTS showed boolean;/
    );
    expect(CODE).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_constraint c[\s\S]+lightning_hand_player_wait_is_not_negative/
    );
    expect(CODE).toMatch(/CREATE INDEX IF NOT EXISTS lightning_hand_player_by_player/);
    expect(CODE).toMatch(
      /DROP TRIGGER IF EXISTS trg_hand_player_records_its_wait ON public\.lightning_hand_player;/
    );
  });
  it('the trigger name stays outside the trg_lightning_ family the earlier proofs list exactly', () => {
    expect(CODE).not.toMatch(/CREATE TRIGGER trg_lightning_/);
  });
});

describe('the multi-table limit is per platform', () => {
  it('fn_lightning_config answers {desktop, tablet, mobile}, defaults 4, 3, 2, each clamped to 1..8, and still reads the old scalar', () => {
    const r = rewrite('public.fn_lightning_config(uuid)');
    expect(r).toContain("'multi_table_limit', 4, 1, 24, true");
    expect(r).toContain("'multi_table_limit', 4, 1, 8, true");
    expect(r).toContain("jsonb_build_object('desktop', v_mtl, 'tablet', v_mtl, 'mobile', v_mtl)");
    expect(r).toContain(
      "CASE v_mtl_p WHEN 'desktop' THEN 4 WHEN 'tablet' THEN 3 ELSE 2 END, 1, 8, true"
    );
    expect(r).toContain("'unknown_platform'");
    expect(r).toContain("'multi_table_limit', v_mtl_obj,");
  });
  it.each(RESIGNED)(
    '%s gains a trailing p_player_platforms jsonb DEFAULT NULL',
    (oldSig, newSig) => {
      const r = rewrite(oldSig);
      expect(r).toContain(`'${newSig}'`);
      expect(r).toContain('p_player_platforms jsonb DEFAULT NULL::jsonb)');
    }
  );
  it("P0 uses the limit of the player's own platform, missing or unknown being desktop, and names it", () => {
    const r = rewrite(RESIGNED[0][0]);
    expect(r).toContain(
      "public.fn_lightning_config(cg.id) -> 'multi_table_limit' AS multi_table_limits"
    );
    expect(r).toContain(
      "CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')"
    );
    expect(r).toContain("ELSE 'desktop' END AS platform");
    expect(r).toContain("'multi_table_limit', c.multi_table_limit, 'platform', c.platform,");
  });
  it('the map flows from the matcher through the planner to P0', () => {
    expect(rewrite(RESIGNED[1][0])).toContain(
      'public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms)'
    );
    expect(rewrite(RESIGNED[1][0])).toMatch(/ARRAY\[1, 2\]\);$/);
    expect(rewrite(RESIGNED[2][0])).toContain(
      'fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL, p_player_platforms)'
    );
    expect(rewrite(RESIGNED[3][0])).toContain(
      'public.fn_lightning_match_plan(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed, p_player_platforms)'
    );
  });
});

describe('every substitution is asserted', () => {
  const rw = () =>
    SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION pg_temp.lp8_rewrite('), SQL.indexOf('$rw$;'));
  it('the rewriter reads production, counts each anchor, refuses a blind replace and reads back', () => {
    expect(rw()).toMatch(/v_src := pg_get_functiondef\(p_old::regprocedure\);/);
    expect(rw()).toMatch(
      /IF v_n IS DISTINCT FROM p_counts\[k\] THEN\s+RAISE EXCEPTION '% carries anchor % % time\(s\) rather than %; refusing to substitute blind'/
    );
    expect(rw()).toMatch(/EXECUTE v_new;/);
    expect(rw()).toMatch(/does not read back carrying/);
  });
  it('a re-signed function carries who may execute and its comment, asserted semantically per role', () => {
    expect(rw()).toMatch(/EXECUTE format\('DROP FUNCTION %s', p_old\);/);
    // Production's default privileges and autorevoke event trigger make raw
    // aclitem[] text unstable, so the carry-over is has_function_privilege
    // per request role: captured before the drop, wiped, re-granted and read
    // back, never compared as ACL text.
    expect(rw()).toMatch(/ARRAY\['anon', 'authenticated', 'service_role'\]/);
    expect(rw()).toMatch(/has_function_privilege\(t\.r, p_old::regprocedure, 'EXECUTE'\)/);
    expect(rw()).toMatch(
      /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(rw()).toMatch(/GRANT EXECUTE ON FUNCTION %s TO %I/);
    expect(rw()).toMatch(
      /has_function_privilege\(t\.r, p_new::regprocedure, 'EXECUTE'\) IS DISTINCT FROM v_had\[t\.ord\]/
    );
    expect(rw()).toMatch(/did not keep who may execute \(%\) and the comment of %/);
    expect(rw()).not.toMatch(/proacl.*IS DISTINCT FROM.*::text|aclexplode/);
  });
  it('a function already carrying the change is left alone, and a half-applied pair refuses', () => {
    expect(rw()).toMatch(/IF v_same AND position\(p_marker in v_src\) > 0 THEN\s+RETURN;/);
    expect(rw()).toMatch(/both exist; refusing to guess which one callers reach/);
  });
  it("the settlement writes the engine's showdown in the same statement as the outcome", () => {
    const r = rewrite(
      'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'
    );
    expect(r).toContain("showed = (x ->> 'showed')::boolean,");
    expect(r).toMatch(/ARRAY\[1\]\);$/);
  });
});

describe('the wait and the showdown', () => {
  it("the formation's wait is formed_at minus the slot's idle_since, never a caller's, and final", () => {
    const t = fnCode('fn_lightning_hand_player_records_its_wait');
    expect(t).toMatch(
      /SELECT h\.formed_at INTO v_formed FROM public\.lightning_hand h WHERE h\.hand_id = NEW\.hand_id;/
    );
    expect(t).toMatch(
      /SELECT sl\.idle_since INTO v_idle FROM public\.lightning_pool_slot sl WHERE sl\.id = NEW\.pool_slot_id;/
    );
    expect(t).toMatch(/round\(extract\(epoch FROM \(v_formed - v_idle\)\) \* 1000\)/);
    expect(t).toMatch(/LIGHTNING_WAIT_IS_FINAL/);
    expect(t).toMatch(/LIGHTNING_SHOWDOWN_IS_FINAL/);
    expect(t).toMatch(/NEW\.showed := NULL;/);
    expect(CODE).toMatch(
      /CREATE TRIGGER trg_hand_player_records_its_wait\s+BEFORE INSERT OR UPDATE OF waited_ms, showed ON public\.lightning_hand_player/
    );
  });
});

describe('the five browser doors', () => {
  it.each(DOORS)(
    '%s is SECURITY DEFINER, pinned, STABLE, asks auth.uid() and is authenticated and service_role only',
    (name) => {
      expect(fn(name)).toMatch(/STABLE\nSECURITY DEFINER\nSET search_path = public, pg_temp/);
      expect(fnCode(name)).toMatch(/auth\.uid\(\)/);
      expect(CODE).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon;`)
      );
      expect(CODE).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO authenticated, service_role;`
        )
      );
      expect(CODE).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO [^;]*anon`)
      );
    }
  );
  it.each(DOORS)(
    '%s writes nothing and never names an instance, a horse or a matcher internal',
    (name) => {
      const b = fnCode(name);
      expect(b).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM/);
      expect(b).not.toMatch(
        /is_horse|horse_id|lightning_instance_id|instance_id|reason_code|fn_lightning_player_legality/
      );
    }
  );
  it('the statistics answer the exact contract and NULL to anyone but the owner or service_role', () => {
    const b = fnCode('fn_lightning_session_stats');
    for (const k of [
      'pool_session_id',
      'cluster_id',
      'started_at',
      'ended_at',
      'duration_s',
      'hands',
      'hands_per_hour',
      'starting_stack',
      'current_stack',
      'net',
      'bb_per_100',
      'vpip',
      'pfr',
      'avg_pot',
      'showdowns',
      'fast_folds',
      'normal_folds',
      'fold_and_watch',
      'avg_wait_ms',
      'p95_wait_ms',
      'p99_wait_ms',
    ])
      expect(b, k).toContain(`'${k}',`);
    expect(b).toMatch(/coalesce\(auth\.role\(\), ''\) = 'service_role'/);
    expect(b).toMatch(
      /IF NOT FOUND OR \(NOT v_service AND s\.player_id IS DISTINCT FROM v_uid\) THEN\s+RETURN NULL;/
    );
    expect(b).toMatch(/percentile_disc\(0\.95\) WITHIN GROUP \(ORDER BY hp\.waited_ms\)/);
    expect(b).toMatch(/percentile_disc\(0\.99\) WITHIN GROUP \(ORDER BY hp\.waited_ms\)/);
  });
  it("VPIP and PFR come from ca_hand_facts, the cash statistics' own per-hand facts, and are null until projected", () => {
    const b = fnCode('fn_lightning_session_stats');
    expect(b).toMatch(
      /LEFT JOIN public\.ca_hand_facts f ON f\.hand_id = lh\.hand_history_id AND f\.user_id = hp\.player_id/
    );
    expect(b).toMatch(
      /'vpip',\s+CASE WHEN h\.fact_hands > 0 THEN round\(100\.0 \* h\.vpip_hands \/ h\.fact_hands, 1\) END/
    );
    expect(b).toMatch(
      /'pfr',\s+CASE WHEN h\.fact_hands > 0 THEN round\(100\.0 \* h\.pfr_hands \/ h\.fact_hands, 1\) END/
    );
    expect(b).toMatch(/AND lh\.settled_at IS NOT NULL/);
  });
  it('the summary is the statistics plus ended and exit_reason', () => {
    const b = fnCode('fn_lightning_session_summary');
    expect(b).toMatch(/v_stats := public\.fn_lightning_session_stats\(p_pool_session_id\);/);
    expect(b).toMatch(
      /jsonb_build_object\('ended', s\.exited_at IS NOT NULL, 'exit_reason', s\.exit_reason\)/
    );
  });
  it("my sessions lists the caller's open sessions with name, stakes, variant, stack and in_hand", () => {
    const b = fnCode('fn_lightning_my_sessions');
    for (const k of [
      'pool_session_id',
      'cluster_id',
      'name',
      'stakes',
      'variant',
      'stack',
      'in_hand',
    ])
      expect(b, k).toContain(`'${k}',`);
    expect(b).toMatch(/jsonb_build_object\('sb', cg\.sb, 'bb', cg\.bb\)/);
    expect(b).toMatch(/WHERE ps\.player_id = v_uid AND ps\.exited_at IS NULL/);
  });
  it('pool status maps the one population reader and the diversity bands onto four words, behind the lobby rule', () => {
    const b = fnCode('fn_lightning_pool_status');
    expect(b).toMatch(/public\.fn_cash_cluster_pool_health\(p_cluster_id, clock_timestamp\(\)\)/);
    expect(b).toMatch(/WHEN g\.cluster_mode = 'pending_off' THEN 'THIN'/);
    expect(b).toMatch(/WHEN g\.cluster_mode IS DISTINCT FROM 'lightning' THEN 'BUILDING'/);
    expect(b).toMatch(/WHEN v_live >= \(v_cfg ->> 'diversity_large_min'\)::integer THEN 'HOT'/);
    expect(b).toMatch(/WHEN v_live >= \(v_cfg ->> 'diversity_medium_min'\)::integer THEN 'ACTIVE'/);
    expect(b).toMatch(/ELSE 'THIN' END;/);
    expect(b).toMatch(
      /NOT coalesce\(\(\(cg\.ruleset_snapshot -> 'options'\) ->> 'is_private'\)::boolean, false\)/
    );
    expect(b).toMatch(
      /FROM public\.club_members cm\s+WHERE cm\.club_id = cg\.club_id AND cm\.user_id = v_uid/
    );
    expect(b).toMatch(
      /jsonb_build_object\('cluster_mode', g\.cluster_mode, 'players', v_live, 'status', v_status\)/
    );
  });
  it("recent hands are the caller's own settled hands, newest first, at most fifty, optionally one of their sessions", () => {
    const b = fnCode('fn_lightning_recent_hands');
    expect(fn('fn_lightning_recent_hands')).toMatch(
      /\(p_limit integer DEFAULT 50,\s+p_pool_session_id uuid DEFAULT NULL\)\nRETURNS jsonb/
    );
    expect(b).toMatch(/LEAST\(GREATEST\(coalesce\(p_limit, 50\), 0\), 50\)/);
    expect(b).toMatch(/WHERE hp\.player_id = v_uid\s+AND lh\.settled_at IS NOT NULL/);
    expect(b).toMatch(/ORDER BY lh\.settled_at DESC, lh\.hand_number DESC\s+LIMIT v_limit/);
    expect(b).toMatch(/ps\.id = p_pool_session_id AND ps\.player_id = v_uid/);
    for (const k of [
      'hand_id',
      'hand_history_id',
      'hand_number',
      'played_at',
      'cluster_id',
      'small_blind',
      'big_blind',
      'position',
      'stack_before',
      'stack_after',
      'net',
      'pot',
      'fold_type',
      'showdown',
      'result',
    ])
      expect(b, k).toContain(`'${k}',`);
    for (const r of ["'folded'", "'split'", "'won'", "'lost'"]) expect(b, r).toContain(r);
    expect(b).toMatch(/LEFT JOIN public\.hand_history hh ON hh\.id = lh\.hand_history_id/);
  });
});

describe('law 10.5 and the live proofs', () => {
  it('nothing in the file reads is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/is_horse|horse_id/);
  });
  it('declares nine balanced live proofs, naming the re-signed functions and every door', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(9);
    for (const p of proofs) {
      // Regex-escaped parentheses inside a pattern are not grouping.
      const bare = p.replace(/\\[()]/g, '');
      expect(count(bare, /\(/g), p).toBe(count(bare, /\)/g));
    }
    const all = proofs.join('\n');
    for (const [, n] of RESIGNED) expect(all, n).toContain(n);
    for (const d of DOORS) expect(all, d).toContain(d);
    expect(all).toContain('cash_games_read');
  });
});

describe('the proof around it', () => {
  it('the harness applies the real chain through Phase 7 and this file twice on its own port, horses beside humans', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_P8_PORT:-55555}');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('LIGHTNING_P8_MIGRATION');
    expect(HARNESS).toContain(
      '20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql'
    );
    expect(count(HARNESS, /-f "\$mine"/g)).toBe(2);
    for (const n of ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
      expect(HARNESS, n).toMatch(new RegExp(`\\\\echo '  ok  ${n} `));
    expect(HARNESS).toContain("'p6#2, p6#4, p6#5, p6#6, s6r#4, s6r#5, s6r#6'");
    expect(HARNESS).toMatch(/horse/);
    expect(HARNESS).toContain('fn_lightning_fast_fold');
    expect(HARNESS).toContain('fn_lightning_settle_hand');
  });
  it("the harness reproduces production's function-creation environment", () => {
    // 2026-10-07: the first production apply was refused by the ACL
    // read-back because the fixture lacked production's default privileges
    // and its autorevoke event trigger. Both are ground now.
    expect(HARNESS).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;'
    );
    expect(HARNESS).toContain(
      'CREATE EVENT TRIGGER trg_autorevoke_privileged_anon ON ddl_command_end'
    );
    expect(HARNESS).toContain('fn_autorevoke_privileged_anon');
    expect(HARNESS).toContain('privileged_function_lock');
    expect(HARNESS).toContain('fx8_born_open');
  });
  it('CI runs it on shard 1 right after the Phase 7 harness', () => {
    const p7 = CI.indexOf('run: bash scripts/dev/test-lightning-phase7-reversion.sh');
    const p8 = CI.indexOf('run: bash scripts/dev/test-lightning-phase8-session.sh');
    expect(p7).toBeGreaterThan(0);
    expect(p8).toBeGreaterThan(p7);
    expect(CI.slice(p7, p8)).toMatch(
      /if: matrix\.shard == 1\n\s+env:\n\s+PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n\s+$/
    );
  });
  it('the schema manifest fragment promises exactly the new functions and the two columns', () => {
    expect([...FRAGMENT.functions].sort()).toEqual(
      [...DOORS, 'fn_lightning_hand_player_records_its_wait'].sort()
    );
    expect(FRAGMENT.tables).toEqual([]);
    expect(FRAGMENT.columns).toEqual({ lightning_hand_player: ['waited_ms', 'showed'] });
  });
  it('the changelog names every door, uses title case headings and no em dash', () => {
    for (const p of [...DOORS, 'p_player_platforms', 'waited_ms', 'multi_table_limit', FILE])
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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE REVIEW MIGRATION (20261008043021): a static reading of the migration
 * that closes the Phase 7/8 adversarial-review findings. This file reads the
 * Phase 8 findings (the cross-Cluster multi-table recount, the winners-record
 * classification, the pool-status client contract, and the mobile default);
 * the Phase 7 findings and the shared transaction shape are read by
 * tests/lightning-phase-7-reversion.test.ts.
 *
 * LIGHTNING_P78R_MIGRATION overrides the file under test, for mutation
 * testing.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const FIX_FILE = '20261008043021_lightning_phase_7_and_8_review_fixes_the_dwell_is_a_duration.sql';
const FIX_MIGRATION =
  process.env.LIGHTNING_P78R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FIX_FILE);
const FIX = fs.readFileSync(FIX_MIGRATION, 'utf8');
const FIXLOG = read('docs', 'changelog', '2026-10-08-lightning-phase-7-8-review-fixes.md');
const NEW_BARRIER =
  'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)';

describe('the review migration: the limit holds across Clusters', () => {
  it('the barrier gains p_player_platforms and the old signature is dropped with grants carried', () => {
    expect(FIX).toContain(NEW_BARRIER);
    expect(FIX).toContain(
      'p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)'
    );
    // the rewriter drops the old signature and re-grants semantically
    expect(FIX).toContain("EXECUTE format('DROP FUNCTION %s', p_old)");
    expect(FIX).toContain('has_function_privilege');
    // the barrier's own version literal names the signature it now is
    expect(FIX).toContain("timestamp with time zone,text,uuid,jsonb)'::regprocedure");
  });
  it('the recount runs after the committed reservations, under sorted per-player advisory locks, and refuses as a retryable 40001', () => {
    const b = FIX.indexOf("SET state = 'committed', resolved_at = p_now");
    expect(b).toBeGreaterThan(0);
    const lock = FIX.indexOf('pg_advisory_xact_lock(hashtextextended', b);
    const refuse = FIX.indexOf('LIGHTNING_MULTI_TABLE_LIMIT', b);
    expect(lock).toBeGreaterThan(b);
    expect(refuse).toBeGreaterThan(lock);
    expect(FIX).toContain(
      "SELECT DISTINCT (x ->> 'player_id')::uuid FROM jsonb_array_elements(v_seats) x ORDER BY 1"
    );
    expect(FIX).toContain("USING ERRCODE = '40001'");
    expect(FIX).toContain('count(DISTINCT r.cluster_id)');
    expect(FIX).toContain("i.state IN ('forming', 'reserved', 'dealing', 'settling')");
    // the lock-order argument is written down where the locks are taken
    expect(FIX).toMatch(/LOCK ORDER, AND WHY THIS CANNOT DEADLOCK/);
  });
  it('the matcher passes its platform map through to the barrier', () => {
    expect(FIX).toContain('v_req,\n        p_player_platforms);');
  });
  it('the recount and the legality lookup both default an unreported platform to mobile', () => {
    expect(count(FIX, /ELSE 'mobile' END AS platform/g)).toBe(2);
    expect(FIX).toContain("ELSE 'mobile' END)::integer");
    expect(FIX).toContain('2) AS multi_table_limit');
    // the anchor it replaces is the desktop default Phase 8 shipped
    expect(FIX).toContain("ELSE 'desktop' END AS platform");
    expect(FIX).toContain('4) AS multi_table_limit');
  });
});

describe('the review migration: recent hands and pool status', () => {
  it('an absent winners record classifies on the net alone, and userId is normalised', () => {
    expect(FIX).toContain('AS available');
    expect(FIX).toContain('WHEN NOT w.available THEN');
    expect(FIX).toContain("lower(btrim(y ->> 'userId'))");
    expect(FIX).toContain("lower(btrim(e ->> 'userId'))");
    expect(FIX).toContain('lower(hp.player_id::text)');
    // in the replacement CASE the availability branch sits right after the
    // fold branch, so a fold is still a fold whatever the record says
    expect(FIX).toContain(
      "WHEN hp.fold_type <> 'none' THEN 'folded'\n                 -- 20261008043021: NO WINNERS RECORD"
    );
  });
  it('pool status is {players, status, joinable, multi_table_limit} and never the raw mode', () => {
    expect(FIX).toContain("RETURN jsonb_build_object('players', v_live, 'status', v_status,");
    expect(FIX).toContain(
      "'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE)"
    );
    expect(FIX).toContain("'multi_table_limit', v_cfg -> 'multi_table_limit');");
    // the anchor it replaces is the raw-mode payload Phase 8 shipped
    expect(FIX).toContain(
      "RETURN jsonb_build_object('cluster_mode', g.cluster_mode, 'players', v_live, 'status', v_status);"
    );
    // and the comment states the new contract
    expect(FIX).toContain('COMMENT ON FUNCTION public.fn_lightning_pool_status(uuid)');
    expect(FIX).toContain('{players, status, joinable, multi_table_limit}');
  });
});

describe('the proof around the review migration (Phase 8 side)', () => {
  it('the harness grounds the defects on the Phase 8 code, applies the Phase 7 remediation then the file twice, races two real backends and reports sections 13 to 19', () => {
    expect(HARNESS).toContain(FIX_FILE);
    expect(HARNESS).toContain('LIGHTNING_P78R_MIGRATION');
    expect(HARNESS).toContain(
      '20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql'
    );
    expect(count(HARNESS, /-f "\$fix"/g)).toBe(2);
    for (const n of ['13', '14', '15', '16', '17', '18', '19'])
      expect(HARNESS, n).toMatch(new RegExp(`\\\\echo '  ok  ${n} `));
    const ground = HARNESS.indexOf('fix-ground.sql');
    const p7r = HARNESS.indexOf('-f "$p7r"');
    const fix = HARNESS.indexOf('-f "$fix"');
    expect(ground).toBeGreaterThan(0);
    expect(p7r).toBeGreaterThan(0);
    expect(fix).toBeGreaterThan(p7r);
    // two real backends: the race runs over dblink with a busy probe
    expect(HARNESS).toContain("harness.dblink_send_query('p8b'");
    expect(HARNESS).toContain("harness.dblink_is_busy('p8b')");
    expect(HARNESS).toContain('LIGHTNING_MULTI_TABLE_LIMIT');
    expect(HARNESS.indexOf('FAIL 13')).toBeLessThan(HARNESS.indexOf('FAIL 14'));
  });
  it('the review changelog names the Phase 8 findings, title case, no em dash', () => {
    for (const p of [
      FIX_FILE,
      'fn_lightning_form_hand',
      'fn_lightning_match_and_form',
      'fn_lightning_player_legality',
      'fn_lightning_recent_hands',
      'fn_lightning_pool_status',
      'p_player_platforms',
      'multi_table_limit',
      'joinable',
    ])
      expect(FIXLOG, p).toContain(p);
    expect(FIXLOG).not.toContain('—');
  });
});
