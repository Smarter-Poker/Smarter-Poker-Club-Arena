/**
 * LIGHTNING TRANSITION, PHASE 5 OF 5 (2026-10-26): A GAME STAYS IN ITS MODE
 * LONG ENOUGH TO PLAY IT.
 *
 * Production review: before always_on was set, pilot cluster 681eb9e8 switched
 * modes 19 times in 5 days; the quickest return into Lightning after it ended
 * was 48 s, and 3 of 19 returns came within 15 minutes. The only protection was
 * the ON/OFF threshold gap and a 10 s wait before turning OFF.
 *
 * 20261026110858 pins three numbers, each configurable in
 * ruleset_snapshot.lightning the way pending_off_dwell_ms already was:
 *   pending_on_dwell_ms   60000   the ON condition must hold continuously
 *   pending_off_dwell_ms 120000   (was 10000) the OFF condition must hold
 *   min_mode_dwell_ms    900000   no AUTOMATIC switch sooner after the last one
 * and two exclusions: an always_on game is never held, and an operator drain or
 * enable is never held (nor does it start the floor).
 *
 * The live preimages of the two functions whose bodies this replays are kept
 * byte for byte in tests/fixtures/lightning-mode-dwell (read from production
 * 2026-10-26 with SELECT pg_get_functiondef; their md5s are the guards). The
 * patch is replayed here exactly as the migration's DO block runs it, so a
 * missing or repeated anchor fails in CI rather than at the 04:00 install.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateWindowMigration,
  windowDeclaration,
} from '../../scripts/ci/maintenance-window-migrations.mjs';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const FILE =
  'supabase/migrations/20261026110858_a_lightning_game_stays_in_its_mode_long_enough_to_play_it.sql';
const SQL = read(FILE);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const DRIVE = 'public.fn_cash_cluster_lightning_drive(uuid)';
const OFF = 'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)';
const CONFIG = 'public.fn_lightning_config(uuid)';
const PREIMAGES: Record<string, string> = {
  [DRIVE]: 'tests/fixtures/lightning-mode-dwell/fn_cash_cluster_lightning_drive.preimage.txt',
  [OFF]: 'tests/fixtures/lightning-mode-dwell/fn_cash_cluster_begin_pending_off.preimage.txt',
};

/** The migration's VALUES rows: signature, guard md5, anchors and replacements. */
function patchRows(): { sig: string; expected: string; anchors: string[]; news: string[] }[] {
  const rows: { sig: string; expected: string; anchors: string[]; news: string[] }[] = [];
  const re =
    /\('(public\.[^']+)',\s*'([0-9a-f]{32})',\s*ARRAY\[([\s\S]*?)\],\s*ARRAY\[([\s\S]*?)\]\)/g;
  const quoted = (block: string) =>
    [...block.matchAll(/\$([a-z]\d+)\$([\s\S]*?)\$\1\$/g)].map((m) => m[2]);
  for (const m of SQL.matchAll(re))
    rows.push({ sig: m[1], expected: m[2], anchors: quoted(m[3]), news: quoted(m[4]) });
  return rows;
}

/** Exactly what the DO block does: each anchor occurs once, then is replaced. */
function replay(def: string, anchors: string[], news: string[]): string {
  let out = def;
  anchors.forEach((a, i) => {
    expect(out.split(a).length - 1, `anchor ${i + 1} occurs exactly once`).toBe(1);
    out = out.split(a).join(news[i]);
  });
  return out;
}

const rows = patchRows();
const row = (sig: string) => rows.find((r) => r.sig === sig)!;
const postimage = (sig: string) => {
  const r = row(sig);
  return replay(read(PREIMAGES[sig]), r.anchors, r.news);
};

