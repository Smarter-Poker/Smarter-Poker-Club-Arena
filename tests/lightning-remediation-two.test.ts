/**
 * LIGHTNING PHASES 5 AND 9, REMEDIATION TWO: THE SEAT IS THE ANCHOR, THE POOL
 * FOLLOWS IT, AND A HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT.
 *
 * A static reading of the FOUR migrations of remediation two (A to D). The harness
 * scripts/dev/test-lightning-remediation-two.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, that the hot tables are touched last, that every
 * re-cut counts its anchors and reads its body back, that the contract names
 * and signatures other engineers build against are exactly these, and that
 * the words a rule forbids are absent from CODE rather than from the prose.
 *
 * THE STRIP. `code` loses line comments; `biz` also blanks single-quoted
 * literals, because this file's own assertions carry forbidden words as
 * literals (`IF v_live ~ 'is_horse' THEN RAISE ...`).
 *
 * LIGHTNING_R2_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const FILE_A = '20260926072527_lightning_remediation_two_a_the_table_records_that_its_engin.sql';
const FILE_B = '20260926072551_lightning_remediation_two_b_cluster_events_carry_a_version_a.sql';
const FILE = '20260926072615_lightning_remediation_two_c_the_seat_is_the_anchor_and_the_p.sql';
const FILE_D = '20260926072638_lightning_remediation_two_d_the_seat_triggers_keep_the_pool_.sql';
const read = (env: string | undefined, f: string): string =>
  fs.readFileSync(env ?? path.join(MIGRATIONS, f), 'utf8');
const SQL_A = read(process.env.LIGHTNING_R2_MIGRATION_A, FILE_A);
const SQL_B = read(process.env.LIGHTNING_R2_MIGRATION_B, FILE_B);
const SQL = read(process.env.LIGHTNING_R2_MIGRATION_C, FILE);
const SQL_D = read(process.env.LIGHTNING_R2_MIGRATION_D, FILE_D);
const ALL = [SQL_A, SQL_B, SQL, SQL_D];
const HARNESS = fs.readFileSync(
  path.join(ROOT, 'scripts', 'dev', 'test-lightning-remediation-two.sh'),
  'utf8'
);
const CHANGELOG = fs.readFileSync(
  path.join(ROOT, 'docs', 'changelog', '2026-09-26-lightning-phase-5-9-remediation-2.md'),
  'utf8'
);
const CI = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const FRAGMENT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'scripts', 'ci', 'schema-manifest.d', 'lightning-remediation-two.json'),
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

/** The re-cuts: every DO block whose tag starts $recut_. */
const RECUTS = [...SQL.matchAll(/^DO (\$recut_\w+\$)\n([\s\S]*?)\n\1;/gm)].map((m) => ({
  tag: m[1],
  raw: m[2],
  code: scan(m[2]).code,
}));

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

