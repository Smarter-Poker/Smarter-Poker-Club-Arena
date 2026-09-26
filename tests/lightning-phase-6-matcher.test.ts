/**
 * LIGHTNING PHASES 6 AND 7: THE MATCHER EXPLAINS EVERY IDLE PLAYER, AND THE
 * BLINDS ROTATE FAIRLY.
 *
 * A static reading of ONE migration, 20260926080332. The harness
 * scripts/dev/test-lightning-phase6-matcher.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, that the contract names and signatures the engine's
 * Lightning worker is built against are exactly these, that P0 reuses the
 * platform's checks instead of copying them, that the planner writes nothing,
 * that no tunable is a magic number outside the configuration reader, and that
 * the words a rule forbids are absent from CODE rather than from the prose.
 *
 * THE STRIP. `code` loses line comments; `biz` also blanks single-quoted
 * literals, so a forbidden word carried as a literal in an assertion is not
 * mistaken for code.
 *
 * LIGHTNING_P6_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE = '20260926080332_lightning_phase_6_and_7_the_matcher_explains_every_idle_play.sql';
const PREDECESSOR =
  '20260926072638_lightning_remediation_two_d_the_seat_triggers_keep_the_pool_.sql';
const REMEDIATION_TWO = [
  '20260926072527_lightning_remediation_two_a_the_table_records_that_its_engin.sql',
  '20260926072551_lightning_remediation_two_b_cluster_events_carry_a_version_a.sql',
  '20260926072615_lightning_remediation_two_c_the_seat_is_the_anchor_and_the_p.sql',
  PREDECESSOR,
];
const MIGRATION = process.env.LIGHTNING_P6_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const HARNESS = fs.readFileSync(
  path.join(ROOT, 'scripts', 'dev', 'test-lightning-phase6-matcher.sh'),
  'utf8'
);
const FIXTURE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'dev', 'fixtures', 'lightning-phase6-matcher-fixture.sql'),
  'utf8'
);
const CHANGELOG = fs.readFileSync(
  path.join(ROOT, 'docs', 'changelog', '2026-09-26-lightning-phase-6-matcher.md'),
  'utf8'
);
const CI = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const FRAGMENT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'scripts', 'ci', 'schema-manifest.d', 'lightning-phase6-matcher.json'),
    'utf8'
  )
);

function scan(sql: string): { code: string; biz: string } {
  let code = '';
  let biz = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const lit = sql.slice(i, Math.min(j + 1, n));
      code += lit;
      biz += `'${' '.repeat(Math.max(0, lit.length - 2))}'`;
      i = j + 1;
      continue;
    }
    const dollar = /^\$\w*\$/.exec(sql.slice(i, i + 40)); // window-ok: a dollar-quote opening tag is bounded; nothing downstream is pinned to this width
    if (dollar) {
      code += dollar[0];
      biz += dollar[0];
      i += dollar[0].length;
      continue;
    }
    code += sql[i];
    biz += sql[i];
    i++;
  }
  return { code, biz };
}

const { code: CODE, biz: BIZ } = scan(SQL);
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
const count = (hay: string, re: RegExp): number => (hay.match(re) ?? []).length;

/** The functions written out. */
const FUNCTIONS = [
  ...SQL.matchAll(
    /^CREATE OR REPLACE FUNCTION\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\bAS\s+(\$\w*\$)([\s\S]*?)\4;/gm
  ),
].map((m) => ({
  name: m[1],
  args: flat(m[2]),
  attrs: flat(m[3]),
  body: scan(m[5]).code,
  biz: scan(m[5]).biz,
}));
const fn = (name: string) => {
  const f = FUNCTIONS.find((x) => x.name === name);
  if (!f) throw new Error(`the migration no longer writes out public.${name}`);
  return f;
};

