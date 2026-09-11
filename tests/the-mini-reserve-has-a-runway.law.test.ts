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

  it('the migration refuses to retune any pool while installing the mechanism', () => {
    expect(sql).toMatch(/this migration must not change any pool floor/);
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
    expect(fn).toMatch(/if \(!best\) \{[\s\S]{0,320}nearMiss: false/);
  });

  it('settlement asks the mini the question, and cannot break on the answer', () => {
    const settle = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settle).toContain('detectMiniBBJNearMiss(');
    expect(settle).toMatch(/MINI BBJ near-miss check failed/);
    // fire and forget: a record must never be able to stop a payout
    expect(settle).toMatch(/void recordBBJNearMiss\(\{[\s\S]{0,600}miniNearMiss\.reason/);
  });
});