describe('four files, and no one of them locks two hot tables', () => {
  const files = [
    { name: 'A', sql: SQL_A, wait: '2s' },
    { name: 'B', sql: SQL_B, wait: '2s' },
    { name: 'C', sql: SQL, wait: '8s' },
    { name: 'D', sql: SQL_D, wait: '2s' },
  ];
  it.each(files)(
    'file $name is one BEGIN and one COMMIT, the COMMIT last, with its lock_timeout first',
    ({ sql, wait }) => {
      const { code, biz } = scan(sql);
      expect(count(biz, /^BEGIN;$/gm)).toBe(1);
      expect(count(biz, /^COMMIT;$/gm)).toBe(1);
      expect(biz.trimEnd().endsWith('COMMIT;')).toBe(true);
      const lt = code.indexOf(`SET LOCAL lock_timeout = '${wait}';`);
      expect(lt).toBeGreaterThan(code.indexOf('BEGIN;'));
      const firstDdl = code.search(/^(ALTER TABLE|DO \$|CREATE )/m);
      expect(lt).toBeLessThan(firstDdl);
    }
  );
  it.each(files)(
    'file $name adds one column per ALTER TABLE and creates no temporary table',
    ({ sql }) => {
      const { biz } = scan(sql);
      for (const m of biz.matchAll(/^ALTER TABLE[^;]*;/gm))
        expect(count(m[0], /ADD COLUMN/g), m[0]).toBeLessThanOrEqual(1);
      expect(biz).not.toMatch(/CREATE\s+TEMP/i);
    }
  );
  it('file A alters public.tables and nothing else', () => {
    const { code } = scan(SQL_A);
    expect([...code.matchAll(/ALTER TABLE (public\.\w+)/g)].map((m) => m[1])).toEqual([
      'public.tables',
    ]);
    expect(code).not.toMatch(/table_seats|cash_cluster_events/);
  });
  it('file B alters public.cash_cluster_events and nothing else', () => {
    const { code } = scan(SQL_B);
    expect(new Set([...code.matchAll(/ALTER TABLE (public\.\w+)/g)].map((m) => m[1]))).toEqual(
      new Set(['public.cash_cluster_events'])
    );
    expect(code).not.toMatch(/table_seats|public\.tables\b/);
  });
  it('file C alters no hot table, creates no trigger on one, and validates no body against one', () => {
    expect(CODE).not.toMatch(/ALTER TABLE public\.(tables|table_seats|cash_cluster_events)\b/);
    expect(CODE).not.toMatch(
      /CREATE (CONSTRAINT )?TRIGGER \w+\s+\w+ (INSERT|UPDATE|DELETE)[^;]*ON public\.table_seats/
    );
    expect(CODE).not.toMatch(/REFERENCES public\.table_seats/);
    expect(CODE.indexOf('SET LOCAL check_function_bodies = off;')).toBeGreaterThan(
      CODE.indexOf('BEGIN;')
    );
    expect(CODE.indexOf('SET LOCAL check_function_bodies = off;')).toBeLessThan(
      CODE.search(/^CREATE OR REPLACE FUNCTION/m)
    );
    // The backfill and the sweep read table_seats only when there is something to do.
    expect(CODE).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM public\.lightning_pool_session ps WHERE ps\.anchor_seat_id IS NULL\) THEN\s+RETURN;/
    );
    expect(CODE).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM public\.cash_games WHERE cluster_mode = 'lightning'\) THEN\s+RETURN;/
    );
  });
  it('file D touches table_seats and the trigger register and never tables or cash_cluster_events', () => {
    const { biz } = scan(SQL_D);
    expect(biz).not.toMatch(/public\.tables\b|cash_cluster_events/);
    expect(biz).not.toMatch(/ALTER TABLE/);
  });
  it('every file guards its ADD CONSTRAINT, CREATE TRIGGER and CREATE INDEX so it is re-appliable', () => {
    for (const sql of ALL) {
      const { code } = scan(sql);
      for (const m of code.matchAll(/(ADD CONSTRAINT|CREATE (?:CONSTRAINT )?TRIGGER) (\w+)/g)) {
        const before = code.slice(0, m.index);
        const guard = before.lastIndexOf('IF NOT EXISTS (');
        expect(guard, m[2]).toBeGreaterThan(0);
        expect(before.slice(guard), m[2]).toContain(`'${m[2]}'`);
      }
      expect(count(code, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)).toBe(0);
      expect(count(code, /ADD COLUMN (?!IF NOT EXISTS)/g)).toBe(0);
    }
  });
});

