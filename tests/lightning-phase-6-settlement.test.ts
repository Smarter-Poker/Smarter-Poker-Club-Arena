/**
 * LIGHTNING PHASE 6, THE DATABASE HALF OF DEALING: THE HAND IS NUMBERED, A
 * FOLD FREES A PLAYER AT ONCE, AND THE HAND SETTLES ONTO ITS ANCHORS THROUGH
 * THE PHYSICAL SETTLEMENT PATH.
 *
 * A static reading of ONE migration, 20261001154813. The harness
 * scripts/dev/test-lightning-phase6-settlement.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, the exact contract the engine and client are built
 * against, that every change to an existing body is an asserted substitution,
 * that the settlement moves chips only through the physical door, and that the
 * forgeable setting is gone from code rather than from prose.
 *
 * LIGHTNING_P6S_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql';
const MIGRATION =
  process.env.LIGHTNING_P6S_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase6-settlement.sh');
const FIXTURE = read('scripts', 'dev', 'fixtures', 'lightning-phase6-settlement-fixture.sql');
const CHANGELOG = read('docs', 'changelog', '2026-10-01-lightning-phase-6-settlement.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase6-settlement.json')
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

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('adds one column per ALTER, guards every constraint, and never touches tables or table_seats', () => {
    const adds = (CODE.match(/^ALTER TABLE .*$/gm) ?? []).filter((l) => l.includes(' ADD '));
    expect(adds.length).toBe(9);
    for (const line of adds) {
      expect(count(line, /ADD COLUMN/g), line).toBe(1);
    }
    expect(count(CODE, /ADD CONSTRAINT/g)).toBe(
      count(CODE, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)
    );
    expect(CODE).not.toMatch(/ALTER TABLE public\.(tables|table_seats)\b/);
    expect(CODE).not.toMatch(/CREATE (CONSTRAINT )?TRIGGER/);
    expect(CODE).not.toMatch(/\bREFERENCES\b|FOREIGN KEY/);
  });
});

describe('the contract the engine and the client are built against', () => {
  it.each([
    ['fn_lightning_bind_hand_number', 'p_instance_id uuid, p_hand_number bigint)\nRETURNS jsonb'],
    [
      'fn_lightning_fast_fold',
      'p_hand_id uuid, p_player_id uuid, p_request_id uuid,\n                                                         p_fold_type text, p_committed numeric DEFAULT NULL)\nRETURNS jsonb',
    ],
    [
      'fn_lightning_settle_hand',
      'p_hand_id uuid, p_request_id uuid, p_host_table_id uuid,\n                                                           p_lease_instance text, p_lease_generation uuid,\n                                                           p_results jsonb, p_rake numeric, p_bbj numeric,\n                                                           p_hand_row jsonb)\nRETURNS jsonb',
    ],
    ['fn_lightning_my_session', 'p_cluster_id uuid)\nRETURNS jsonb'],
    ['fn_lightning_hand_view_access', 'p_pool_session_id uuid, p_user_id uuid)\nRETURNS boolean'],
  ])('%s', (name, signature) => {
    expect(SQL).toContain(`CREATE OR REPLACE FUNCTION public.${name}(${signature}`);
  });
  it('the settlement answers the keys the engine reads, and the session never an instance id', () => {
    const settle = fn('fn_lightning_settle_hand');
    for (const k of [
      "'hand_id'",
      "'hand_history_id'",
      "'hand_number'",
      "'deltas'",
      "'receipt_hash'",
    ]) {
      expect(settle, k).toContain(k);
    }
    const mine = fn('fn_lightning_my_session');
    for (const k of [
      "'pool_session_id'",
      "'state'",
      "'cluster_mode'",
      "'stack'",
      "'in_hand'",
      "'hand_id'",
    ]) {
      expect(mine, k).toContain(k);
    }
    expect(mine).not.toContain("'instance_id'");
    expect(mine).toContain('auth.uid()');
  });
  it('the fold accepts exactly three types and emits exactly three events', () => {
    const fold = fn('fn_lightning_fast_fold');
    expect(fold).toContain("p_fold_type NOT IN ('fast', 'normal', 'fold_watch')");
    expect(fold).toContain(
      "CASE p_fold_type WHEN 'fast' THEN 'fast_fold' WHEN 'normal' THEN 'normal_fold' ELSE 'fold_and_watch' END"
    );
    expect(fold).toContain("IF p_fold_type IN ('fast', 'normal') THEN");
  });
});

describe('the settlement', () => {
  const settle = () => fn('fn_lightning_settle_hand');
  it('runs as its owner and reaches the chips only through the unchanged physical door', () => {
    expect(settle()).toMatch(
      /LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'/
    );
    expect(count(settle(), /public\.fn_ca_commit_hand_settlement\(/g)).toBe(1);
    expect(CODE).not.toMatch(/UPDATE public\.table_seats/);
    expect(CODE).not.toMatch(/fn_ca_settle_hand_stacks_absolute\(p_/);
  });
  it('locks the instance first, the anchors FOR UPDATE in player order, and writes a marker for each', () => {
    const s = settle();
    expect(s.indexOf('WHERE li.id = v_instance FOR UPDATE')).toBeGreaterThan(0);
    expect(s.indexOf('WHERE li.id = v_instance FOR UPDATE')).toBeLessThan(
      s.indexOf('FROM public.table_seats ts WHERE ts.id = a.seat_id FOR UPDATE')
    );
    expect(s).toContain("ORDER BY (x ->> 'player_id')::uuid LOOP");
    expect(s).toContain('INSERT INTO public.lightning_settlement_marker');
    expect(s).toContain(
      'DELETE FROM public.lightning_settlement_marker m WHERE m.txid = pg_current_xact_id()'
    );
  });
  it('checks conservation and freezes, never raises, on a disagreement', () => {
    const s = settle();
    expect(s).toContain(
      'WHEN round(v_before, 2) IS DISTINCT FROM round(v_after + v_rake + v_bbj, 2)'
    );
    expect(count(s, /fn_lightning_settlement_freeze\(/g)).toBe(2);
    const freeze = fn('fn_lightning_settlement_freeze');
    for (const w of [
      "'stack_invariant_failed'",
      "'cluster_frozen'",
      "SET cluster_mode = 'frozen'",
      'fn_raise_server_financial_alert(',
    ]) {
      expect(freeze, w).toContain(w);
    }
    expect(freeze).not.toMatch(/RAISE EXCEPTION/);
  });
  it('replays the stored receipt for the same request, refuses an abandoned instance and a stale lease', () => {
    const s = settle();
    expect(s).toContain(
      "RETURN h.settle_receipt || jsonb_build_object('ok', true, 'replay', true);"
    );
    expect(s).toContain("'reason', 'instance_abandoned'");
    expect(s).toContain("'reason', 'hand_lease_lost'");
    expect(s).toContain("'reason', 'hand_lease_stale'");
  });
});

describe('the substitutions', () => {
  it('every change to an existing body is asserted anchor by anchor and left alone once made', () => {
    const blocks = SQL.match(/DO \$sub_[a-z_]+\$[\s\S]*?\$sub_[a-z_]+\$;/g) ?? [];
    expect(blocks.map((b) => b.match(/v_sig constant text := '([^']+)'/)?.[1])).toEqual([
      'public.fn_lightning_pool_stack(uuid)',
      'public.fn_table_seats_lightning_anchor_guard()',
      'public.fn_lightning_hand_is_immutable()',
      'public.fn_lightning_hand_player_is_immutable()',
      'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)',
      'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)',
    ]);
    for (const b of blocks) {
      expect(b).toContain('refusing to substitute blind');
      expect(b).toContain('v_src := pg_get_functiondef(v_sig::regprocedure);');
      expect(b).toContain('EXECUTE v_new;');
      expect(b).toMatch(/IF position\('[^']+' in v_src\) = 0 THEN/);
    }
  });
  it('the physical adapter compares to p_table_id unless this transaction marked the anchor', () => {
    expect(SQL).toContain('c integer[] := ARRAY[1, 1, 1, 2, 1];');
    expect(SQL).toContain('c integer[] := ARRAY[1, 1, 3];');
    // Three replacement texts; the second lands on both exact stack writes.
    expect(
      count(
        SQL,
        /ts\.table_id = COALESCE\(\(v_lightning_seats->>v_uid::text\)::uuid, p_table_id\)/g
      )
    ).toBe(3);
    expect(SQL).toContain('IS DISTINCT FROM 4');
    expect(
      count(
        SQL,
        /WHERE s\.table_id = COALESCE\(\(v_lightning_seats->>\(v_item->>'user_id'\)\)::uuid, p_table_id\)/g
      )
    ).toBe(1);
    expect(fn('fn_lightning_settlement_seats')).toContain(
      'm.txid = pg_current_xact_id_if_assigned()'
    );
  });
  it('the guard reads the marker and no setting', () => {
    const guard = SQL.slice(SQL.indexOf('DO $sub_guard$'), SQL.indexOf('$sub_guard$;'));
    const replacement = guard.slice(
      guard.indexOf('b text[] := ARRAY['),
      guard.indexOf('c integer[]')
    );
    expect(replacement).toContain('FROM public.lightning_settlement_marker m');
    expect(replacement).toContain('m.txid = pg_current_xact_id_if_assigned()');
    expect(replacement).toContain('NEW.left_at IS NOT DISTINCT FROM OLD.left_at');
    expect(replacement).not.toContain('current_setting');
    expect(guard).toContain("position('current_setting' in v_src) > 0");
  });
});

describe('authority and law', () => {
  it('the marker belongs to no role', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON TABLE public.lightning_settlement_marker FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(SQL).toContain(
      'ALTER TABLE public.lightning_settlement_marker ENABLE ROW LEVEL SECURITY;'
    );
    expect(CODE).not.toMatch(/GRANT [A-Z, ]+ ON TABLE public\.lightning_settlement_marker/);
  });
  it('anon executes nothing, and authenticated only its own session reader', () => {
    const grants = CODE.match(/^GRANT EXECUTE ON FUNCTION .*$/gm) ?? [];
    expect(grants.length).toBe(9);
    for (const g of grants) {
      expect(g).not.toContain('anon');
      if (g.includes('authenticated')) expect(g).toContain('fn_lightning_my_session(uuid)');
    }
    expect(count(CODE, /^REVOKE ALL ON FUNCTION [^;]+FROM PUBLIC, anon/gm)).toBe(9);
  });
  it('Law 10.5: no code in the file mentions is_horse or horse_id', () => {
    expect(CODE).not.toMatch(/is_horse|horse_id/);
  });
  it('declares at least ten balanced @live-proof containment checks', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBeGreaterThanOrEqual(10);
    for (const p of proofs) expect(count(p, /\(/g), p).toBe(count(p, /\)/g));
  });
});

describe('the proof around it', () => {
  it('the harness applies the real chain through this file twice on its own port and counts twenty-two sections', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_P6S_PORT:-55553}');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('-f "$p6_fixture" -f "$p6" -f "$s6_fixture"');
    expect(count(HARNESS, /-f "\$mine"/g)).toBe(2);
    expect(HARNESS).toContain('if [ "$oks" != 22 ]; then');
    expect(HARNESS).toContain(
      "IF v_bad IS DISTINCT FROM 'p9#28 true->false, p9#30 true->false, p9r#31 true->false, p9r#32 true->false, r2c#9 true->false' THEN"
    );
  });
  it('the fixture carries the physical path as production bodies and reads no horse', () => {
    for (const f of [
      'public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint',
      'public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint',
      'public.fn_ca_process_hand_post_commit_obligations(p_hand_id uuid)',
    ]) {
      expect(FIXTURE, f).toContain(`CREATE OR REPLACE FUNCTION ${f}`);
    }
    expect(FIXTURE.replace(/--.*$/gm, '')).not.toMatch(/is_horse|horse_id/);
  });
  it('CI runs the harness right after the matcher step, on the same shard', () => {
    const matcher = CI.indexOf('run: bash scripts/dev/test-lightning-phase6-matcher.sh');
    const mine = CI.indexOf('run: bash scripts/dev/test-lightning-phase6-settlement.sh');
    expect(matcher).toBeGreaterThan(0);
    expect(mine).toBeGreaterThan(matcher);
    const step = CI.slice(matcher, mine);
    expect(step.match(/- name:/g)?.length).toBe(1);
    expect(step).toContain('if: matrix.shard == 1');
  });
  it('the schema fragment names every function, the table and the columns this file adds', () => {
    for (const f of [
      'fn_lightning_bind_hand_number',
      'fn_lightning_fast_fold',
      'fn_lightning_settle_hand',
      'fn_lightning_my_session',
      'fn_lightning_hand_view_access',
      'fn_lightning_pool_exposure',
      'fn_lightning_player_live_hand',
      'fn_lightning_settlement_seats',
      'fn_lightning_settlement_freeze',
    ]) {
      expect(FRAGMENT.functions, f).toContain(f);
    }
    expect(FRAGMENT.tables).toContain('lightning_settlement_marker');
    expect(FRAGMENT.columns.lightning_hand).toContain('hand_number');
    expect(FRAGMENT.columns.lightning_hand_player).toContain('committed_at_fold');
  });
  it('the changelog names the superseded proofs, uses title case headings and no em dash', () => {
    for (const p of ['r2c#9', 'p9#28', 'p9#30', 'p9r#31', 'p9r#32'])
      expect(CHANGELOG, p).toContain(p);
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

/**
 * THE REMEDIATION, 20261001201216: the freeze freezes from every live mode, a
 * frozen Cluster settles nothing, the session names its anchor seat, and the
 * matcher forms nothing the host cannot deal. The same harness proves it on
 * the same estate (sections 14 to 21); this reads what a catalogue cannot.
 */