describe('the migration is one guarded, windowed transaction', () => {
  it('waits for the daily maintenance window (it adds a column to cash_games)', () => {
    expect(windowDeclaration(SQL)).toBe('daily-maintenance');
    expect(validateWindowMigration(FILE, SQL)).toBe(true);
    expect(SQL).toMatch(
      /ALTER TABLE public\.cash_games ADD COLUMN lightning_on_condition_since timestamptz;/
    );
  });

  it('patches exactly three functions, each behind its live md5', () => {
    expect(rows.map((r) => [r.sig, r.expected])).toEqual([
      [DRIVE, 'e4e4813b063e5f738cab2a12e67b5c2e'],
      [OFF, 'd146e9c6ab3d051d9b871b70e4b10116'],
      [CONFIG, '85c851a53fe15425be958144836d5f75'],
    ]);
    for (const r of rows) expect(r.anchors.length, r.sig).toBe(r.news.length);
    expect(SQL).toMatch(/IF md5\(v_def\) IS DISTINCT FROM v_expected THEN/);
    expect(SQL).toMatch(/IF v_after IS DISTINCT FROM v_new\s+OR v_meta IS DISTINCT FROM/);
    expect(SQL).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });

  it('the recorded preimages are the live bytes the guards name', () => {
    for (const sig of [DRIVE, OFF]) expect(md5(read(PREIMAGES[sig])), sig).toBe(row(sig).expected);
  });

  it('every anchor occurs exactly once in its preimage', () => {
    for (const sig of [DRIVE, OFF]) expect(() => postimage(sig), sig).not.toThrow();
  });

  it('declares its live proofs and its schema fragment', () => {
    const proofs = SQL.split('\n').filter((l) => l.startsWith('-- @live-proof: '));
    expect(proofs.length).toBe(4);
    expect(proofs.join('\n')).toContain('lightning_on_condition_since');
    expect(proofs.join('\n')).toContain("''pending_off_dwell_ms'', 120000, 0, 3600000, true");
    const fragment = JSON.parse(
      read('scripts/ci/schema-manifest.d/lightning-mode-switch-dwell-20261026.json')
    );
    expect(fragment.columns).toEqual({ cash_games: ['lightning_on_condition_since'] });
  });

  it('never touches the operator doors or the drain', () => {
    expect(SQL).not.toMatch(/'public\.fn_lightning_operator_control/);
    expect(SQL).not.toMatch(/'public\.fn_lightning_drain_advance/);
    expect(SQL).not.toMatch(/'public\.fn_cash_cluster_begin_pending_on/);
  });
});

describe('the three numbers', () => {
  it('ON must hold continuously for 60 s before pending_on', () => {
    const drive = postimage(DRIVE);
    expect(drive).toContain(
      "'pending_on_dwell_ms', 60000, 0, 3600000, true) ->> 'value')::integer;"
    );
    expect(drive).toContain(
      'clock_timestamp() < g.lightning_on_condition_since + make_interval(secs => v_on_dwell / 1000.0)'
    );
    // A pass that does not keep the sighting clears it: oscillation never accumulates.
    expect(drive).toMatch(
      /IF NOT v_keep_on AND g\.lightning_on_condition_since IS NOT NULL THEN\s+UPDATE public\.cash_games cg SET lightning_on_condition_since = NULL/
    );
  });

  it('OFF must hold for 120 s (was 10 s), where it is enforced and where it is reported', () => {
    const off = postimage(OFF);
    expect(off).toContain(
      "'pending_off_dwell_ms', 120000, 0, 3600000, true) ->> 'value')::integer;"
    );
    expect(off).not.toContain("'pending_off_dwell_ms', 10000,");
    const config = row(CONFIG).news.join('\n');
    expect(config).toContain(
      "fn_lightning_config_number(v_cfg, 'pending_off_dwell_ms', 120000, 0, 3600000, true);"
    );
    expect(config).toContain(
      "fn_lightning_config_number(v_cfg, 'pending_on_dwell_ms', 60000, 0, 3600000, true);"
    );
    expect(config).toContain(
      "fn_lightning_config_number(v_cfg, 'min_mode_dwell_ms', 900000, 0, 86400000, true);"
    );
    expect(config).toContain("'pending_on_dwell_ms', v_on_dwell,");
    expect(config).toContain("'min_mode_dwell_ms', v_min_mode);");
  });

  it('a game stays at least 15 minutes after an automatic switch', () => {
    const drive = postimage(DRIVE);
    expect(drive).toContain(
      "'min_mode_dwell_ms', 900000, 0, 86400000, true) ->> 'value')::integer;"
    );
    expect(drive).toContain("WHERE cc.cluster_id = g.id AND cc.status = 'committed'");
    expect(drive).toContain(
      'v_floor_until := v_last.closed_at + make_interval(secs => v_min_mode / 1000.0);'
    );
    expect(drive.match(/v_action := 'min_mode_dwell';/g)?.length).toBe(2);
  });
});

describe('the exclusions', () => {
  it('always_on is evaluated by the same policy as before and is never held', () => {
    const drive = postimage(DRIVE);
    const pre = read(PREIMAGES[DRIVE]);
    const policy = pre.slice(pre.indexOf('EXISTS(SELECT 1 FROM public.cash_games policy'));
    const policySql = policy.slice(0, policy.indexOf('d.completed_at IS NULL))') + 24);
    expect(drive).toContain(`v_always := ${policySql};`);
    // Both must_move waits require NOT v_always; the begin branch for always_on is untouched.
    expect(drive).toMatch(
      /IF v_on_ok AND coalesce\(g\.must_move, false\) AND NOT v_always AND v_floor_until IS NOT NULL THEN/
    );
    expect(drive).toMatch(
      /ELSIF v_on_ok AND coalesce\(g\.must_move, false\) AND NOT v_always AND v_on_dwell > 0/
    );
    expect(drive).toMatch(
      /ELSIF v_on_ok AND coalesce\(g\.must_move, false\) THEN\s+v_action := 'begin_pending_on';/
    );
    // The floor is only looked up for a population trigger.
    expect(drive).toMatch(
      /\(g\.cluster_mode = 'must_move' AND v_on_ok AND NOT v_always\)\s+OR \(g\.cluster_mode = 'lightning' AND v_off_ok AND v_live_ok\)/
    );
    // In Lightning, v_off_ok is already NOT always_on (20261023230807), unchanged here.
    expect(drive).toContain('v_off_ok := NOT EXISTS(SELECT 1 FROM public.cash_games policy');
    // A refused begin keeps the sighting only for a population game.
    expect(drive).toMatch(/v_keep_on := NOT v_always AND v_on_dwell > 0/);
  });

  it('an operator drain or enable is never held and does not start the floor', () => {
    const drive = postimage(DRIVE);
    expect(drive).toContain("AND v_last.from_mode IS DISTINCT FROM 'draining'");
    expect(drive).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.lightning_cluster_drain d\s+WHERE d\.conversion_id = v_last\.id\)/
    );
    expect(drive).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.lightning_operator_request r\s+WHERE r\.cluster_id = g\.id AND r\.created_at > v_last\.closed_at\s+AND r\.action IN \('enable_lightning', 'resume', 'unfreeze', 'drain'\)\s+AND \(r\.answer ->> 'ok'\) = 'true'\)/
    );
    // Lightning switched off or a disabled game (NOT v_live_ok) drains at once.
    expect(drive).toMatch(
      /IF v_off_ok AND v_live_ok AND v_floor_until IS NOT NULL THEN[\s\S]*?ELSIF v_off_ok OR NOT v_live_ok THEN\s+v_action := 'begin_pending_off';/
    );
    // The drain's own path through begin_pending_off is untouched: only the
    // population trigger reads the dwell there.
    const off = postimage(OFF);
    expect(off).toContain("IF v_why = 'population_at_or_below_off_threshold' THEN");
    expect(off).toContain(
      "AND NOT (g.cluster_mode = 'draining' AND p_reason IS NOT DISTINCT FROM 'lightning_drain') THEN"
    );
  });

  it('changes nothing else in either body', () => {
    for (const sig of [DRIVE, OFF]) {
      const pre = read(PREIMAGES[sig]);
      const post = postimage(sig);
      // Every preimage line survives, in order: the patch only inserts.
      const preLines = pre.split('\n');
      const postLines = post.split('\n');
      let j = 0;
      const missing: string[] = [];
      for (const line of preLines) {
        const k = postLines.indexOf(line, j);
        if (k < 0) missing.push(line);
        else j = k + 1;
      }
      // The only rewritten lines are the ones this phase means to change.
      expect(missing, sig).toEqual(
        sig === DRIVE
          ? [
              '  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled, cg.enabled, cg.must_move',
              '    IF v_on_ok AND coalesce(g.must_move, false) THEN',
              '    IF v_off_ok OR NOT v_live_ok THEN',
              "    || CASE WHEN v_drain IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('drain', v_drain) END;",
            ]
          : [
              '  -- configured pending_off_dwell_ms (default 10000; 0 keeps the two-sighting',
              "                  'pending_off_dwell_ms', 10000, 0, 3600000, true) ->> 'value')::integer;",
            ]
      );
    }
  });
});