describe('the contract other engineers build against', () => {
  it('fn_cash_table_observe_dealing_halt(p_table_id uuid) RETURNS timestamptz, stamping only a halted table', () => {
    const f = fn('fn_cash_table_observe_dealing_halt');
    expect(f.args).toBe('p_table_id uuid');
    expect(f.attrs).toMatch(/^timestamptz LANGUAGE plpgsql SET search_path/);
    expect(f.body).toMatch(
      /SET dealing_halt_observed_at = clock_timestamp\(\)\s+WHERE t\.id = p_table_id AND t\.dealing_halted_at IS NOT NULL/
    );
  });
  it('fn_lightning_pool_enter(p_seat_id uuid, p_now timestamptz DEFAULT clock_timestamp()) RETURNS uuid', () => {
    const f = fn('fn_lightning_pool_enter');
    expect(f.args).toBe('p_seat_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp()');
    expect(f.attrs).toMatch(/^uuid LANGUAGE plpgsql/);
    expect(f.body).toContain("g.cluster_mode IS DISTINCT FROM 'lightning'");
    expect(f.body).toContain('anchor_seat_id)');
    expect(f.body).toContain('fn_lightning_pool_slot_open(v_ps, v_now)');
  });
  it('fn_lightning_player_in_hand(p_player_id uuid, p_cluster_id uuid) RETURNS boolean', () => {
    const f = fn('fn_lightning_player_in_hand');
    expect(f.args).toBe('p_player_id uuid, p_cluster_id uuid');
    expect(f.attrs).toMatch(/^boolean/);
    expect(f.body).toContain("r.state = 'committed'");
    expect(f.body).toContain("i.state IN ('forming', 'reserved', 'dealing', 'settling')");
  });
  it('fn_lightning_pool_stack returns the anchor seat stack and reads neither copy', () => {
    const f = fn('fn_lightning_pool_stack');
    expect(f.args).toBe('p_pool_session_id uuid');
    expect(f.body).toContain('ts.left_at IS NOT NULL');
    expect(f.body).toMatch(/round\(coalesce\(ts\.stack, 0\), 2\)/);
    expect(f.body).not.toMatch(/starting_stack|net_result/);
  });
  it('the barrier gains p_request_id and the nine-argument signature is dropped', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_form_hand$');
    expect(r).toBeTruthy();
    expect(r!.raw).toContain('p_request_id uuid DEFAULT NULL::uuid)');
    expect(r!.code).toMatch(/EXECUTE format\('DROP FUNCTION %s', v_old\)/);
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_lightning_form_hand\([^)]*text, uuid\) TO service_role/
    );
  });
  it('the anchor guard raises LIGHTNING_HAND_IN_PROGRESS with its own SQLSTATE and honours only the hand being settled', () => {
    const f = fn('fn_table_seats_lightning_anchor_guard');
    expect(f.body).toContain("USING ERRCODE = 'PLT01'");
    expect(f.body).toContain("'LIGHTNING_HAND_IN_PROGRESS:");
    expect(f.body).toContain(
      "nullif(current_setting('ca.lightning_settlement_hand', true), '') IS NOT DISTINCT FROM v_hand::text"
    );
    expect(f.body.indexOf('ps.anchor_seat_id = OLD.id AND ps.exited_at IS NULL')).toBeLessThan(
      f.body.indexOf('fn_lightning_player_in_hand')
    );
  });
  it('the guard fires only when the stack, the departure or the occupant changes', () => {
    const m =
      /CREATE TRIGGER trg_table_seats_lightning_anchor_guard\b([\s\S]*?)EXECUTE FUNCTION/.exec(
        scan(SQL_D).code
      );
    expect(m).toBeTruthy();
    expect(flat(m![1])).toContain(
      'WHEN (OLD.stack IS DISTINCT FROM NEW.stack OR OLD.left_at IS DISTINCT FROM NEW.left_at OR OLD.user_id IS DISTINCT FROM NEW.user_id)'
    );
    expect(flat(m![1])).toMatch(/^BEFORE UPDATE ON public\.table_seats FOR EACH ROW/);
  });
  it('the pool triggers are deferred and their WHEN clauses leave an ordinary stack update alone', () => {
    const upd =
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat([\s\S]*?)EXECUTE FUNCTION/.exec(
        scan(SQL_D).code
      )!;
    const ins =
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert([\s\S]*?)EXECUTE FUNCTION/.exec(
        scan(SQL_D).code
      )!;
    for (const t of [upd, ins])
      expect(flat(t[1])).toContain('DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN');
    const w = flat(upd[1]);
    for (const c of [
      'OLD.left_at IS DISTINCT FROM NEW.left_at',
      'OLD.is_sitting_out IS DISTINCT FROM NEW.is_sitting_out',
      'OLD.leave_pending IS DISTINCT FROM NEW.leave_pending',
      '(coalesce(OLD.stack, 0) > 0) IS DISTINCT FROM (coalesce(NEW.stack, 0) > 0)',
    ]) {
      expect(w).toContain(c);
    }
    expect(w).not.toMatch(/OLD\.stack IS DISTINCT FROM NEW\.stack/);
  });
  it('declares all four table_seats triggers in the money-trigger register, in the file that creates them', () => {
    const m =
      /INSERT INTO public\.ca_declared_money_triggers[\s\S]*?ON CONFLICT \(table_name, trigger_name\) DO NOTHING;/.exec(
        scan(SQL_D).code
      );
    expect(m).toBeTruthy();
    for (const t of [
      'trg_table_seats_lightning_anchor_guard',
      'trg_table_seats_lightning_anchor_delete_guard',
      'trg_table_seats_lightning_pool_on_insert',
      'trg_table_seats_lightning_pool_follows_seat',
    ]) {
      expect(m![0]).toContain(`'${t}'`);
    }
  });
  it('holds the anchor with a BEFORE DELETE guard, not a foreign key to the hot table', () => {
    const D = scan(SQL_D).code;
    expect(
      flat(/CREATE TRIGGER trg_table_seats_lightning_anchor_delete_guard([\s\S]*?);/.exec(D)![1])
    ).toBe(
      'BEFORE DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_table_seats_lightning_anchor_guard()'
    );
    const g = fn('fn_table_seats_lightning_anchor_guard');
    expect(g.body).toContain("IF TG_OP = 'DELETE' THEN");
    expect(g.body).toContain("'LIGHTNING_ANCHOR_SEAT_IS_IN_THE_POOL:");
    expect(g.body).toMatch(
      /ps\.anchor_seat_id = OLD\.id AND ps\.exited_at IS NULL;\s+IF v_ps IS NULL THEN\s+RETURN OLD;/
    );
    for (const sql of ALL)
      expect(scan(sql).code).not.toMatch(
        /FOREIGN KEY \(anchor_seat_id\)|REFERENCES public\.table_seats/
      );
  });
  it('gives a frozen Cluster a way back: fn_cash_cluster_unfreeze(p_game_id, p_operator, p_reason) RETURNS jsonb', () => {
    const f = fn('fn_cash_cluster_unfreeze');
    expect(f.args).toBe('p_game_id uuid, p_operator uuid, p_reason text');
    expect(f.attrs).toMatch(/^jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path/);
    for (const k of [
      'reason_required',
      'operator_required',
      'not_frozen',
      'cluster_unfrozen',
      'LIGHTNING_UNFREEZE_MOVED_MONEY',
    ]) {
      expect(f.body).toContain(k);
    }
    expect(f.body).toMatch(/FROM public\.cash_games WHERE id = p_game_id FOR UPDATE/);
    expect(f.body).toContain("SET cluster_mode = 'must_move', cluster_epoch = v_epoch");
    expect(CODE).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_unfreeze\(uuid, uuid, text\) TO service_role;/
    );
  });
  it('pages on a freeze through the operator alert path, and a failed page never costs the freeze', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_form_hand$')!;
    expect(r.raw).toMatch(
      /v_alert_id := public\.fn_raise_server_financial_alert\(\s+'critical', 'lightning_formation'/
    );
    expect(r.raw).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;/
    );
  });
  it('casts ca.request_id to uuid only when it is one', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_epoch$')!;
    expect(count(r.raw, /current_setting\('ca\.request_id', true\) ~\* '\^\[0-9a-f\]\{8\}/g)).toBe(
      2
    );
    expect(r.raw).not.toMatch(/nullif\(current_setting\('ca\.request_id', true\), ''\)::uuid/);
  });
});

