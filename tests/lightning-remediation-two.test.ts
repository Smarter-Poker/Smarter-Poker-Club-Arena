/**
 * LIGHTNING PHASES 5 AND 9, REMEDIATION TWO: THE SEAT IS THE ANCHOR, THE POOL
 * FOLLOWS IT, AND A HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT.
 *
 * A static reading of ONE migration, 20260926045132. The harness
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
const FILE = '20260926045132_lightning_phase_5_and_9_remediation_two_the_seat_is_the_anch.sql';
const MIGRATION = process.env.LIGHTNING_R2_MIGRATION ?? path.join(MIGRATIONS, FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
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

describe('the transaction and its locks', () => {
  it('is one BEGIN and one COMMIT, the COMMIT last', () => {
    expect(count(BIZ, /^BEGIN;$/gm)).toBe(1);
    expect(count(BIZ, /^COMMIT;$/gm)).toBe(1);
    expect(BIZ.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
  it('sets an eight-second lock_timeout before its first DDL', () => {
    const lt = CODE.indexOf("SET LOCAL lock_timeout = '8s';");
    const firstAlter = CODE.search(/^ALTER TABLE/m);
    expect(lt).toBeGreaterThan(CODE.indexOf('BEGIN;'));
    expect(lt).toBeLessThan(firstAlter);
  });
  it('touches table_seats, tables and cash_cluster_events only after every re-cut, under a tighter wait', () => {
    const hot = CODE.indexOf("SET LOCAL lock_timeout = '3s';");
    const lastRecut = Math.max(...RECUTS.map((r) => SQL.indexOf(`DO ${r.tag}`)));
    expect(hot).toBeGreaterThan(0);
    expect(SQL.indexOf("SET LOCAL lock_timeout = '3s';")).toBeGreaterThan(lastRecut);
    for (const re of [
      /ALTER TABLE public\.tables ADD COLUMN/,
      /ALTER TABLE public\.cash_cluster_events ADD COLUMN/,
      /CREATE TRIGGER trg_table_seats_lightning_anchor_guard/,
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert/,
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat/,
      /REFERENCES public\.table_seats\(id\)/,
    ]) {
      const at = CODE.search(re);
      expect(at, String(re)).toBeGreaterThan(CODE.indexOf("SET LOCAL lock_timeout = '3s';"));
    }
  });
  it('adds one column per ALTER TABLE', () => {
    for (const m of BIZ.matchAll(/^ALTER TABLE[^;]*;/gm)) {
      expect(count(m[0], /ADD COLUMN/g), m[0]).toBeLessThanOrEqual(1);
    }
  });
  it('guards every ADD CONSTRAINT and CREATE TRIGGER so the file is re-appliable', () => {
    for (const m of CODE.matchAll(/(ADD CONSTRAINT|CREATE (?:CONSTRAINT )?TRIGGER) (\w+)/g)) {
      const before = CODE.slice(0, m.index);
      const guard = before.lastIndexOf('IF NOT EXISTS (');
      expect(guard, m[2]).toBeGreaterThan(0);
      expect(before.slice(guard), m[2]).toContain(`'${m[2]}'`);
    }
    expect(count(CODE, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/g)).toBe(0);
  });
  it('creates no temporary table, which the break-window guard counts as DDL', () => {
    expect(BIZ).not.toMatch(/CREATE\s+TEMP/i);
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
      /CREATE TRIGGER trg_table_seats_lightning_anchor_guard([\s\S]*?)EXECUTE FUNCTION/.exec(CODE);
    expect(m).toBeTruthy();
    expect(flat(m![1])).toContain(
      'WHEN (OLD.stack IS DISTINCT FROM NEW.stack OR OLD.left_at IS DISTINCT FROM NEW.left_at OR OLD.user_id IS DISTINCT FROM NEW.user_id)'
    );
    expect(flat(m![1])).toMatch(/^BEFORE UPDATE ON public\.table_seats FOR EACH ROW/);
  });
  it('the pool triggers are deferred and their WHEN clauses leave an ordinary stack update alone', () => {
    const upd =
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat([\s\S]*?)EXECUTE FUNCTION/.exec(
        CODE
      )!;
    const ins =
      /CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert([\s\S]*?)EXECUTE FUNCTION/.exec(
        CODE
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
  it('declares all three table_seats triggers in the money-trigger register', () => {
    const m =
      /INSERT INTO public\.ca_declared_money_triggers[\s\S]*?ON CONFLICT \(table_name, trigger_name\) DO NOTHING;/.exec(
        CODE
      );
    expect(m).toBeTruthy();
    for (const t of [
      'trg_table_seats_lightning_anchor_guard',
      'trg_table_seats_lightning_pool_on_insert',
      'trg_table_seats_lightning_pool_follows_seat',
    ]) {
      expect(m![0]).toContain(`'${t}'`);
    }
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
  it('Law 10.5: no code in the file mentions is_horse', () => {
    expect(BIZ).not.toMatch(/is_horse/);
  });
  it('only the two table_seats trigger functions run as their owner', () => {
    const definers = FUNCTIONS.filter((f) => /SECURITY DEFINER/.test(f.attrs))
      .map((f) => f.name)
      .sort();
    expect(definers).toEqual([
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
    expect(BIZ).not.toMatch(/SET\s+stack\s*=/);
  });
});

describe('the live proofs', () => {
  const proofs: string[] = declaredProofs(SQL);
  it('declares at least twenty-five, each balanced', () => {
    expect(proofs.length).toBeGreaterThanOrEqual(25);
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
  it('the harness applies the real chain through this file twice and counts seventeen sections', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_R2_PORT:-55551}');
    expect(HARNESS).toContain(FILE);
    expect(count(HARNESS, /-f "\$mine"/g)).toBe(2);
    expect(HARNESS).toContain('if [ "$oks" != 17 ]; then');
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
