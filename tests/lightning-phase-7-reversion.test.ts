/**
 * LIGHTNING PHASE 7 (SPECIFICATION PHASE 10): THE POOL REVERTS TO MUST-MOVE,
 * AND THE CLUSTER TICK DRIVES BOTH CONVERSIONS.
 *
 * A static reading of ONE migration, 20261001222856. The harness
 * scripts/dev/test-lightning-phase7-reversion.sh proves every claim against a
 * running catalogue and estate; this file proves what a catalogue cannot see:
 * the transaction shape, the contract the engine and client are built
 * against, that every change to an existing body is an asserted substitution,
 * that the reversion moves no chip, and that horses are never singled out.
 *
 * LIGHTNING_P7_MIGRATION overrides the file under test, for mutation testing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const FILE = '20261001222856_lightning_phase_7_the_pool_reverts_to_must_move_and_the_tick.sql';
const REM_FILE = '20261007222717_lightning_phase_7_remediation_the_reversion_review_findings_.sql';
const MIGRATION =
  process.env.LIGHTNING_P7_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', FILE);
const REM_MIGRATION =
  process.env.LIGHTNING_P7R_MIGRATION ?? path.join(ROOT, 'supabase', 'migrations', REM_FILE);
const SQL = fs.readFileSync(MIGRATION, 'utf8');
const REM = fs.readFileSync(REM_MIGRATION, 'utf8');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HARNESS = read('scripts', 'dev', 'test-lightning-phase7-reversion.sh');
const CHANGELOG = read('docs', 'changelog', '2026-10-02-lightning-phase-7-reversion.md');
const REMLOG = read('docs', 'changelog', '2026-10-07-lightning-phase-7-remediation.md');
const CI = read('.github', 'workflows', 'ci.yml');
const FRAGMENT = JSON.parse(
  read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase7-reversion.json')
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

/** One DO block of an asserted substitution, by its dollar tag. */
function sub(tag: string): string {
  const start = SQL.indexOf(`DO $${tag}$`);
  expect(start, tag).toBeGreaterThan(0);
  return SQL.slice(start, SQL.indexOf(`$${tag}$;`, start + tag.length + 4));
}

const NEW = [
  'fn_cash_cluster_begin_pending_off',
  'fn_cash_cluster_abort_pending_off',
  'fn_cash_cluster_commit_must_move',
  'fn_cash_cluster_lightning_drive',
];