describe('the remediation, 20261001201216', () => {
  const FIX_FILE =
    '20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql';
  const FIX = fs.readFileSync(
    process.env.LIGHTNING_P6R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FIX_FILE),
    'utf8'
  );
  const FIX_CODE = FIX.split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  const FIX_LOG = read('docs', 'changelog', '2026-10-01-lightning-phase-6-remediation.md');
  const HOST = read('server', 'src', 'lightning', 'LightningHandHost.ts');
  /** One substitution block: its anchors, its replacements, its idempotency marker. */
  function sub(tag: string) {
    const start = FIX.indexOf(`DO $${tag}$`);
    expect(start, tag).toBeGreaterThan(0);
    const body = FIX.slice(start, FIX.indexOf(`$${tag}$;`, start + tag.length + 4));
    const a = [...body.slice(0, body.indexOf('b text[]')).matchAll(/\$a\$([\s\S]*?)\$a\$/g)].map(
      (m) => m[1]
    );
    const b = [...body.slice(body.indexOf('b text[]')).matchAll(/\$b\$([\s\S]*?)\$b\$/g)].map(
      (m) => m[1]
    );
    return { body, a, b };
  }

  it('is one BEGIN and one COMMIT with a lock wait, and creates, grants and alters nothing', () => {
    expect(count(FIX_CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(FIX_CODE, /^COMMIT;$/gm)).toBe(1);
    expect(FIX_CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(FIX_CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
    expect(FIX_CODE).not.toMatch(
      /\b(GRANT|REVOKE)\b|CREATE (TABLE|INDEX|TRIGGER)|ALTER TABLE|CREATE OR REPLACE FUNCTION/
    );
    expect(FIX_CODE).not.toContain('fn_table_seats_lightning_anchor_guard');
  });
  it.each([
    ['sub_freeze', 'fn_lightning_settlement_freeze', "'already_frozen'", 1],
    ['sub_settle', 'fn_lightning_settle_hand', "'cluster_frozen'", 2],
    ['sub_session', 'fn_lightning_my_session', "'occupancy_id'", 2],
    ['sub_plan', 'fn_lightning_match_plan', "'VARIANT_NOT_SUPPORTED'", 2],
    ['sub_form', 'fn_lightning_match_and_form', "'cluster_has_no_front_table'", 2],
  ])(
    '%s substitutes %s anchor by anchor, refuses a blind one and is left alone once made',
    (tag, name, marker, n) => {
      const { body, a, b } = sub(tag);
      expect(body).toContain(`'public.${name}(`);
      expect(a.length).toBe(n);
      expect(b.length).toBe(n);
      expect(body).toContain(`IF position('${marker.replace(/'/g, "''")}' in v_src) = 0 THEN`);
      expect(body).toContain('refusing to substitute blind');
      expect(body).toContain(`c integer[] := ARRAY[${Array(n).fill(1).join(', ')}];`);
      expect(b.join('')).toContain(marker);
      expect(a.join('')).not.toContain(marker);
    }
  );
  it('the freeze freezes from any mode but frozen and dead, records from_mode, and says frozen only when it is', () => {
    const { a, b } = sub('sub_freeze');
    expect(a[0]).toContain("cg.cluster_mode = 'lightning'");
    expect(a[0]).toContain("'from_mode', 'lightning'");
    expect(b[0]).not.toContain("cg.cluster_mode = 'lightning'");
    expect(b[0]).toContain('WHERE cg.id = p_cluster_id FOR UPDATE;');
    expect(b[0]).toContain("cg.cluster_mode NOT IN ('frozen', 'dead')");
    expect(b[0]).toContain("'from_mode', v_from");
    expect(b[0]).toContain("'frozen', v_froze OR v_from IS NOT DISTINCT FROM 'frozen'");
    expect(b[0]).toContain("'already_frozen', v_from IS NOT DISTINCT FROM 'frozen'");
    expect(b[0]).toMatch(
      /IF v_froze THEN\s+BEGIN\s+v_alert_id := public\.fn_raise_server_financial_alert/
    );
    expect(b[0]).toMatch(
      /IF v_froze THEN\s+INSERT INTO public\.cash_cluster_events[\s\S]*'cluster_frozen'/
    );
  });
  it('a frozen Cluster is refused right after the instance is found dealing, before any write', () => {
    const { a, b } = sub('sub_settle');
    expect(a[1]).toContain("'instance_not_dealing'");
    expect(b[1].startsWith(a[1])).toBe(true);
    const added = b[1].slice(a[1].length).replace(/--.*$/gm, '');
    expect(added).toContain("IF v_mode IS NOT DISTINCT FROM 'frozen' THEN");
    expect(added).toContain("'reason', 'cluster_frozen', 'retry', false");
    expect(added).not.toMatch(/\b(INSERT|UPDATE|DELETE|PERFORM)\b|FOR (UPDATE|SHARE)/);
  });
  it('the engine abandons on a refusal that is not frozen, so cluster_frozen ends the hand', () => {
    expect(HOST).toContain('if (out.frozen) {');
    expect(HOST).toContain('return void (await this.abandon(`settlement_refused:${out.reason}`));');
  });
  it('the session keeps every key and adds the anchor table, seat number and occupancy id', () => {
    const { b } = sub('sub_session');
    expect(b[0]).toContain('LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id');
    expect(b[0]).toContain('ts.table_id AS anchor_table_id, ts.seat_number, ts.occupancy_id');
    expect(b[1]).toContain("'in_hand', v_hand IS NOT NULL,");
    for (const k of [
      "'anchor_table_id', s.anchor_table_id",
      "'seat_number', s.seat_number",
      "'occupancy_id', s.occupancy_id",
    ])
      expect(b[1], k).toContain(k);
    expect(b.join('')).not.toContain("'instance_id'");
  });
  it('the matcher refuses pineapple with a diagnosis, and match_and_form refuses it and a missing front table up front', () => {
    const plan = sub('sub_plan').b[1];
    expect(plan).toContain("WHEN cg.variant = 'pineapple'");
    expect(plan).toContain("WHEN tb.game_variant = 'pineapple'");
    expect(plan).toContain("WHEN coalesce(tb.pineapple_holdem, false) THEN 'pineapple_holdem'");
    expect(plan).toContain("'state', 'BLOCKED_WITH_REASON'");
    expect(plan).toContain("'reason_code', 'VARIANT_NOT_SUPPORTED'");
    expect(plan).toContain(
      "'groups', '[]'::jsonb, 'refused', true, 'reason', 'variant_not_supported'"
    );
    const form = sub('sub_form').b[1];
    expect(form).toContain('IF public.fn_cash_cluster_front_table(p_cluster_id) IS NULL THEN');
    expect(form).toContain("'reason', 'cluster_has_no_front_table'");
    expect(form).toContain("'reason', 'variant_not_supported'");
    expect(form.indexOf("'cluster_has_no_front_table'")).toBeLessThan(
      form.indexOf("'variant_not_supported'")
    );
  });
  it('Law 10.5: no code mentions is_horse or horse_id, and it declares at least eight balanced proofs', () => {
    expect(FIX_CODE).not.toMatch(/is_horse|horse_id/);
    const proofs: string[] = declaredProofs(FIX);
    expect(proofs.length).toBeGreaterThanOrEqual(8);
    for (const p of proofs) expect(count(p, /\(/g), p).toBe(count(p, /\)/g));
  });
  it('the harness applies it twice after the Phase 6 file and proves it in eight sections', () => {
    expect(HARNESS).toContain(FIX_FILE);
    expect(HARNESS).toContain('LIGHTNING_P6R_MIGRATION');
    expect(count(HARNESS, /-f "\$fix"/g)).toBe(2);
    expect(HARNESS.indexOf('-f "$fixture/reapply.sql"')).toBeLessThan(HARNESS.indexOf('-f "$fix"'));
    for (const n of ['14', '15', '16', '17', '18', '19', '20', '21'])
      expect(HARNESS, n).toMatch(new RegExp(`\\\\echo '  ok  ${n} `));
  });
  it('the changelog uses title case headings and no em dash', () => {
    expect(FIX_LOG).toContain('20261001201216');
    expect(FIX_LOG).not.toContain('\u2014');
    for (const h of FIX_LOG.match(/^#{1,3} .+$/gm) ?? []) {
      const words = h
        .replace(/^#+ /, '')
        .replace(/`[^`]*`/g, '')
        .split(/\s+/)
        .filter((w) => /^[a-z]/.test(w));
      expect(words, h).toEqual([]);
    }
  });
});
