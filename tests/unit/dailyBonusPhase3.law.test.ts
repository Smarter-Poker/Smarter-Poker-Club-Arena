/**
 * THE DAILY BONUS LEARNS TO FORGIVE, BOOST AND GAMBLE - ON THE SERVER, INSIDE
 * THE CAPS, AND NEVER IN CHIPS.
 *
 * Phase 3 of the Daily Club Arena Bonus (Dan, 2026-09-07: rewards include
 * "diamonds, throwables, rabbit hunts, other different things, options,
 * multipliers, etc."). Three new movers, one migration
 * (20260910181625_the_daily_bonus_learns_to_forgive_boost_and_gamble):
 *
 *   - a Streak Shield credit that covers exactly ONE missed day and is spent
 *     by the server at the moment the gap would have reset the streak;
 *   - a lucky 1x-5x multiplier rolled by the server when a mystery tile is
 *     claimed, never by the browser;
 *   - a 24-hour Mission Boost whose EXTRA is paid through award_diamonds_v2
 *     under its own action, so it lives inside the player's 110/150 daily and
 *     3,300/4,500 monthly caps and files under club_arena_daily.
 *
 * Every pin below is anchored on a function, column or constant in the
 * mirrored migration, never on prose. The rules phase 1 and the day-it-saw
 * rewrite established are re-pinned on the phase 3 claim body, because a
 * CREATE OR REPLACE that dropped one of them would still be green everywhere
 * else.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');
const NAME = 'the_daily_bonus_learns_to_forgive_boost_and_gamble';

function migration(nameSuffix: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${nameSuffix}.sql`));
  expect(file, `${nameSuffix} must be mirrored in supabase/migrations`).toBeTruthy();
  return readFileSync(join(MIGRATIONS, file as string), 'utf8');
}

/** The body of one CREATE OR REPLACE FUNCTION, header to closing tag. */
function fnBody(sql: string, fn: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, fn).toBeGreaterThan(0);
  const tagMatch = /\$([A-Za-z_]*)\$/.exec(sql.slice(start));
  expect(tagMatch, `${fn} dollar tag`).toBeTruthy();
  const tag = (tagMatch as RegExpExecArray)[0];
  const open = start + (tagMatch as RegExpExecArray).index + tag.length;
  const close = sql.indexOf(tag, open);
  expect(close, `${fn} closing tag`).toBeGreaterThan(open);
  return sql.slice(start, close);
}

const CHIP_CREDIT_PRIMITIVES = [
  'atomic_credit_wallet_and_log',
  'credit_player_wallet',
  'fn_credit_chips',
  'fn_credit_player_wallet_once',
  'increment_union_wallet',
  'fn_ca_mint',
];