describe('the transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(CODE, /^COMMIT;$/gm)).toBe(1);
    expect(CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('creates and alters no table, adds no trigger, and locks neither tables nor table_seats', () => {
    expect(CODE).not.toMatch(/\b(CREATE|ALTER|DROP) TABLE\b/);
    expect(CODE).not.toMatch(/CREATE (CONSTRAINT )?TRIGGER/);
    expect(CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(CODE).not.toMatch(/DROP FUNCTION/);
  });
});

describe('the contract the engine and the client are built against', () => {
  it.each([
    [
      'fn_cash_cluster_begin_pending_off',
      /\(p_game_id uuid,\s+p_request_id uuid DEFAULT gen_random_uuid\(\),\s+p_reason text DEFAULT NULL\)\nRETURNS jsonb/,
    ],
    [
      'fn_cash_cluster_abort_pending_off',
      /\(p_game_id uuid, p_request_id uuid,\s+p_reason text DEFAULT 'population_rose_above_off_threshold'\)\nRETURNS jsonb/,
    ],
    ['fn_cash_cluster_commit_must_move', /\(p_game_id uuid, p_request_id uuid\)\nRETURNS jsonb/],
    ['fn_cash_cluster_lightning_drive', /\(p_game_id uuid\)\nRETURNS jsonb/],
  ])('%s keeps its signature, so (game, request) is enough to call it', (name, sig) => {
    expect(fn(name)).toMatch(sig);
  });
  it.each(NEW)(
    '%s is SECURITY DEFINER with a pinned search_path and is executable by service_role alone',
    (name) => {
      expect(fn(name)).toMatch(/SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'/);
      expect(CODE).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`
        )
      );
      expect(CODE).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`)
      );
      expect(CODE).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO (anon|authenticated)`)
      );
    }
  );
  it('begin_pending_off moves only from lightning, records the conversion with both thresholds and emits lightning_pending_off', () => {
    const b = fnCode('fn_cash_cluster_begin_pending_off');
    expect(b).toMatch(/IF g\.cluster_mode IS DISTINCT FROM 'lightning' THEN/);
    expect(b).toMatch(/'wrong_state'/);
    expect(b).toMatch(/SET cluster_mode = 'pending_off'/);
    expect(b).toMatch(/'lightning_disabled'/);
    expect(b).toMatch(/would_turn_off/);
    expect(b).toMatch(
      /from_mode, to_mode, trigger_population,\s+on_threshold, off_threshold, epoch_before, chips_at_begin/
    );
    expect(b).toMatch(/'lightning', 'must_move'/);
    expect(b).toMatch(/'lightning_pending_off'/);
    expect(b).toMatch(/FOR UPDATE/);
  });
  it('begin_pending_off is idempotent on its request id, before and under the Cluster lock', () => {
    const b = fnCode('fn_cash_cluster_begin_pending_off');
    expect(count(b, /WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id/g)).toBe(
      2
    );
    expect(b).toMatch(/'already_known'/);
    expect(b).toMatch(/'already_committed'/);
    expect(b).toMatch(/'request_id_belongs_to_another_conversion'/);
  });
  it('the drain voids only formations not yet dealt, through the existing abandon door, and keeps a dealing hand', () => {
    const b = fnCode('fn_cash_cluster_begin_pending_off');
    expect(b).toMatch(/li\.state IN \('forming', 'reserved'\)/);
    expect(b).toMatch(/fn_lightning_instance_abandon\(i\.id/);
    expect(b).toMatch(/li\.state IN \('dealing', 'settling'\)/);
  });
  it('abort_pending_off returns to lightning only while enabled and enters whoever sat down during the drain', () => {
    const a = fnCode('fn_cash_cluster_abort_pending_off');
    expect(a).toMatch(/IF g\.cluster_mode IS DISTINCT FROM 'pending_off' THEN/);
    expect(a).toMatch(
      /coalesce\(g\.lightning_enabled, false\) = false OR g\.enabled IS DISTINCT FROM true/
    );
    expect(a).toMatch(/SET cluster_mode = 'lightning'/);
    expect(a).toMatch(/fn_lightning_pool_enter\(s\.id/);
    expect(a).toMatch(/SET status = 'aborted'/);
    expect(a).toMatch(/'lightning_pending_off_aborted'/);
  });
});

describe('the commit moves no chip', () => {
  const c = () => fnCode('fn_cash_cluster_commit_must_move');
  it('answers a structured not-ready while any instance is live, and cancels itself above OFF while enabled', () => {
    expect(c()).toMatch(/li\.state IN \('forming', 'reserved', 'dealing', 'settling'\)/);
    expect(c()).toMatch(/'ready', false,\s+'reason', 'instances_in_flight'/);
    expect(c()).toMatch(/v_live > v_off THEN\s+RETURN public\.fn_cash_cluster_abort_pending_off/);
    expect(c()).toMatch(/IF g\.cluster_mode IS DISTINCT FROM 'pending_off' THEN/);
    expect(c()).toMatch(/'already_committed'/);
  });
  it('takes the same md5 of every seat, cash session and blind ledger row before and after, and refuses on any difference', () => {
    const body = c();
    expect(count(body, /'ts:' \|\| to_jsonb\(ts\)::text/g)).toBe(2);
    expect(count(body, /'cps:' \|\| to_jsonb\(s\)::text/g)).toBe(2);
    expect(count(body, /'bl:' \|\| to_jsonb\(bl\)::text/g)).toBe(2);
    expect(body).toMatch(
      /IF v_after IS DISTINCT FROM v_before THEN\s+RAISE EXCEPTION 'LIGHTNING_REVERSION_MOVED_MONEY/
    );
  });
  it('writes no seat, cash session, blind ledger, wallet or roster row', () => {
    for (const t of [
      'table_seats',
      'cash_player_session',
      'lightning_blind_ledger',
      'club_members',
      'cash_game_roster',
      'chip_ledger',
    ])
      expect(c(), t).not.toMatch(new RegExp(`(UPDATE|INSERT INTO|DELETE FROM) public\\.${t}\\b`));
  });
  it('exits every pool session with lightning_off, closes slots, expires reservations and logs one pool_player_left each', () => {
    const body = c();
    expect(body).toMatch(/exit_reason = 'lightning_off'/);
    expect(body).toMatch(/WHERE ps\.cluster_id = g\.id AND ps\.exited_at IS NULL/);
    expect(body).toMatch(/UPDATE public\.lightning_pool_slot sl\s+SET closed_at/);
    expect(body).toMatch(/SET state = 'expired'/);
    expect(body).toMatch(/'pool_player_left'/);
    expect(body).toMatch(/LIGHTNING_REVERSION_LOST_AN_EVENT/);
    expect(body).toMatch(/LIGHTNING_REVERSION_LEFT_A_POOL_SESSION_OPEN/);
  });
  it('opens the next epoch in must_move and lifts only the halt Lightning placed, with its acknowledgement', () => {
    const body = c();
    expect(body).toMatch(/set_config\('ca\.epoch_reason', 'lightning_off', true\)/);
    expect(body).toMatch(/SET cluster_mode = 'must_move', cluster_epoch = v_epoch/);
    expect(body).toMatch(
      /SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL\s+WHERE tb\.cluster_id = g\.id AND tb\.dealing_halted_reason IN \('lightning', 'lightning_pending_on'\)/
    );
    expect(body).toMatch(/chips_at_commit = v_chips/);
    expect(body).toMatch(/'lightning_off'/);
  });
  it('is gated on the platform freeze, while beginning the drain never is', () => {
    expect(c()).toMatch(/IF public\.fn_platform_frozen\(\) THEN/);
    expect(fnCode('fn_cash_cluster_begin_pending_off')).not.toMatch(/fn_platform_frozen/);
  });
});

describe('the drive and the tick', () => {
  const d = () => fnCode('fn_cash_cluster_lightning_drive');
  it('runs both directions from the one population reader with hysteresis', () => {
    const body = d();
    expect(body).toMatch(/fn_cash_cluster_lightning_state\(g\.id\)/);
    expect(body).toMatch(/would_turn_on/);
    expect(body).toMatch(/would_turn_off/);
    for (const call of [
      'fn_cash_cluster_begin_pending_on',
      'fn_cash_cluster_abort_pending_on',
      'fn_cash_cluster_commit_lightning',
      'fn_cash_cluster_begin_pending_off',
      'fn_cash_cluster_abort_pending_off',
      'fn_cash_cluster_commit_must_move',
    ])
      expect(body, call).toContain(`public.${call}(`);
    expect(body).toMatch(/v_live_ok AND v_live > v_off/);
  });
  it('derives request ids from the Cluster, its epoch, the direction and its conversion count', () => {
    expect(d()).toMatch(
      /md5\(format\('lightning-drive:%s:%s:lightning:%s', g\.id, g\.cluster_epoch, v_n\)\)::uuid/
    );
    expect(d()).toMatch(
      /md5\(format\('lightning-drive:%s:%s:must_move:%s', g\.id, g\.cluster_epoch, v_n\)\)::uuid/
    );
  });
  it("isolates one Cluster's failure in its own sub-block and records it", () => {
    expect(d()).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(d()).toMatch(/'lightning_drive_error'/);
  });
  it('the tick pass drives Clusters with Lightning enabled or in a Lightning mode, after the reaps and before the slot sync', () => {
    const s = sub('sub_tick');
    expect(s).toMatch(
      /WHERE \(coalesce\(cg\.lightning_enabled, false\) AND coalesce\(cg\.must_move, false\)\)\s+OR cg\.cluster_mode IN \('pending_on', 'lightning', 'pending_off'\)/
    );
    expect(s).toMatch(/public\.fn_cash_cluster_lightning_drive\(lc\.id\)/);
    expect(s).toMatch(/'lightning_driven', v_lightning_driven/);
    expect(s).toMatch(
      /position\('fn_lightning_reap_formations' in v_src\) > position\('fn_cash_cluster_lightning_drive' in v_src\)/
    );
  });
  it('the reaper commits a stuck PENDING_OFF through the same commit after voiding its hands, per item', () => {
    const s = sub('sub_reap');
    expect(s).toMatch(/IF c\.to_mode = 'must_move' AND c\.cluster_mode = 'pending_off' THEN/);
    expect(s).toMatch(/fn_lightning_instance_abandon\(v_inst\.id/);
    expect(s).toMatch(
      /public\.fn_cash_cluster_commit_must_move\(c\.cluster_id, c\.conversion_request_id\)/
    );
    expect(s).toMatch(/'lightning_pending_off_reaped'/);
    expect(s).toMatch(/'lightning_pending_off_reap_failed'/);
  });
});

describe('my session names the seat', () => {
  it('a caller with no pool session but a live seat gets pool_session_id null, cluster_mode, seat_table_id and seat_number', () => {
    const s = sub('sub_session');
    expect(s).toMatch(
      /RETURN jsonb_build_object\('pool_session_id', NULL, 'cluster_mode', v_seat\.cluster_mode,\s+'seat_table_id', v_seat\.table_id, 'seat_number', v_seat\.seat_number\);/
    );
    expect(s).toMatch(/ts\.user_id = v_uid AND ts\.left_at IS NULL/);
  });
  it('a pooled caller keeps every key and gains seat_table_id, the anchor table', () => {
    expect(sub('sub_session')).toContain(
      "'anchor_table_id', s.anchor_table_id, 'seat_table_id', s.anchor_table_id, 'seat_number', s.seat_number,"
    );
  });
});

describe('every substitution is asserted', () => {
  it.each(['sub_reap', 'sub_tick', 'sub_session'])(
    '%s reads production, counts each anchor, refuses a blind replace and reads back',
    (tag) => {
      const s = sub(tag);
      expect(s).toMatch(/v_src := pg_get_functiondef\(v_sig::regprocedure\);/);
      expect(s).toMatch(
        /IF v_n IS DISTINCT FROM c\[k\] THEN\s+RAISE EXCEPTION '% carries anchor % % time\(s\) rather than %; refusing to substitute blind'/
      );
      expect(s).toMatch(/EXECUTE v_new;/);
      expect(count(s, /v_src := pg_get_functiondef/g)).toBe(2);
      expect(s).toMatch(/IF position\('/);
    }
  );
});

describe('law 10.5 and the live proofs', () => {
  it('no new body reads is_horse or horse_id', () => {
    for (const name of NEW) expect(fnCode(name), name).not.toMatch(/is_horse|horse_id/);
    expect(CODE).not.toMatch(/is_horse|horse_id/);
  });
  it('declares six balanced live proofs, every one filtering functions by prokind or naming them exactly', () => {
    const proofs: string[] = declaredProofs(SQL);
    expect(proofs.length).toBe(6);
    for (const p of proofs) expect(count(p, /\(/g), p).toBe(count(p, /\)/g));
    expect(proofs.some((p) => p.includes("p.prokind = 'f'"))).toBe(true);
  });
});

describe('the proof around it', () => {
  it('the harness applies the real chain through this file twice on its own port and proves horses beside humans', () => {
    expect(HARNESS).toContain('port=${LIGHTNING_P7_PORT:-55554}');
    expect(HARNESS).toContain(FILE);
    expect(HARNESS).toContain('LIGHTNING_P7_MIGRATION');
    expect(count(HARNESS, /-f "\$mine"/g)).toBe(2);
    for (const n of [
      '00',
      '01',
      '02',
      '03',
      '04',
      '05',
      '05b',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
    ])
      expect(HARNESS, n).toMatch(new RegExp(`\\\\echo '  ok  ${n} `));
    expect(HARNESS).toMatch(/fn_lightning_hand_view_access/);
    expect(HARNESS).toMatch(/horse/);
  });
  it('CI runs it on shard 1 right after the Phase 6 settlement harness', () => {
    const p6 = CI.indexOf('run: bash scripts/dev/test-lightning-phase6-settlement.sh');
    const p7 = CI.indexOf('run: bash scripts/dev/test-lightning-phase7-reversion.sh');
    expect(p6).toBeGreaterThan(0);
    expect(p7).toBeGreaterThan(p6);
    expect(CI.slice(p6, p7)).toMatch(
      /if: matrix\.shard == 1\n\s+env:\n\s+PG_BIN: \/usr\/lib\/postgresql\/17\/bin\n\s+$/
    );
  });
  it('the schema manifest fragment promises exactly the four new functions', () => {
    expect([...FRAGMENT.functions].sort()).toEqual([...NEW].sort());
    expect(FRAGMENT.tables).toEqual([]);
  });
  it('the changelog names every new door, uses title case headings and no em dash', () => {
    for (const p of [
      ...NEW,
      'fn_lightning_my_session',
      'fn_cash_cluster_reap_stuck_conversions',
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

/**
 * THE REMEDIATION (20261007222717): a static reading of the migration that
 * closes the Phase 7 review findings. The harness proves each fix against a
 * running estate; this proves the transaction shape, that every change is an
 * asserted substitution, the pre-lock ordering of the polls, and Law 10.5.
 */
const REM_CODE = REM.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

function remSub(tag: string): string {
  const start = REM.indexOf(`DO $${tag}$`);
  expect(start, tag).toBeGreaterThan(0);
  return REM.slice(start, REM.indexOf(`$${tag}$;`, start + tag.length + 4));
}
const REM_SUBS = [
  'sub_unfreeze',
  'sub_reap_orphan',
  'sub_begin_on',
  'sub_begin_off',
  'sub_commit_mm',
  'sub_commit_l',
  'sub_release',
  'sub_config',
  'sub_drive',
];

describe('the remediation transaction', () => {
  it('is one BEGIN and one COMMIT, with a lock wait set first', () => {
    expect(count(REM_CODE, /^BEGIN;$/gm)).toBe(1);
    expect(count(REM_CODE, /^COMMIT;$/gm)).toBe(1);
    expect(REM_CODE.trim().endsWith('COMMIT;')).toBe(true);
    expect(REM_CODE).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '2s';/m);
  });
  it('adds exactly one nullable column and otherwise creates and drops nothing', () => {
    expect(count(REM_CODE, /\bALTER TABLE\b/g)).toBe(1);
    expect(REM_CODE).toMatch(
      /ALTER TABLE public\.cash_games\s+ADD COLUMN IF NOT EXISTS lightning_off_condition_since timestamptz;/
    );
    expect(REM_CODE).not.toMatch(/\bCREATE TABLE\b|\bDROP TABLE\b/);
    expect(REM_CODE).not.toMatch(/CREATE (CONSTRAINT )?TRIGGER/);
    expect(REM_CODE).not.toMatch(/DROP FUNCTION/);
    expect(REM_CODE).not.toMatch(/\bLOCK TABLE\b/);
    expect(REM_CODE).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(REM_CODE).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});

describe('every remediation change is an asserted substitution', () => {
  it.each(REM_SUBS)(
    '%s reads production, counts each anchor, refuses a blind replace and reads back',
    (tag) => {
      const s = remSub(tag);
      expect(s).toMatch(/v_src := pg_get_functiondef\(v_sig::regprocedure\);/);
      expect(s).toMatch(
        /IF v_n IS DISTINCT FROM c\[k\] THEN\s+RAISE EXCEPTION '% carries anchor % % time\(s\) rather than %; refusing to substitute blind'/
      );
      expect(s).toMatch(/EXECUTE v_new;/);
      expect(count(s, /v_src := pg_get_functiondef/g)).toBe(2);
      expect(s).toMatch(/IF position\('/);
    }
  );
});

describe('finding 1: the orphaned conversion', () => {
  it('the unfreeze aborts any pending conversion and clears the engine acknowledgement', () => {
    const s = remSub('sub_unfreeze');
    expect(s).toMatch(
      /SET status = 'aborted', abort_reason = 'cluster_unfrozen', closed_at = clock_timestamp\(\)\s+WHERE cluster_id = g\.id AND status = 'pending';/
    );
    expect(s).toMatch(
      /SET dealing_halted_at = NULL, dealing_halted_reason = NULL, dealing_halt_observed_at = NULL/
    );
    expect(s).toMatch(/'conversions_aborted', v_convs/);
  });
  it('the reaper aborts an orphan as orphaned_by_<mode> and keeps the pending_off reap', () => {
    const s = remSub('sub_reap_orphan');
    expect(s).toMatch(
      /IF \(c\.to_mode = 'must_move' AND c\.cluster_mode IS DISTINCT FROM 'pending_off'\)\s+OR \(c\.to_mode = 'lightning' AND c\.cluster_mode IS DISTINCT FROM 'pending_on'\) THEN/
    );
    expect(s).toMatch(/'orphaned_by_' \|\| coalesce\(c\.cluster_mode, 'unknown'\)/);
    expect(s).toMatch(/'lightning_conversion_orphan_reaped'/);
    expect(s).toMatch(/'not_a_pending_on_lightning_conversion'/);
  });
  it('both begins answer conversion_already_open instead of dying on the unique index', () => {
    for (const tag of ['sub_begin_on', 'sub_begin_off']) {
      const s = remSub(tag);
      expect(s, tag).toMatch(/WHERE cluster_id = g\.id AND status = 'pending';/);
      expect(s, tag).toMatch(/'reason', 'conversion_already_open'/);
      expect(s, tag).toMatch(/'ok', false, 'pending', true/);
    }
  });
});

describe('finding 2: the digest is live rows under locks', () => {
  it('takes FOR SHARE on seats, open sessions and the ledger before the first digest', () => {
    const s = remSub('sub_commit_mm');
    expect(s).toMatch(
      /PERFORM 1 FROM public\.table_seats ts\s+WHERE ts\.left_at IS NULL\s+AND ts\.table_id IN \(SELECT tb\.id FROM public\.tables tb WHERE tb\.cluster_id = g\.id\)\s+ORDER BY ts\.id\s+FOR SHARE;/
    );
    expect(s).toMatch(
      /PERFORM 1 FROM public\.cash_player_session s\s+WHERE s\.cluster_id = g\.id AND s\.closed_at IS NULL\s+ORDER BY s\.id\s+FOR SHARE;/
    );
    expect(s).toMatch(
      /PERFORM 1 FROM public\.lightning_blind_ledger bl\s+WHERE bl\.cluster_id = g\.id\s+ORDER BY bl\.player_id\s+FOR SHARE;/
    );
  });
  it('both digests cover exactly the live rows', () => {
    const s = remSub('sub_commit_mm');
    expect(count(s, /WHERE tb\.cluster_id = g\.id AND ts\.left_at IS NULL/g)).toBe(2);
    expect(
      count(
        s,
        /'cps:' \|\| to_jsonb\(s\)::text FROM public\.cash_player_session s\s+WHERE s\.cluster_id = g\.id AND s\.closed_at IS NULL/g
      )
    ).toBe(2);
  });
});

describe('finding 3: the void hand and the dwell', () => {
  it('the release trigger reverses exactly the formation increments, floored at zero, for a never-dealt abandon', () => {
    const s = remSub('sub_release');
    expect(s).toMatch(
      /IF NEW\.state = 'abandoned' AND NEW\.started_at IS NULL AND NEW\.hand_id IS NOT NULL THEN/
    );
    for (const col of ['bb_count', 'sb_count', 'btn_count', 'utg_count', 'hj_count', 'co_count'])
      expect(s, col).toMatch(new RegExp(`${col}\\s+= GREATEST\\(bl\\.${col}`));
    expect(s).not.toMatch(/missed_bb_debt\s*=|missed_sb_debt\s*=|bb_owed\s*=|sb_owed\s*=/);
  });
  it('the population trigger dwells on a durable first sighting, configured as pending_off_dwell_ms', () => {
    const s = remSub('sub_begin_off');
    expect(s).toMatch(/'pending_off_dwell_ms', 10000, 0, 3600000, true/);
    expect(s).toMatch(/IF v_why = 'population_at_or_below_off_threshold' THEN/);
    expect(s).toMatch(/IF v_dwell > 0 AND g\.lightning_off_condition_since IS NULL THEN/);
    expect(s).toMatch(/'reason', 'off_condition_dwell'/);
    expect(s).toMatch(/SET cluster_mode = 'pending_off', lightning_off_condition_since = NULL/);
    expect(remSub('sub_config')).toMatch(/'pending_off_dwell_ms', 10000, 0, 3600000, true/);
    expect(remSub('sub_drive')).toMatch(
      /UPDATE public\.cash_games cg SET lightning_off_condition_since = NULL\s+WHERE cg\.id = g\.id AND cg\.lightning_off_condition_since IS NOT NULL;/
    );
  });
});

describe('findings 4 and 5: the halts of a disabled game, and the pre-lock polls', () => {
  it('a disabled game keeps its halts and the result says so', () => {
    const s = remSub('sub_commit_mm');
    expect(s).toMatch(/IF g\.enabled IS NOT DISTINCT FROM true THEN\s+UPDATE public\.tables tb/);
    expect(count(s, /'halts_kept_game_disabled', g\.enabled IS DISTINCT FROM true/g)).toBe(2);
  });
  it('each commit polls its cheap in-flight count before taking the Cluster row', () => {
    const mm = remSub('sub_commit_mm');
    const b = mm.indexOf('$b$');
    expect(mm.indexOf("'instances_in_flight'", b)).toBeLessThan(mm.indexOf('FOR UPDATE', b));
    const cl = remSub('sub_commit_l');
    const cb = cl.indexOf('$b$');
    expect(cl.indexOf("'hands_in_flight'", cb)).toBeLessThan(cl.indexOf('FOR UPDATE', cb));
    expect(cl).toMatch(/h\.is_complete = false/);
    expect(cl).toMatch(/interval '6 hours'/);
  });
});

describe('law 10.5 and the proof around the remediation', () => {
  it('no remediation body reads is_horse or horse_id', () => {
    expect(REM_CODE).not.toMatch(/is_horse|horse_id/);
  });
  it('declares ten balanced live proofs', () => {
    const proofs: string[] = declaredProofs(REM);
    expect(proofs.length).toBe(10);
    for (const p of proofs) expect(count(p, /\(/g), p).toBe(count(p, /\)/g));
  });
  it('the harness applies the remediation twice, grounds its defects first and reports sections 17 to 26', () => {
    expect(HARNESS).toContain(REM_FILE);
    expect(HARNESS).toContain('LIGHTNING_P7R_MIGRATION');
    expect(count(HARNESS, /-f "\$rem"/g)).toBe(2);
    for (const n of ['17', '18', '19', '20', '21', '22', '23', '24', '25', '26'])
      expect(HARNESS, n).toMatch(new RegExp(`\\\\echo '  ok  ${n} `));
    const ground = HARNESS.indexOf('rem-ground.sql');
    const apply = HARNESS.indexOf('-f "$rem"');
    expect(ground).toBeGreaterThan(0);
    expect(HARNESS.indexOf('FAIL 17')).toBeLessThan(HARNESS.indexOf('FAIL 18'));
    expect(apply).toBeGreaterThan(0);
  });
  it('the schema manifest fragment promises the one new column and no function', () => {
    const fragment = JSON.parse(
      read('scripts', 'ci', 'schema-manifest.d', 'lightning-phase7-remediation.json')
    );
    expect(fragment.functions).toEqual([]);
    expect(fragment.tables).toEqual([]);
    expect(fragment.columns).toEqual({ cash_games: ['lightning_off_condition_since'] });
  });
  it('the remediation changelog names the file and every touched door, title case, no em dash', () => {
    for (const p of [
      REM_FILE,
      'fn_cash_cluster_unfreeze',
      'fn_cash_cluster_reap_stuck_conversions',
      'fn_cash_cluster_begin_pending_on',
      'fn_cash_cluster_begin_pending_off',
      'fn_cash_cluster_commit_must_move',
      'fn_cash_cluster_commit_lightning',
      'fn_cash_cluster_lightning_drive',
      'fn_lightning_instance_releases_its_reservations',
      'fn_lightning_config',
      'pending_off_dwell_ms',
      'lightning_off_condition_since',
    ])
      expect(REMLOG, p).toContain(p);
    expect(REMLOG).not.toContain('—');
    for (const h of REMLOG.match(/^#{1,3} .+$/gm) ?? []) {
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
