/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MINI'S ECONOMICS ARE MEASURED, NOT ASSUMED
 *  BBJ programme phase 3 of 5 (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mini's PRICE is global - a flat amount per stakes tier - and its FUNDING
 * is per pool: 25% of that pool's own BBJ rake. Nothing compared the two, so a
 * pool paying minis faster than its backup fills drifts to its reserve floor
 * and the mini stops there, permanently. The only symptom is `payable` turning
 * false on every tier, which reads to a player exactly like a reserve that is
 * briefly low.
 *
 * THE TRAP THIS LAW EXISTS FOR is the one the first cut of the runway fell
 * into, and it caught its own author. Measuring income over seven days and
 * mini spend over the mini's four-day life produced a deficit of -277/day for
 * Deep Stack Society and an alarm that it would die in 31 days. Measured over
 * ONE window it is +255/day and solvent. Two windows are not a rate; they are
 * two numbers divided by each other.
 *
 * So: one window, published, never longer than the mini has existed - and
 * `days_to_floor` NULL rather than zero when nothing is draining, because a
 * surface must be able to tell "never, at this rate" from "today".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const RUNWAY_MIGRATION =
  'supabase/migrations/20260911164153_the_reserve_is_public_to_a_player_the_rake_rate_is_not.sql';

const FLOOR_DEFAULT_MIGRATION =
  'supabase/migrations/20260911210458_the_mini_floor_default_scales_with_the_tiers.sql';

/**
 * THE FLOOR'S DEFAULT IS DERIVED FROM WHAT A HIT COSTS (2026-09-11).
 *
 * `bbj_pools.mini_reserve_floor` carried the hard literal 5000.00 as its
 * column DEFAULT. The NUMBER was right - 3.33x the largest enabled tier,
 * 1.23x the worst day this jackpot has had (7 hits / 4,075.00 on one pool),
 * 2.09 days of the busiest pool's backup income - and it is unchanged.
 *
 * Its FORM was the defect. The floor exists so a burst of hits cannot take a
 * reserve dark, so its whole job is defined relative to the cost of a hit.
 * A literal cannot know that: raise the tiers and the floor silently stops
 * covering a bad day, with nothing anywhere to say so. That is the shape
 * CLAUDE.md 1.1.7 names - a number tuned to something else and written down
 * as a constant outlives the thing it was tuned to.
 */
describe('the mini floor a new pool starts with is derived, not typed', () => {
  const sql = read(FLOOR_DEFAULT_MIGRATION);

  it('the column default is a function call, never a literal', () => {
    expect(sql).toMatch(
      /ALTER COLUMN mini_reserve_floor SET DEFAULT public\.fn_bbj_default_mini_floor\(\)/
    );
    // the literal it replaced must not come back as the default
    expect(sql).not.toMatch(/SET DEFAULT\s+5000/);
  });

  it('it is derived from the largest ENABLED tier, so it cannot cover less than a hit', () => {
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('COMMENT ON'));
    expect(fn).toContain('bbj_mini_tiers');
    expect(fn).toMatch(/WHERE\s+mt\.enabled/);
    expect(fn).toMatch(/max\(mt\.amount\)/);
    /* A tier that is switched off costs nobody anything, so a floor sized to
       it would hold chips against a payout that cannot happen. */
    expect(fn).toMatch(/GREATEST\(/);
  });

  it('the migration asserts it still evaluates to the literal it replaces', () => {
    // identical behaviour on the day it ships is what makes this safe to apply
    expect(sql).toMatch(/v_default <> 5000[\s\S]{0,200}RAISE EXCEPTION/);
  });

  it('it moves no pool that already carries a floor', () => {
    /* The floor is a per-pool CONTROL (fn_bbj_set_club_mini_floor). A default
       decides where a NEW pool starts and must never reach back over a value
       a club was entitled to set. */
    const body = sql.slice(sql.indexOf('DO $$'));
    expect(body).not.toMatch(/UPDATE\s+public\.bbj_pools/i);
    expect(sql).toMatch(/must not move an existing pool floor/);
  });
});

describe('the runway measures both rates over one honest window', () => {
  const sql = read(RUNWAY_MIGRATION);

  it('the window is bounded by the mini’s own age, and floored', () => {
    expect(sql).toMatch(/GREATEST\(0\.5, LEAST\(7\.0,/);
    // the window's ceiling is the age of the mini's FIRST hit anywhere
    expect(sql).toMatch(/min\(w\.awarded_at\)[\s\S]{0,240}?w\.kind = 'mini'/);
  });

  it('income and spend divide by the SAME window', () => {
    // both sides must end in `/ win.days` (via the flow CTE), never a literal 7
    const flow = sql.slice(sql.indexOf('flow AS ('), sql.indexOf('bound AS ('));
    expect(flow).toContain('AS in_day');
    expect(flow).toContain('AS out_day');
    expect((flow.match(/win\.days/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(flow).not.toMatch(/\/\s*7\.0\s+AS/);
  });

  it('days_to_floor is NULL when nothing is draining, never zero', () => {
    expect(sql).toMatch(/flow\.out_day > flow\.in_day/);
    expect(sql).toMatch(/ELSE NULL END AS days_to_floor/);
  });

  it('the window is published so a rate can be interpreted', () => {
    expect(sql).toMatch(/AS window_days/);
  });

  it('the client keeps NULL as NULL rather than coercing it to zero', () => {
    const feed = read('src/lib/bbjMiniFeed.ts');
    expect(feed).toMatch(/function maybeNum\(v: unknown\): number \| null/);
    expect(feed).toMatch(/daysToFloor: maybeNum\(row\.days_to_floor\)/);
    for (const f of ['inPerDay', 'outPerDay', 'netPerDay', 'floorMinimum', 'windowDays']) {
      expect(feed, `${f} must reach the surfaces`).toContain(f);
    }
  });

  it('the operator sees the runway and can tell the two states apart', () => {
    const panel = read('src/components/bbj/BBJMiniPanel.tsx');
    expect(panel).toContain('mini.daysToFloor === null');
    expect(panel).toMatch(/Not Draining At The Current Rate/);
    expect(panel).toMatch(/Reaches Its Floor In About/);
  });

  it('the RATES are club staff only - a club\u2019s rake income is not public', () => {
    // in_per_day is a club's daily jackpot rake income. check-definer-
    // authorization blocked the first cut of this phase for handing it to anon.
    const sql = read(
      'supabase/migrations/20260911164153_the_reserve_is_public_to_a_player_the_rake_rate_is_not.sql'
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_bbj_mini_for_club\(uuid\) FROM PUBLIC, anon;/
    );
    expect(sql).toMatch(/auth\.uid\(\) IS NOT NULL AND public\.fn_is_club_admin_uid\(p_club_id\)/);
    for (const c of ['in_per_day', 'out_per_day', 'net_per_day', 'floor_minimum', 'window_days']) {
      expect(sql, `${c} must be gated on is_operator`).toMatch(
        new RegExp(`CASE WHEN caller\\.is_operator THEN[^;]*AS ${c}`)
      );
    }
    // ...but the RESERVE stays visible: two player surfaces have shown it since
    // phase 2, and hiding it would have made them read zero.
    expect(sql).toMatch(/COALESCE\(pool\.backup_balance, 0\) AS backup_balance/);
    expect(sql).toMatch(/^\s+pool_row\.reserve_floor,$/m);
    const panel = read('src/components/bbj/BBJMiniPanel.tsx');
    expect(panel).toContain('mini.isOperator &&');
  });
});

describe('the reserve floor is a control with a derived lower bound', () => {
  const sql = read(
    'supabase/migrations/20260911162600_the_mini_reserve_has_a_floor_and_a_runway.sql'
  );

  it('authorizes before it explains, and names its own actor', () => {
    const fn = sql.slice(sql.indexOf('fn_bbj_set_club_mini_floor'));
    const actor = fn.indexOf('auth.uid()');
    const admin = fn.indexOf('fn_is_club_admin_uid');
    const union = fn.indexOf('union_club_follows_the_union');
    expect(actor).toBeGreaterThan(-1);
    expect(actor).toBeLessThan(admin);
    // a stranger must not learn a club's union shape from a refusal
    expect(admin).toBeLessThan(union);
  });

  it('the floor may not fall below one payout at the largest enabled tier', () => {
    expect(sql).toMatch(/max\(mt\.amount\) FILTER \(WHERE mt\.enabled\)/);
    expect(sql).toMatch(/floor_below_one_payout/);
  });

  it('the migration installs the mechanism and retunes nothing itself', () => {
    /* MOVED 2026-09-11 (rule 8). This pinned an assertion that every pool's
       floor is exactly 5000 - right about the intent, wrong as a permanent
       check, because the same file ships the control whose job is to change
       that value, so any replay after a club used it aborted. The migration
       must contain no write of its own to `mini_reserve_floor`, and that is
       what is asserted now. */
    /* Outside the function bodies: the UPDATE inside
       `fn_bbj_set_club_mini_floor` IS the control being installed, and is not
       a write this migration performs when it runs. */
    const applyTime = sql.replace(/\$function\$[\s\S]*?\$function\$/g, '');
    expect(applyTime).not.toMatch(/UPDATE\s+public\.bbj_pools/);
    expect(sql).toMatch(/every pool must carry a floor before the control ships/);
  });

  it('every reason the RPC can give has words for the operator', () => {
    const panel = read('src/components/bbj/BBJMiniPanel.tsx');
    for (const m of sql.matchAll(/'reason',\s*'([a-z_]+)'/g)) {
      expect(panel, `refusalText must name ${m[1]}`).toContain(`case '${m[1]}':`);
    }
  });
});

describe('the mini has its own near misses and its own players floor', () => {
  const rake = read('server/src/config/RakeConfig.ts');

  it('the mini reads ITS OWN players-dealt floor, not the main’s', () => {
    expect(rake).toMatch(/miniMinPlayersDealt: RAKE_SPEC\.rules\.bbjMinPlayersDealt/);
    expect(rake).toMatch(/if \(numPlayersDealt < BBJ_RULES\.miniMinPlayersDealt\) return noHit;/);
  });

  it('the knob is NOT in the rake spec, because that spec is a contract with SQL', () => {
    // rakeSpecChecksum() is pinned against the database's own serialiser; a
    // jackpot detection rule in there would break that parity for nothing.
    const spec = read('server/src/config/rakeSpec.ts');
    expect(spec).not.toContain('bbjMiniMinPlayersDealt');
  });

  it('a mini near miss is detected and reported with a mini_ reason', () => {
    expect(rake).toMatch(/export function detectMiniBBJNearMiss\(/);
    for (const r of [
      'mini_not_enough_players',
      'mini_pot_too_small',
      'mini_double_board',
      'mini_winner_not_quads',
    ]) {
      expect(rake, `${r} must be a reason`).toContain(r);
    }
    // it mirrors the HIT's bar, so the two name the same player
    expect(rake).toMatch(/isAcesFullOrBetter\(r\.handRanking, r\.kickers\)/);
  });

  it('a hand nobody nearly won is NOT recorded as a near miss', () => {
    // recording every ordinary hand would bury the real ones
    const fn = rake.slice(rake.indexOf('export function detectMiniBBJNearMiss('));
    /* MOVED 2026-09-11 (rule 8). This pinned `nearMiss: false` inline. That
       branch also carried `reason: 'mini_loser_below_bar'`, a value no caller
       ever read - 10.86's "a signal that answers when it does not know" - so
       the branch returns the plain `none` now. The property is unchanged:
       nobody cleared the bar, so nothing is recorded. */
    const noCandidate = fn.slice(fn.indexOf('if (!best) {'), fn.indexOf('const base ='));
    expect(noCandidate, 'the no-candidate branch must exist').toBeTruthy();
    expect(noCandidate).toMatch(/return none;/);
    /* On the CODE, not the prose: the function explains in a comment what the
       retired reason was, and asserting on raw text would make that
       explanation illegal - the same trap the promo law documents. */
    const rakeCode = rake.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(rakeCode).not.toContain("'mini_loser_below_bar'");
  });

  it('settlement asks the mini the question, and cannot break on the answer', () => {
    const settle = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settle).toContain('detectMiniBBJNearMiss(');
    expect(settle).toMatch(/MINI BBJ near-miss check failed/);
    // fire and forget: a record must never be able to stop a payout
    expect(settle).toMatch(/void recordBBJNearMiss\(\{[\s\S]{0,600}miniNearMiss\.reason/);
  });
});

/**
 * THE UNION OWNS ITS OWN MINI (2026-09-11).
 *
 * The switch and the reserve floor were built keyed on a CLUB, and both refuse
 * a club inside a union with `union_club_follows_the_union` - correctly: one
 * member club must not decide what every table under a union pays. The union
 * was then given nothing to follow that sentence to. Measured on production:
 * `SELECT count(*) FROM pg_proc WHERE proname LIKE 'fn_bbj_set_union%'` was 0,
 * while the LARGER pool on this platform is a union pool (Midway Union,
 * 52,369.37 main / 43,893.73 backup). So phase 3's whole control surface was
 * unreachable for the pool it matters most to.
 */
describe('the union can reach the two controls a club has', () => {
  const UNION_MIGRATION = 'supabase/migrations/20260911214403_the_union_owns_its_own_mini.sql';
  const sql = read(UNION_MIGRATION);
  /* On the SQL, not the prose. This migration explains in its header which
     predicate it deliberately did NOT use, and asserting on raw text would
     make that explanation illegal - which teaches the next author to delete
     the reasoning to get the law green. Same trap the promo law documents,
     and the third time it has caught this programme's own author. */
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

  it('both controls exist, keyed on the union', () => {
    expect(sql).toMatch(/FUNCTION public\.fn_bbj_set_union_mini_enabled\(/);
    expect(sql).toMatch(/FUNCTION public\.fn_bbj_set_union_mini_floor\(/);
  });

  it('the union operator is the authority, not the club admin', () => {
    /* fn_is_union_operator is the union's owner or a row in union_admins.
       Deliberately NOT fn_is_union_overseer, which also admits club-member
       admins of a union-shaped club: a control that changes what every table
       under a union pays answers to the union's own people. */
    expect(code).toMatch(/public\.fn_is_union_operator\(p_union_id, v_actor\)/);
    expect(code).not.toMatch(/fn_is_union_overseer/);
    expect(code).not.toMatch(/fn_is_club_admin_uid/);
  });

  it('it names its own actor, and authorizes before it explains', () => {
    for (const fn of ['fn_bbj_set_union_mini_enabled', 'fn_bbj_set_union_mini_floor']) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      const stop = body.indexOf('$function$;');
      const src = body.slice(0, stop > 0 ? stop : undefined);
      // the function reads auth.uid() itself - derived one call down it would
      // answer a service_role caller with the misleading 'not_a_union_operator'
      expect(src, `${fn} must read auth.uid()`).toMatch(/v_actor := auth\.uid\(\)/);
      // and the pool lookup comes AFTER the authorization check, so a stranger
      // cannot learn from a refusal whether this union has banked a jackpot
      expect(src.indexOf('fn_is_union_operator')).toBeLessThan(src.indexOf('pool_not_found'));
    }
  });

  it('the pool is resolved on the predicate that is actually unique', () => {
    /* `uq_bbj_pools_union_active` is UNIQUE on (union_id) WHERE club_id IS
       NULL AND status = 'active'. A bare `WHERE union_id = ...` is not unique
       here, and plpgsql's SELECT INTO does not raise on multiple rows - it
       silently takes one, which is a control writing to an arbitrary pool. */
    const lookups = sql.match(/WHERE p\.union_id = p_union_id[^;]*/g) || [];
    expect(lookups.length, 'both controls resolve a pool').toBe(2);
    for (const l of lookups) {
      expect(l).toContain('p.club_id IS NULL');
      expect(l).toContain("p.status = 'active'");
    }
  });

  it('the floor bound is derived, exactly as the club control derives it', () => {
    expect(sql).toMatch(/max\(mt\.amount\) FILTER \(WHERE mt\.enabled\)/);
    expect(sql).toMatch(/'floor_below_one_payout'/);
    // the refusal carries the number, or an operator cannot act on it
    expect(sql).toMatch(/'minimum', v_min/);
  });

  it('no pre-login role can turn a union jackpot off', () => {
    for (const fn of [
      'fn_bbj_set_union_mini_enabled\\(uuid, boolean\\)',
      'fn_bbj_set_union_mini_floor\\(uuid, numeric\\)',
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO authenticated`));
    }
    // and the migration proves it rather than assuming the REVOKE landed
    expect(sql).toMatch(/has_function_privilege\('anon'/);
  });

  it('the migration creates the controls and does not use them', () => {
    /* Phase 3's first cut asserted every floor was exactly 5,000 - right about
       the intent, wrong as a permanent check, because the same file ships the
       control whose job is to change that value. What must be true is that the
       migration itself writes no pool row outside the function bodies. */
    const outsideFns = sql.replace(/AS \$function\$[\s\S]*?\$function\$;/g, '');
    expect(outsideFns).not.toMatch(/UPDATE\s+public\.bbj_pools/i);
    expect(outsideFns).not.toMatch(/INSERT\s+INTO\s+public\.bbj_pools/i);
  });

  it('the surface calls the union RPCs and can say why either refused', () => {
    const feed = read('src/lib/bbjMiniFeed.ts');
    expect(feed).toContain("supabase.rpc('fn_bbj_set_union_mini_enabled'");
    expect(feed).toContain("supabase.rpc('fn_bbj_set_union_mini_floor'");

    const page = read('src/pages/UnionDashboardPage.tsx');
    expect(page).toContain('setBbjUnionMiniEnabled(');
    expect(page).toContain('setBbjUnionMiniFloor(');
    /* Every reason either RPC can return needs words. A reason nobody
       translates is a reason nobody reads: `floor_below_one_payout` on a
       screen is not an instruction. */
    for (const reason of [
      'not_a_union_operator',
      'not_signed_in',
      'union_not_found',
      'pool_not_found',
      'floor_cannot_be_negative',
      'floor_below_one_payout',
      'union_and_enabled_required',
      'union_and_floor_required',
      'request_failed',
    ]) {
      expect(page, `${reason} must have words for the operator`).toContain(`'${reason}'`);
    }
  });
});
