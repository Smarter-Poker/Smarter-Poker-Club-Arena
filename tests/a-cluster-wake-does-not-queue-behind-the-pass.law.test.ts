/**
 * LAW: A CLUSTER WAKE DOES NOT QUEUE BEHIND THE PASS (2026-10-03).
 *
 * The 5-second pass (fn_cash_clusters_tick_all) holds every cash_games row it
 * ticked until it commits; the engine's per-game wake
 * (ClusterController.tickGame -> fn_cash_cluster_tick) waited behind it:
 * 27,682 wakes, 8,486 s of database time in 100 minutes, mean 307 ms, max
 * 5.8 s. A wake now takes its row with SKIP LOCKED and answers
 * ticking_elsewhere when somebody holds it; inside a pass (which publishes
 * ca.cluster_pass_deadline) the tick waits for its row exactly as before.
 *
 * What this pins: the migration is one transaction that substitutes exactly
 * the old row lock on the pinned live text, checks the reverse substitution
 * and the privileges; the wake branch is chosen by the pass's own deadline
 * setting; the pass still publishes that setting; and the engine treats a
 * result with no actions and no seated_total as nothing to do.
 * scripts/ci/test-a-cluster-wake-does-not-queue-behind-the-pass.py
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FILE = '20261003223747_a_cluster_wake_does_not_queue_behind_the_pass.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');
const CONTROLLER = readFileSync(resolve(process.cwd(), 'server/src/cluster/ClusterController.ts'), 'utf8');
const PASS = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260926072615_lightning_remediation_two_c_the_seat_is_the_anchor_and_the_p.sql'
  ),
  'utf8'
);

/** The E'' string the migration assigns to a variable, decoded. */
function assigned(name: string): string {
  const m = MIG.match(new RegExp(`  ${name} := ((?:E'(?:[^'\\\\]|\\\\.)*'\\s*(?:\\|\\|\\s*)?)+);`));
  expect(m, `${name} is assigned`).not.toBeNull();
  const parts = [...m![1].matchAll(/E'((?:[^'\\]|\\.)*)'/g)].map((p) => p[1]);
  return parts.map((p) => p.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\')).join('');
}

describe('a cluster wake does not queue behind the pass', () => {
  const OLD = assigned('v_old');
  const NEW = assigned('v_new');

  it('is one transaction substituting one pinned fragment', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toMatch(/SET LOCAL lock_timeout = '2s';/);
    expect(MIG.match(/8b1223ad422f9a147e6719c8522217b9/g)).toHaveLength(2);
    expect(MIG).toContain('IF v_n <> 1 THEN');
    expect(MIG).toContain('md5(replace(v_after, v_new, v_old))');
    expect(MIG).toContain("has_function_privilege('anon', v_sig, 'EXECUTE')");
    expect(MIG).toContain('@live-proof:');
  });

  it('replaces exactly the old blocking row lock', () => {
    expect(OLD).toBe(
      '  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;\n' +
        "  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;\n"
    );
    expect(NEW.includes(OLD)).toBe(false);
  });

  it('skips a held row only when no pass deadline is set', () => {
    const wake = NEW.indexOf("IF COALESCE(current_setting('ca.cluster_pass_deadline', true), '') = '' THEN");
    const skip = NEW.indexOf('FOR UPDATE SKIP LOCKED;');
    const otherwise = NEW.indexOf('  ELSE\n');
    const blocking = NEW.indexOf('WHERE id = p_game_id FOR UPDATE;\n', otherwise);
    expect(wake).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(wake);
    expect(otherwise).toBeGreaterThan(skip);
    expect(blocking).toBeGreaterThan(otherwise);
    expect(NEW.match(/SKIP LOCKED/g)).toHaveLength(1);
    expect(NEW).toContain("'reason', 'ticking_elsewhere'");
    expect(NEW.match(/'reason', 'not_found'/g)).toHaveLength(2);
  });

  it('the pass publishes the deadline the tick reads', () => {
    expect(PASS).toContain("set_config('ca.cluster_pass_deadline'");
  });

  it('the engine does nothing with an answer that carries no actions and no seated_total', () => {
    expect(CONTROLLER).toContain('if (Array.isArray(result.actions) && result.actions.length > 0)');
    expect(CONTROLLER).toContain('Number(result.seated_total ?? 0) > 0');
  });

  it('ships the disposable-cluster proof', () => {
    expect(existsSync(join(process.cwd(), 'scripts/ci/test-a-cluster-wake-does-not-queue-behind-the-pass.py'))).toBe(true);
  });
});