const REASONS = [
  'CLUSTER_NOT_LIGHTNING',
  'CLUSTER_FROZEN',
  'LIGHTNING_DISABLED',
  'PLATFORM_FROZEN',
  'WRONG_EPOCH',
  'SESSION_CLOSED',
  'POOL_SESSION_NOT_ACTIVE',
  'CASHOUT_PENDING',
  'ANCHOR_LEFT',
  'SITTING_OUT',
  'NO_STACK',
  'RESTRICTED',
  'RG_EXCLUDED',
  'DISCONNECTED',
  'ALREADY_RESERVED',
  'IN_HAND',
  'SLOT_NOT_OPEN',
  'MULTI_TABLE_LIMIT',
];
const STATES = [
  'MATCHED',
  'WAITING_FOR_PLAYERS',
  'WAITING_FOR_BB',
  'WAITING_FOR_FORMATION',
  'WAITING_FOR_RECONNECT',
  'BLOCKED_WITH_REASON',
];

describe('the transaction and its shape', () => {
  it('is one BEGIN and one COMMIT, the COMMIT last', () => {
    expect(count(BIZ, /^BEGIN;$/gm)).toBe(1);
    expect(count(BIZ, /^COMMIT;$/gm)).toBe(1);
    expect(BIZ.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
  it("right after BEGIN takes the tick's lock order, reservations then slots, under a three-second wait", () => {
    const begin = CODE.indexOf('BEGIN;');
    const lt = CODE.indexOf("SET LOCAL lock_timeout = '3s';");
    const res = CODE.indexOf(
      'LOCK TABLE public.lightning_reservation IN SHARE ROW EXCLUSIVE MODE;'
    );
    const slot = CODE.indexOf('LOCK TABLE public.lightning_pool_slot IN ACCESS EXCLUSIVE MODE;');
    expect(lt).toBeGreaterThan(begin);
    expect(res).toBeGreaterThan(lt);
    expect(slot).toBeGreaterThan(res);
    expect(slot).toBeLessThan(CODE.search(/^ALTER TABLE/m));
    expect(BIZ.slice(begin + 6, lt).trim()).toBe('');
    expect(CODE).not.toContain("lock_timeout = '8s'");
  });
  it('adds one column per ALTER TABLE', () => {
    for (const m of BIZ.matchAll(/^ALTER TABLE[^;]*;/gm)) {
      expect(count(m[0], /ADD COLUMN/g), m[0]).toBeLessThanOrEqual(1);
    }
  });
  it('guards every ADD CONSTRAINT and CREATE TRIGGER, and every table and index is IF NOT EXISTS', () => {
    for (const m of CODE.matchAll(/(ADD CONSTRAINT|CREATE (?:CONSTRAINT )?TRIGGER) (\w+)/g)) {
      const before = CODE.slice(0, m.index);
      const guard = before.lastIndexOf('IF NOT EXISTS (');
      expect(guard, m[2]).toBeGreaterThan(0);
      expect(before.slice(guard), m[2]).toContain(`'${m[2]}'`);
    }
    expect(count(CODE, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)).toBe(0);
    expect(count(CODE, /CREATE TABLE (?!IF NOT EXISTS)/g)).toBe(0);
  });
  it('creates no temporary table, which the break-window guard counts as DDL', () => {
    expect(BIZ).not.toMatch(/CREATE\s+TEMP/i);
  });
  it('is versioned after all four remediation-two files, which it builds on', () => {
    for (const f of REMEDIATION_TWO) {
      expect(FILE.slice(0, 14) > f.slice(0, 14), f).toBe(true);
      expect(fs.existsSync(path.join(MIGRATIONS, f)), f).toBe(true);
    }
  });
  it('re-cuts no existing function: every body it writes is one of its own', () => {
    expect(FUNCTIONS.map((f) => f.name).sort()).toEqual(
      [
        'fn_lightning_config',
        'fn_lightning_config_number',
        'fn_lightning_group_sizes',
        'fn_lightning_match',
        'fn_lightning_match_and_form',
        'fn_lightning_match_plan',
        'fn_lightning_player_legality',
        'fn_lightning_pool_slot_idle_since_starts_at_open',
        'fn_lightning_reservation_end_marks_the_slot_idle',
        'fn_lightning_diversity_assign',
        'fn_cash_cluster_matcher_pass_prune',
      ].sort()
    );
    expect(CODE).not.toMatch(/EXECUTE\s+(v_new|replace\()/);
  });
});

describe('the contract the engine worker is built against', () => {
  it('fn_lightning_config(p_cluster_id uuid) RETURNS jsonb, STABLE', () => {
    const f = fn('fn_lightning_config');
    expect(f.args).toBe('p_cluster_id uuid');
    expect(f.attrs).toMatch(/^jsonb LANGUAGE plpgsql STABLE SET search_path/);
    for (const k of [
      'matcher_version',
      'worker_mode',
      'pass_interval_ms',
      'pass_time_budget_ms',
      'keepalive_interval_ms',
      'instance_min',
      'instance_target',
      'instance_max',
      'reservation_ttl_ms',
      'form_window_ms',
      'deal_window_ms',
      'recent_opponent_window_hands',
      'recent_opponent_window_seconds',
      'diversity_thin_min',
      'diversity_medium_min',
      'diversity_large_min',
      'diversity_weight_large',
      'diversity_weight_medium',
      'diversity_weight_thin',
      'diversity_weight_tiny',
      'multi_table_limit',
      'admission_batch_hands',
      'max_replans',
      'cluster_row_wait_ms',
      'pass_record_retention_hours',
      'pass_record_prune_batch',
      'first_entry_rule',
      'position_fairness',
      'invalid',
    ]) {
      expect(f.body, k).toContain(`'${k}', `);
    }
    expect(f.body).toContain("v_mode := 'off';");
    expect(f.body).toContain("IN ('off', 'shadow', 'form')");
  });
  it('fn_lightning_player_legality(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[]) RETURNS TABLE of six columns, STABLE', () => {
    const f = fn('fn_lightning_player_legality');
    expect(f.args).toBe('p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[]');
    expect(f.attrs).toBe(
      "TABLE ( player_id uuid, pool_session_id uuid, pool_slot_id uuid, legal boolean, reason_code text, detail jsonb) LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'"
    );
  });
  it('fn_lightning_match(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[], p_matcher_version text) RETURNS jsonb, STABLE', () => {
    const f = fn('fn_lightning_match');
    expect(f.args).toBe(
      'p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text'
    );
    expect(f.attrs).toMatch(/^jsonb LANGUAGE sql STABLE SET search_path/);
    expect(f.body).toContain(
      'fn_lightning_match_plan(p_cluster_id, p_now, p_disconnected, p_matcher_version, NULL)'
    );
  });
  it('fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamptz, p_disconnected uuid[], p_max_hands integer, p_request_id uuid) RETURNS jsonb', () => {
    const f = fn('fn_lightning_match_and_form');
    expect(f.args).toBe(
      'p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_max_hands integer, p_request_id uuid'
    );
    expect(f.attrs).toMatch(/^jsonb LANGUAGE plpgsql SET search_path/);
    expect(f.attrs).not.toMatch(/STABLE|IMMUTABLE/);
  });
  it('the plan is exactly the six output keys the contract names', () => {
    const f = fn('fn_lightning_match_plan');
    const ret = f.body.slice(f.body.lastIndexOf('RETURN jsonb_build_object('));
    const keys = [...ret.matchAll(/'(\w+)', /g)].map((m) => m[1]);
    expect(keys).toEqual([
      'matcher_version',
      'generated_at',
      'legal_count',
      'groups',
      'diagnosis',
      'pool_diversity_score',
    ]);
    expect(f.body).toContain("'players', to_jsonb(");
    expect(f.body).toContain("'bb', v_bb,");
    expect(f.body).toContain("'keys', jsonb_build_object(");
  });
  it('every diagnosis state of the specification, and no other', () => {
    const f = fn('fn_lightning_match_plan');
    const found = [
      ...new Set([...f.body.matchAll(/(?:THEN|ELSE) '([A-Z_]+)'/g)].map((m) => m[1])),
    ].filter((s) => STATES.includes(s) || /^WAITING|^BLOCKED|^MATCHED/.test(s));
    expect(found.sort()).toEqual([...STATES].sort());
  });
});

describe('P0: one ordered CASE, the platform checks reused', () => {
  const f = fn('fn_lightning_player_legality');
  it('answers exactly the eighteen reasons, in the documented order', () => {
    const order = [...f.body.matchAll(/THEN '([A-Z_]+)'/g)].map((m) => m[1]);
    const firsts = order.filter((c, i) => order.indexOf(c) === i);
    expect(firsts).toEqual(REASONS);
  });
  it('reuses the anchor predicate, the pool stack, the in-hand test and the freeze', () => {
    expect(f.body).toContain(
      'fn_lightning_anchor_is_live_eligible(f.anchor_seat_id, f.cluster_id, f.player_id)'
    );
    expect(f.body).toContain('fn_lightning_pool_stack(f.pool_session_id)');
    expect(f.body).toContain('fn_lightning_player_in_hand(f.player_id, f.cluster_id)');
    expect(f.body).toContain('public.fn_platform_frozen()');
  });
  it('gates the restriction reader by the operator switch exactly as the seat door does', () => {
    expect(f.body).toContain(
      "WHEN f.restrictions_enforced AND public.fn_ca_player_restricted(f.player_id, 'cash') THEN 'RESTRICTED'"
    );
    expect(f.body).toContain(
      'SELECT op.restrictions_enforced FROM public.ca_operator_policy op LIMIT 1'
    );
    expect(f.biz).not.toMatch(/FROM public\.ca_player_restrictions/);
  });
  it('asks the platform responsible-gaming reader and never reads its table itself', () => {
    expect(f.body).toContain(
      "WHEN (public.fn_rg_require_not_excluded(f.player_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN 'RG_EXCLUDED'"
    );
    expect(CODE).not.toMatch(/responsible_gaming_limits/);
  });
  it('materializes its CTEs so no check runs once per reference', () => {
    expect(f.body).toMatch(/WITH g AS MATERIALIZED \(/);
    expect(f.body).toMatch(/\), c AS MATERIALIZED \(/);
  });
});

describe('the planner writes nothing and reads no magic number', () => {
  it('the planner, the match, legality, the sizes and the configuration contain no write', () => {
    for (const name of [
      'fn_lightning_match_plan',
      'fn_lightning_match',
      'fn_lightning_player_legality',
      'fn_lightning_group_sizes',
      'fn_lightning_config',
      'fn_lightning_config_number',
      'fn_lightning_diversity_assign',
    ]) {
      expect(fn(name).biz, name).not.toMatch(
        /\b(INSERT INTO|UPDATE public\.|DELETE FROM|TRUNCATE)\b/
      );
    }
  });
  it('every tunable default lives in fn_lightning_config and nowhere in the planner or the writer', () => {
    for (const name of ['fn_lightning_match_plan', 'fn_lightning_match_and_form']) {
      const b = fn(name).biz;
      for (const lit of ['20000', '45000', '600000', '750', '5000', '900', '32']) {
        expect(b, `${name} ${lit}`).not.toMatch(new RegExp(`\\b${lit}\\b`));
      }
      expect(b, name).toMatch(/v_cfg ->> /);
    }
  });
  it('the thresholds are the population reader, not a copy', () => {
    expect(fn('fn_lightning_config').body).toContain(
      'v_thr := public.fn_cash_cluster_lightning_thresholds(g.id);'
    );
    expect(fn('fn_lightning_config').biz).not.toMatch(/\b(18|27)\b/);
  });
});

describe('P1 to P6', () => {
  const plan = fn('fn_lightning_match_plan');
  it('P1: the sizes come from fn_lightning_group_sizes, never a one-player group', () => {
    expect(plan.body).toContain(
      'public.fn_lightning_group_sizes(cardinality(v_seatable), v_min, v_target, v_max)'
    );
    const s = fn('fn_lightning_group_sizes');
    expect(s.attrs).toMatch(/^integer\[\] LANGUAGE plpgsql IMMUTABLE/);
    expect(s.body).toContain('IF v_n < v_min THEN');
    expect(s.body).toContain('v_min    := LEAST(GREATEST(coalesce(p_min, 2), 2), v_max);');
  });
  it("P2: the big blinds are the head of the barrier's own blind order", () => {
    expect(plan.body).toContain('public.fn_lightning_blind_order(p_cluster_id, v_epoch,');
    expect(plan.body).toContain('v_bbs := CASE WHEN v_g > 0 THEN v_seatable[1:v_g]');
  });
  it('P4: idle_since, then pool entry, then the Cluster join, then player_id', () => {
    expect(plan.body).toContain(
      'row_number() OVER (ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, bo.player_id) AS p4'
    );
  });
  it('P5: only by pool-size band, zero in thin and tiny, never changes a group size, and penalises a repeated full table', () => {
    const d = fn('fn_lightning_diversity_assign');
    expect(d.attrs).toMatch(/^jsonb LANGUAGE plpgsql IMMUTABLE/);
    expect(plan.body).toContain('ELSE 0 END;');
    expect(plan.body).toContain(
      'v_assign := public.fn_lightning_diversity_assign(v_grp, v_rest, v_capleft, v_enc, v_recent_sets, v_w);'
    );
    expect(d.body).toContain('IF NOT (p_weight * (v_def_pen - v_best_pen) >= 1) THEN');
    expect(d.body).toContain('v_cap[v_best] := v_cap[v_best] - 1;');
    expect(d.body).toContain('IF v_sets ? v_key THEN');
    for (const k of [
      'unique_opponents',
      'new_opponents_per_hand',
      'repeat_pair_rate',
      'repeat_opponent_rate',
    ])
      expect(plan.body, k).toContain(`'${k}', `);
    expect(fn('fn_lightning_config').body).toContain("'diversity_weight_thin', 0,");
  });
  it('P3: orders only the non-blind seats, from the button backward', () => {
    expect(plan.body).toContain('WHERE m <> v_bb AND m IS DISTINCT FROM v_sb');
    expect(plan.body).toContain('FOR v_seat_no IN REVERSE v_size .. 3 LOOP');
  });
  it('the writer holds the Cluster before it forms, forms through the barrier and stops on a freeze', () => {
    const w = fn('fn_lightning_match_and_form');
    const adv = w.body.indexOf(
      "pg_try_advisory_xact_lock(hashtextextended('lightning_matcher:' || p_cluster_id::text, 0))"
    );
    const row = w.body.indexOf(
      'PERFORM 1 FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;'
    );
    expect(adv).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(adv);
    expect(row).toBeLessThan(w.body.indexOf('public.fn_lightning_form_hand('));
    expect(w.body).toContain(
      "PERFORM set_config('lock_timeout', (v_cfg ->> 'cluster_row_wait_ms') || 'ms', true);"
    );
    expect(w.body).toContain("v_skip := 'cluster_row_busy';");
    expect(w.body).not.toContain('SKIP LOCKED');
    expect(w.body).toContain(
      "v_req := md5(p_request_id::text || '/matcher_group/' || v_ordinal)::uuid;"
    );
    expect(w.body).toContain("(v_r ->> 'reason') = 'formation_invariant_failed'");
    expect(w.body).toContain("'worker_mode_is_not_form'");
    expect(w.body).toContain("'pass_in_progress'");
    expect(count(w.body, /'matcher_assignment'/g)).toBe(1);
    expect(count(w.body, /'matcher_pass'/g)).toBe(1);
    expect(w.body).toContain('INSERT INTO public.cash_cluster_matcher_pass');
    expect(w.body).toContain("v_group_now := v_now + (v_ordinal - 1) * interval '1 microsecond';");
  });
  it('the writer records a pass only when something happened, and prunes the record through the one definer', () => {
    const w = fn('fn_lightning_match_and_form');
    expect(flat(w.body)).toContain(
      "v_record := v_formed > 0 OR jsonb_array_length(v_retries) > 0 OR v_frozen OR v_last IS NULL OR (v_last ->> 'stopped_reason') IS DISTINCT FROM (v_result ->> 'stopped_reason') OR (v_last -> 'states') IS DISTINCT FROM (v_result -> 'states') OR (v_last -> 'reasons') IS DISTINCT FROM (v_result -> 'reasons');"
    );
    const rec = w.body.lastIndexOf('IF v_record THEN');
    expect(w.body.indexOf("'matcher_pass'")).toBeGreaterThan(rec);
    expect(w.body).toContain('public.fn_cash_cluster_matcher_pass_prune(');
    const p = fn('fn_cash_cluster_matcher_pass_prune');
    expect(p.attrs).toMatch(/SECURITY DEFINER/);
    expect(p.body).toContain('WHERE o.cluster_id = p_cluster_id AND o.started_at < p_before');
    expect(p.body).toContain('LIMIT LEAST(p_limit, 10000)');
  });
});

describe('idle_since', () => {
  it('is added, backfilled from the released reservations, then made NOT NULL and never before opened_at', () => {
    const add = CODE.indexOf('ADD COLUMN IF NOT EXISTS idle_since timestamptz');
    const fill = CODE.indexOf('SET idle_since = GREATEST(sl.opened_at,');
    const nn = CODE.indexOf('ALTER COLUMN idle_since SET NOT NULL');
    expect(add).toBeGreaterThan(0);
    expect(fill).toBeGreaterThan(add);
    expect(nn).toBeGreaterThan(fill);
    expect(CODE).toContain('CHECK (idle_since >= opened_at)');
  });
  it('starts at opened_at and moves forward only when a reservation of a DEALT hand ends', () => {
    expect(fn('fn_lightning_reservation_end_marks_the_slot_idle').body).toContain(
      'WHERE i.id = NEW.lightning_instance_id AND i.started_at IS NOT NULL'
    );
    expect(CODE).toContain('AND i.started_at IS NOT NULL),');
    expect(fn('fn_lightning_pool_slot_idle_since_starts_at_open').body).toContain(
      'NEW.idle_since := GREATEST(coalesce(NEW.idle_since, NEW.opened_at), NEW.opened_at);'
    );
    const t =
      /CREATE TRIGGER trg_matcher_reservation_end_marks_the_slot_idle([\s\S]*?)EXECUTE FUNCTION/.exec(
        CODE
      )!;
    expect(flat(t[1])).toBe(
      "AFTER UPDATE OF state ON public.lightning_reservation FOR EACH ROW WHEN (OLD.state IN ('pending', 'committed') AND NEW.state IN ('released', 'expired'))"
    );
    expect(fn('fn_lightning_reservation_end_marks_the_slot_idle').body).toContain(
      'SET idle_since = GREATEST(sl.idle_since,'
    );
  });
  it('names its triggers outside trg_lightning_, which a predecessor proof lists exactly', () => {
    for (const m of CODE.matchAll(/CREATE TRIGGER (\w+)/g)) expect(m[1]).toMatch(/^trg_matcher_/);
  });
});

describe('the laws', () => {
  it('Law 10.5: no code in the file mentions is_horse or horse_id', () => {
    expect(BIZ).not.toMatch(/is_horse|horse_id/);
  });
  it('no function runs as its owner but the pass-record prune, and every one pins its search_path', () => {
    for (const f of FUNCTIONS) {
      if (f.name !== 'fn_cash_cluster_matcher_pass_prune')
        expect(f.attrs, f.name).not.toMatch(/SECURITY DEFINER/);
      expect(f.attrs, f.name).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    }
  });
  it('every function is revoked from the browser roles and granted to service_role', () => {
    for (const f of FUNCTIONS) {
      expect(CODE, f.name).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${f.name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`
        )
      );
      expect(CODE, f.name).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f.name}\\([^)]*\\) TO service_role;`)
      );
    }
  });
  it('the pass record is append only for service_role and has no foreign key to a hot table', () => {
    expect(CODE).toContain(
      'REVOKE ALL ON TABLE public.cash_cluster_matcher_pass FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(CODE).toContain(
      'GRANT SELECT, INSERT ON TABLE public.cash_cluster_matcher_pass TO service_role;'
    );
    const t = /CREATE TABLE IF NOT EXISTS public\.cash_cluster_matcher_pass \(([\s\S]*?)\n\);/.exec(
      CODE
    )!;
    expect(t[1]).not.toMatch(/REFERENCES/);
    expect(CODE).toContain(
      'ALTER TABLE public.cash_cluster_matcher_pass ENABLE ROW LEVEL SECURITY;'
    );
  });
  it('never writes a stack, a seat or the tick', () => {
    expect(BIZ).not.toMatch(
      /SET\s+stack\s*=|UPDATE public\.table_seats|fn_cash_clusters_tick_all|cron\./
    );
  });
});

describe('the live proofs', () => {
  const proofs: string[] = declaredProofs(SQL);
  it('declares at least twelve, each balanced', () => {
    expect(proofs.length).toBeGreaterThanOrEqual(12);
    for (const p of proofs) {
      const b = scan(p).biz;
      expect(count(b, /\(/g), p).toBe(count(b, /\)/g));
    }
  });
  it('are containment, never the exact size of a set a later file may grow', () => {
    for (const p of proofs) {
      expect(p, p).not.toMatch(/array_agg\([^)]*\)[^=]*= ARRAY\[/);
      expect(p, p).not.toMatch(/count\(\*\) = \d/);
    }
  });
});

describe('the wiring', () => {
  it('the harness applies the real chain through this file twice on its own port and counts twenty-two sections', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_P6_PORT:-55552}');
    expect(HARNESS).toContain(FILE);
    for (const f of REMEDIATION_TWO) expect(HARNESS).toContain(f);
    expect(HARNESS).toContain('-f "$r2a" -f "$r2b" -f "$r2c" -f "$r2d" -f "$p6_fixture"');
    expect(count(HARNESS, /-f "\$mine"/g)).toBe(2);
    expect(HARNESS).toContain('if [ "$oks" != 22 ]; then');
    expect(HARNESS).toContain('rounds=${LIGHTNING_P6_SIM_ROUNDS:-1000}');
  });
  it('the fixture copies the platform readers it stands in for and reads no horse', () => {
    expect(FIXTURE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_rg_require_not_excluded(p_user_id uuid)'
    );
    expect(FIXTURE).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_ca_player_restricted(p_user_id uuid, p_scope text)'
    );
    expect(scan(FIXTURE).biz).not.toMatch(/is_horse/);
  });
  it('CI runs the harness right after the remediation two step', () => {
    const r2 = CI.indexOf('run: bash scripts/dev/test-lightning-remediation-two.sh');
    const mine = CI.indexOf('run: bash scripts/dev/test-lightning-phase6-matcher.sh');
    expect(r2).toBeGreaterThan(0);
    expect(mine).toBeGreaterThan(r2);
    expect(CI.slice(r2, mine).match(/- name:/g)?.length).toBe(1);
    expect(CI.slice(r2, mine)).toContain(
      '- name: Lightning Phases 6 and 7 match every legal hand, explain every idle player and rotate the blinds fairly'
    );
  });
  it('the schema fragment names every function, the table and the column this file adds', () => {
    for (const f of FUNCTIONS) expect(FRAGMENT.functions).toContain(f.name);
    expect(FRAGMENT.tables).toContain('cash_cluster_matcher_pass');
    expect(FRAGMENT.columns.lightning_pool_slot).toContain('idle_since');
  });
  it('the changelog lists the superseded proofs, uses title case headings and no em dash', () => {
    expect(CHANGELOG).toMatch(/^## Corrections/m);
    for (const p of ['p9#3', 'p9r#12']) {
      expect(CHANGELOG, p).toContain(p);
      expect(HARNESS, p).toContain(p);
    }
    expect(CHANGELOG).not.toContain('—');
    for (const h of CHANGELOG.match(/^#{1,3} .+$/gm) ?? []) {
      const words = h
        .replace(/^#+ /, '')
        .replace(/`[^`]*`/g, '')
        .split(/\s+/)
        .filter((w) => /^[a-z]/.test(w));
      expect(words, h).toEqual([]);
    }
  });
});