describe('the re-cuts', () => {
  const expected = [
    'form_hand',
    'begin_dealing',
    'hand_player',
    'hand',
    'blind_order',
    'slots_sync',
    'instance_open',
    'releases',
    'commit',
    'begin',
    'open_table',
    'tick',
    'tick_all',
    'reap_conv',
    'epoch',
  ];
  it('re-cuts exactly the fifteen bodies it names, by asserted substitution', () => {
    expect(RECUTS.map((r) => r.tag.slice(7, -1)).sort()).toEqual([...expected].sort());
  });
  it.each(expected)(
    '%s counts its anchors, EXECUTEs, reads the catalogue back and skips a second application',
    (tag) => {
      const r = RECUTS.find((x) => x.tag === `$recut_${tag}$`)!;
      expect(r.code).toMatch(
        /\(length\(v_(new|src)\) - length\(replace\(v_(new|src), a(\[k\])?, ''\)\)\) \/ length\(a(\[k\])?\)/
      );
      expect(r.code).toMatch(/RAISE EXCEPTION '[^']*anchor/);
      expect(r.code).toMatch(/EXECUTE (v_new|replace\(v_src, a, b\))/);
      expect(r.code).toMatch(/pg_get_functiondef\((v_fn|to_regprocedure\(v_new_sig\))\)/);
      expect(r.code).toMatch(/RAISE NOTICE '[^']*leaving it alone'/);
    }
  );
  it('the commit reads hand_state_snapshots, not hand_history, and waits for every live lease to observe the halt', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_commit$')!;
    expect(r.raw).toContain('FROM public.hand_state_snapshots h');
    expect(r.raw).toContain('AND h.is_complete = false');
    expect(r.raw).toContain('JOIN public.engine_table_leases l ON l.table_id = tb.id');
    expect(r.raw).toContain('make_interval(secs => public.fn_engine_lease_stale_seconds())');
    expect(r.raw).toContain("'reason', 'halt_not_observed'");
    expect(r.raw).toContain('state, entered_at, starting_stack, anchor_seat_id)');
  });
  it('an impossible state is PLT02 and freezes; only the race classes and raced indexes are retried', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_form_hand$')!;
    expect(r.raw).toContain("USING ERRCODE = 'PLT02'");
    expect(r.raw).toContain("IF NOT (v_sqlstate IN ('55P03', '40P01', '40001')");
    expect(r.raw).toContain("SET cluster_mode = 'frozen'");
    for (const k of ['stack_invariant_failed', 'cluster_frozen', 'formation_invariant_failed'])
      expect(r.raw).toContain(`'${k}'`);
    for (const idx of [
      'lightning_reservation_one_active_per_player',
      'lightning_pool_slot_one_open_per_player',
      'lightning_hand_one_per_request',
    ]) {
      expect(r.raw).toContain(`'${idx}'`);
    }
  });
  it('the blind order ages a debt by debt_since and keeps the rest of the P2 key', () => {
    const r = RECUTS.find((x) => x.tag === '$recut_blind_order$')!;
    expect(r.raw).toContain('coalesce(bl.debt_since, sl.opened_at) ASC,');
    expect(r.raw).toMatch(/sl\\\.last_bb_at ASC NULLS FIRST/);
  });
});