describe('daily bonus phase 3 law', () => {
  const sql = migration(NAME);

  it('is one transaction with a lock timeout, and the two hot foreign keys are its last statements', () => {
    expect(sql).toContain('\nBEGIN;\n');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '4s';");
    const lastFunction = sql.lastIndexOf('CREATE OR REPLACE FUNCTION');
    const profilesFk = sql.indexOf(
      'ADD CONSTRAINT player_boosts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE'
    );
    const purchasesFk = sql.indexOf(
      'ADD COLUMN IF NOT EXISTS shield_consumed_id uuid REFERENCES public.feature_purchases(id)'
    );
    expect(profilesFk).toBeGreaterThan(lastFunction);
    expect(purchasesFk).toBeGreaterThan(lastFunction);
    // the table itself carries no inline reference to the hot table
    expect(sql).toContain(
      'user_id          uuid NOT NULL,  -- FOREIGN KEY added in section 1b, at the end'
    );
    expect(sql.split('REFERENCES public.profiles').length - 1).toBe(1);
  });

  it('the boost extra is paid through award_diamonds_v2 under daily_bonus_boost, clamped, inside the caps', () => {
    const extra = fnBody(sql, 'fn_ca_daily_bonus_boost_extra');
    expect(extra).toContain('SECURITY DEFINER');
    expect(extra).toContain("p_user_id, 'daily_bonus_boost',");
    expect(extra).toContain("'ca_daily_bonus:boost:' || p_user_id::text || ':' ||");
    expect(extra).toContain("'bonus_diamonds', LEAST(125, v_extra)");
    expect(extra).toContain('v_extra := round(p_base * (v_boost.factor - 1.00))::integer;');
    expect(extra).toContain('FOR UPDATE;');
    // the action's own catalog row counts toward the daily cap, 24 pays a day at most
    expect(sql).toContain("VALUES ('daily_bonus_boost', 0, 24, true, false, 'daily', true)");
    // award_diamonds_v2 reads the amount from metadata on the daily_bonus branch, now shared
    expect(sql).toContain("ELSIF p_action_key IN (''daily_bonus'', ''daily_bonus_boost'') THEN");
    // the profile guard admits the extra on its call stack, like the claim
    expect(sql).toContain('fn_ca_daily_bonus_boost_extra[(]');
    // a browser cannot call it
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_boost_extra(uuid, integer, text) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('Daily Missions pay the extra only after their own diamonds, from inside the serialized body', () => {
    expect(sql).toContain(
      "pg_get_functiondef('public.claim_daily_challenges_serialized_body(uuid,uuid[],uuid)'::regprocedure)"
    );
    expect(sql).toContain('v_boost jsonb := NULL;');
    expect(sql).toContain('v_boost := public.fn_ca_daily_bonus_boost_extra(v_uid, v_diamonds,');
    expect(sql).toContain("''boost'', v_boost,");
    // the patch refuses to apply twice
    expect(sql).toContain("RAISE EXCEPTION 'missions patch: already applied'");
  });

  it('the rolls are server functions no browser can call, and the claim rolls the lucky multiplier at the tap', () => {
    for (const roll of ['fn_ca_daily_bonus_roll_mystery', 'fn_ca_daily_bonus_roll_lucky']) {
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${roll}()`);
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${roll}() FROM PUBLIC, anon, authenticated;`
      );
    }
    const lucky = fnBody(sql, 'fn_ca_daily_bonus_roll_lucky');
    expect(lucky).toContain('WHEN v_roll < 0.55 THEN 1');
    expect(lucky).toContain('ELSE 5');
    const openDay = fnBody(sql, 'fn_ca_daily_bonus_open_day');
    expect(openDay).toContain('v_mystery := public.fn_ca_daily_bonus_roll_mystery();');
    const claim = fnBody(sql, 'fn_ca_daily_bonus_claim');
    expect(claim).toContain('v_lucky    := public.fn_ca_daily_bonus_roll_lucky();');
    expect(claim).toContain('v_diamonds := LEAST(125, v_diamonds * v_lucky);');
    expect(claim).toContain("'lucky', v_lucky");
  });

  it('a shield covers exactly one missed day and is spent by the server; two missed days reset', () => {
    const openDay = fnBody(sql, 'fn_ca_daily_bonus_open_day');
    expect(openDay).toContain('IF FOUND AND v_last.bonus_date = p_today - 2 THEN');
    expect(openDay).toContain("f.feature = 'streak_shield'");
    expect(openDay).toContain('FOR UPDATE SKIP LOCKED;');
    expect(openDay).toContain(
      'UPDATE public.feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_shield.id;'
    );
    expect(openDay).toContain('v_streak    := v_last.streak + 1;');
    expect(openDay).toContain('v_protected := true;');
    expect(openDay).toContain('IF NOT v_protected THEN\n      v_streak := 1;');
    expect(openDay).toContain('streak_protected, shield_consumed_id)');
    // the shield tile is a feature_purchases credit at cost 0 that lives 30 days
    const claim = fnBody(sql, 'fn_ca_daily_bonus_claim');
    expect(claim).toContain(
      "ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank', 'shield') THEN"
    );
    expect(claim).toContain("WHEN 'shield'       THEN 'streak_shield'");
    expect(claim).toContain(
      "now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,"
    );
    // the calendar knows the two new kinds and their shapes
    expect(sql).toContain("OR (kind = 'shield' AND quantity > 0 AND diamonds = 0)");
    expect(sql).toContain("OR (kind = 'boost'  AND quantity > 0 AND diamonds = 0)");
    expect(sql).toContain("(4,    NULL::int, 3, 'shield', 1,  0, false, 'Streak Shield', true)");
    expect(sql).toContain("(7,    NULL::int, 4, 'boost',  24, 0, false, 'Mission Boost', true)");
  });

  it('one live boost per player, written after the claim row it references, never paid in chips', () => {
    const claim = fnBody(sql, 'fn_ca_daily_bonus_claim');
    expect(claim).toContain("'boost_already_live'");
    expect(claim).toContain("b.kind = 'mission_diamonds' AND b.ends_at > now()");
    expect(claim).toContain('v_boost_ends := now() + make_interval(hours => v_qty);');
    const claimsInsert = claim.indexOf('INSERT INTO public.ca_daily_bonus_claims (');
    const boostInsert = claim.indexOf('INSERT INTO public.player_boosts (');
    expect(claimsInsert).toBeGreaterThan(0);
    expect(boostInsert).toBeGreaterThan(claimsInsert);
    expect(sql).toContain("kind             text NOT NULL CHECK (kind IN ('mission_diamonds'))");
    expect(sql).toContain(
      'factor           numeric(4,2) NOT NULL CHECK (factor > 1.00 AND factor <= 5.00)'
    );
    // the browser may read its own boosts and nothing else
    expect(sql).toContain('ALTER TABLE public.player_boosts ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('FOR SELECT USING (auth.uid() = user_id)');
    expect(sql).toContain('REVOKE ALL ON public.player_boosts FROM anon, authenticated;');
    expect(sql).toContain('GRANT SELECT ON public.player_boosts TO authenticated;');
    for (const primitive of CHIP_CREDIT_PRIMITIVES) {
      expect(sql, primitive).not.toContain(primitive);
    }
  });

  it('the claim rewrite keeps every rule the earlier laws pinned', () => {
    const claim = fnBody(sql, 'fn_ca_daily_bonus_claim');
    for (const rule of [
      'IF v_uid IS NULL AND public.fn_caller_is_engine() THEN',
      'Cannot claim a daily bonus for another player',
      'requires an authenticated caller',
      "'already_claimed'",
      "'vip_only'",
      'pg_advisory_xact_lock',
      "'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text",
      'p_bonus_date date DEFAULT NULL',
    ]) {
      expect(claim, rule).toContain(rule);
    }
    const refusal = claim.indexOf("'day_rolled_over'");
    const opens = claim.indexOf('v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today)');
    const pays = claim.indexOf('public.award_diamonds_v2(');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(opens);
    expect(refusal).toBeLessThan(pays);
    // no new browser grant anywhere in the migration: the claim and status keep the ACL they had
    expect(sql).not.toContain('GRANT EXECUTE');
  });

  it('the read side reports the shield, the boost and a protected day', () => {
    const status = fnBody(sql, 'fn_ca_daily_bonus_status');
    expect(status).toContain(
      "'shield', COALESCE(v_shield, jsonb_build_object('held', 0, 'expires_at', NULL))"
    );
    expect(status).toContain("'streak_protected', COALESCE(v_day.streak_protected, false)");
    expect(status).toContain("'boost', COALESCE(v_boost, jsonb_build_object('active', false))");
    expect(status).toContain("f.feature = 'streak_shield'");
  });

  it('the money registry and the schema fragment name every new mover', () => {
    for (const fn of [
      'fn_ca_daily_bonus_boost_extra',
      'fn_ca_daily_bonus_roll_mystery',
      'fn_ca_daily_bonus_roll_lucky',
    ]) {
      expect(sql).toContain(`('${fn}', 'approved',`);
    }
    const fragment = join(process.cwd(), 'scripts/ci/schema-manifest.d/cw-dailybonus3.json');
    expect(existsSync(fragment)).toBe(true);
    const json = JSON.parse(readFileSync(fragment, 'utf8')) as {
      tables: string[];
      functions: string[];
      columns: Record<string, string[]>;
    };
    expect(json.tables).toContain('player_boosts');
    expect(json.functions).toEqual(
      expect.arrayContaining([
        'fn_ca_daily_bonus_boost_extra',
        'fn_ca_daily_bonus_roll_mystery',
        'fn_ca_daily_bonus_roll_lucky',
      ])
    );
    expect(json.columns.ca_daily_bonus_days).toEqual(
      expect.arrayContaining(['streak_protected', 'shield_consumed_id'])
    );
  });
});
