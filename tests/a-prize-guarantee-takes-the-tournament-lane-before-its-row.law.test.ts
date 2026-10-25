/**
 * THE PRIZE GUARANTEE TAKES THE TOURNAMENT LANE BEFORE ITS ROW.
 *
 * public.fn_apply_prize_guarantee is EXECUTE-granted to service_role and
 * publishes prize_pool_finalized under a tournaments row lock. That fires the
 * deferred payer, which asks for the tournament lane T(id) exclusive at
 * COMMIT. Holding the row without the lane is the inversion that produced
 * every 40P01 tournament.real_time_payout_refused alert of 2026-10-22..24
 * through the entry-close doors (20261025030526); called directly it closes
 * the same cycle with process_tournament_rebuy (lane at line 71, row at 205).
 * The lane's one order is G, then T(id), then rows.
 *
 * This pins, against the migration and the exact production fixture:
 *   - the lane is the body's first statement, before the overlay return and
 *     the finalization, and only for a non-NULL id;
 *   - the edit is one anchored replace of production's pre-image and yields
 *     the post-image md5 the migration asserts and its @live-proof reads;
 *   - owner, ACL, SECURITY DEFINER and search_path are asserted unchanged;
 *   - no later migration redefines the function with the row before the lane;
 *   - the fix is not a retry, sweep or cron.
 *
 * Registry: docs/laws.d/a-prize-guarantee-takes-the-tournament-lane-before-its-row.md
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const NAME = '20261025035247_prize_guarantee_takes_the_tournament_lane_before_its_row.sql';
const MIGRATION = readFileSync(join(MIGRATIONS, NAME), 'utf8');
const FIXTURE = readFileSync(
  join(ROOT, 'scripts', 'ci', 'fixtures', 'prize-guarantee-lane', 'fn_apply_prize_guarantee.sql'),
  'utf8'
);
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

const PRE = 'c11535297ab88cfdc254f9336fdc5110';
const PRE_SRC = 'f9ffce0850c1a8df64405a056a9c7648';
const POST = '8a2517fe8bdbff92348821650c418507';
const POST_SRC = '3d004922f96e428db0df48ecf444750f';
const ANCHOR =
  'BEGIN\n  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that\n';
const LANE_CALL = 'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);';
const LANE_BLOCK = [
  '  /* THE LANE BEFORE THE ROW (2026-10-25). G shared, then T(id) exclusive,',
  '     then the tournaments row: the order of every other writer of this',
  '     event. Finalizing the pool here fires the deferred payer, which asks',
  '     for T(id) exclusive at COMMIT; holding the row without the lane made',
  '     that a deadlock with any rebuy, add-on or hand that holds T(id) and',
  '     waits for the row. Re-entrant for callers that already hold it. */',
  '  IF p_tournament_id IS NOT NULL THEN',
  `    ${LANE_CALL}`,
  '  END IF;',
  '',
].join('\n');

describe('the prize guarantee takes the tournament lane before its row', () => {
  it('is one short transaction that edits only fn_apply_prize_guarantee', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIGRATION).toMatch(/^SET LOCAL lock_timeout = '2s';$/m);
    const body = MIGRATION.replace(/^\s*--.*$/gm, '');
    expect(body).not.toMatch(
      /cron\.schedule|pg_sleep|fn_[a-z_]*(repair|backpay|redrive|sweep|catchup|heal)/i
    );
    expect(body).not.toMatch(/'40P01'/);
    expect(body).not.toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(body).not.toMatch(/@install-window/);
    expect(body).toContain("'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure");
  });

  it('the fixture is the production pre-image the migration guards', () => {
    expect(md5(FIXTURE)).toBe(PRE);
    expect(MIGRATION).toContain(`'${PRE}'`);
    expect(MIGRATION).toContain(`'${PRE_SRC}'`);
    expect(FIXTURE.split(ANCHOR)).toHaveLength(2);
  });

  it('takes the lane first and yields the pinned post-image', () => {
    const post = FIXTURE.replace(ANCHOR, `BEGIN\n${LANE_BLOCK}${ANCHOR.slice('BEGIN\n'.length)}`);
    expect(md5(post)).toBe(POST);
    const begin = post.indexOf('\nBEGIN\n');
    const lane = post.indexOf(LANE_CALL);
    expect(begin).toBeGreaterThan(0);
    expect(lane).toBeGreaterThan(begin);
    expect(lane).toBeLessThan(post.indexOf('fn_ca_return_excess_start_overlay_locked'));
    expect(lane).toBeLessThan(post.indexOf('fn_ca_apply_prize_guarantee_core'));
    expect(lane).toBeLessThan(post.indexOf('\n  BEGIN\n'));
    expect(post.slice(begin, lane)).not.toMatch(/SELECT|FOR UPDATE|FOR SHARE|PERFORM\s+1/);
    expect(post).toMatch(
      /IF p_tournament_id IS NOT NULL THEN\n {4}PERFORM public\.fn_ca_lock_settlement_lane_for_tournament/
    );
  });

  it('asserts and live-proves the post-image with its owner, ACL and settings', () => {
    expect(MIGRATION).toContain(`'${POST}'`);
    expect(MIGRATION).toContain(`'${POST_SRC}'`);
    for (const guard of [
      'IS DISTINCT FROM v_acl',
      'IS DISTINCT FROM v_owner',
      'IS DISTINCT FROM v_secdef',
      'IS DISTINCT FROM v_config',
    ]) {
      expect(MIGRATION).toContain(guard);
    }
    const proof = MIGRATION.split('\n').find((line) => line.startsWith('-- @live-proof: '));
    expect(proof).toBeDefined();
    expect(proof).toContain(`md5(pg_get_functiondef(oid))='${POST}'`);
    expect(proof).toContain(`md5(prosrc)='${POST_SRC}'`);
    expect(proof).toContain("proacl::text='{postgres=X/postgres,service_role=X/postgres}'");
    expect(proof).toContain('AND prosecdef');
    expect(proof).toContain('public.fn_apply_prize_guarantee(uuid,text)');
  });

  it('no later migration puts the row back in front of the lane', () => {
    const head = /CREATE OR REPLACE FUNCTION public\.fn_apply_prize_guarantee\s*\(/;
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > NAME)
      .sort();
    for (const file of later) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      const at = sql.search(head);
      if (at < 0) continue;
      const def = sql.slice(at, sql.indexOf('$function$;', at));
      const lane = def.indexOf('fn_ca_lock_settlement_lane_for_tournament(');
      expect(lane, `${file} redefines fn_apply_prize_guarantee without the lane`).toBeGreaterThan(
        0
      );
      for (const later of [
        'fn_ca_return_excess_start_overlay_locked',
        'fn_ca_apply_prize_guarantee_core',
        'public.tournaments',
      ]) {
        const at2 = def.indexOf(later);
        if (at2 >= 0) expect(lane, `${file} reaches ${later} before the lane`).toBeLessThan(at2);
      }
    }
  });
});