describe('the laws', () => {
  it('Law 10.5: no code in any of the four files mentions is_horse', () => {
    for (const sql of ALL) expect(scan(sql).biz).not.toMatch(/is_horse/);
  });
  it('only the operator unfreeze and the two table_seats trigger functions run as their owner', () => {
    const definers = FUNCTIONS.filter((f) => /SECURITY DEFINER/.test(f.attrs))
      .map((f) => f.name)
      .sort();
    expect(definers).toEqual([
      'fn_cash_cluster_unfreeze',
      'fn_table_seats_lightning_anchor_guard',
      'fn_table_seats_lightning_pool_follows_seat',
    ]);
    for (const f of FUNCTIONS)
      expect(f.attrs, f.name).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });
  it('every function it writes out is revoked from the browser roles', () => {
    for (const f of FUNCTIONS) {
      expect(CODE, f.name).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${f.name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`
        )
      );
    }
  });
  it('revokes DELETE from service_role on all seven lightning tables and cash_cluster_conversion', () => {
    const m = /REVOKE DELETE ON ([\s\S]*?)\s+FROM service_role, anon, authenticated, PUBLIC;/.exec(
      CODE
    )!;
    const tables = m[1]
      .split(',')
      .map((t) => t.trim().replace('public.', ''))
      .sort();
    expect(tables).toEqual([
      'cash_cluster_conversion',
      'lightning_blind_ledger',
      'lightning_hand',
      'lightning_hand_player',
      'lightning_instance',
      'lightning_pool_session',
      'lightning_pool_slot',
      'lightning_reservation',
    ]);
    expect(CODE).toContain('REVOKE TRUNCATE ON public.cash_cluster_conversion FROM service_role');
  });
  it('never writes a stack', () => {
    for (const sql of ALL) expect(scan(sql).biz).not.toMatch(/SET\s+stack\s*=/);
  });
});

describe('the live proofs', () => {
  const proofs: string[] = ALL.flatMap((sql) => declaredProofs(sql));
  it('every file declares its own, at least thirty in all, each balanced', () => {
    for (const sql of ALL) expect(declaredProofs(sql).length).toBeGreaterThanOrEqual(1);
    expect(proofs.length).toBeGreaterThanOrEqual(30);
    for (const p of proofs) {
      const b = scan(p).biz;
      expect(count(b, /\(/g), p).toBe(count(b, /\)/g));
    }
  });
  it('are containment, never the exact size of a set a later file may grow', () => {
    for (const p of proofs) {
      expect(p, p).not.toMatch(/array_agg\([^)]*\)[^=]*= ARRAY\[/);
    }
  });
});

describe('the wiring', () => {
  it('the harness applies the real chain through all four files twice, in order, and counts twenty sections', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_R2_PORT:-55551}');
    for (const f of [FILE_A, FILE_B, FILE, FILE_D]) expect(HARNESS).toContain(f);
    expect(count(HARNESS, /-f "\$mine_a" -f "\$mine_b" -f "\$mine" -f "\$mine_d"/g)).toBe(2);
    expect(HARNESS).toContain('if [ "$oks" != 20 ]; then');
    expect([FILE_A, FILE_B, FILE, FILE_D]).toEqual([FILE_A, FILE_B, FILE, FILE_D].slice().sort());
  });
  it('CI runs the harness right after the Phase 9 formation step', () => {
    const p9 = CI.indexOf('- name: Lightning Phase 9 forms a hand atomically');
    const mine = CI.indexOf('run: bash scripts/dev/test-lightning-remediation-two.sh');
    expect(p9).toBeGreaterThan(0);
    expect(mine).toBeGreaterThan(p9);
    expect(CI.slice(p9, mine).match(/- name:/g)?.length).toBe(2);
  });
  it('the schema fragment names every function and column this file adds', () => {
    for (const f of [
      'fn_cash_table_observe_dealing_halt',
      'fn_lightning_pool_enter',
      'fn_lightning_player_in_hand',
      'fn_lightning_anchor_is_live_eligible',
      'fn_lightning_form_hand',
    ]) {
      expect(FRAGMENT.functions).toContain(f);
    }
    expect(FRAGMENT.columns.tables).toContain('dealing_halt_observed_at');
    expect(FRAGMENT.functions).toContain('fn_cash_cluster_unfreeze');
    expect(FRAGMENT.columns.lightning_pool_session).toContain('anchor_seat_id');
  });
  it('the changelog lists exactly the superseded proofs the harness proves false', () => {
    const list = /SUPERSEDED=\$\{LIGHTNING_R2_SUPERSEDED:-([^}]*)\}/
      .exec(HARNESS)![1]
      .trim()
      .split(/\s+/)
      .sort();
    for (const p of list) expect(CHANGELOG, p).toContain(p);
    expect(CHANGELOG).toMatch(/^## Corrections/m);
    expect(CHANGELOG).not.toContain('—');
  });
});
