/**
 * THE DAILY CLUB ARENA BONUS PAYS DIAMONDS AND CREDITS, NEVER CHIPS.
 *
 * Dan, 2026-09-05: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS." The chip
 * daily-bonus ladder this feature replaced was dropped on 2026-09-07
 * (20260907232514). These pins keep the replacement honest at the file level:
 * the ledger migration must pay through award_diamonds_v2, must never name a
 * chip credit primitive, and must keep the bonus inside the per-player
 * diamond caps (Dan, 2026-09-07: "FOLLOW THE DIAMOND GUIDELINES THAT EXIST
 * NOW FOR MAX AWARDED PER DAY"; "THERE SHOULDN'T BE A PLATFORM LIMIT, JUST A
 * USER LIMIT").
 *
 * Anchored on function and column names, never on prose.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

function migration(nameSuffix: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${nameSuffix}.sql`));
  expect(file, `${nameSuffix} must be mirrored in supabase/migrations`).toBeTruthy();
  return readFileSync(join(MIGRATIONS, file as string), 'utf8');
}

const CHIP_CREDIT_PRIMITIVES = [
  'atomic_credit_wallet_and_log',
  'credit_player_wallet',
  'fn_credit_chips',
  'fn_credit_player_wallet_once',
  'increment_union_wallet',
  'fn_ca_mint',
];

describe('daily bonus ledger law', () => {
  const ledger = migration('the_daily_club_arena_bonus_has_a_ledger');
  const caps = migration('the_daily_bonus_lives_inside_the_diamond_caps');
  const limit = migration('the_daily_bonus_has_a_user_limit_not_a_platform_limit');

  it('the chip ladder migration is mirrored and drops every chip-paying bonus function', () => {
    const retire = migration('a_daily_bonus_pays_nothing_in_chips');
    for (const fn of [
      'fn_claim_daily_bonus()',
      'fn_daily_bonus_status()',
      'fn_grant_daily_reward(uuid, numeric)',
      'claim_daily_bonus(uuid, numeric)',
      'fn_claim_special_bonus(uuid)',
    ]) {
      expect(retire).toContain(`DROP FUNCTION IF EXISTS public.${fn}`);
    }
    expect(retire).toContain('DROP TABLE IF EXISTS public.daily_bonus_rewards');
    expect(retire).toContain(
      'REVOKE EXECUTE ON FUNCTION public.claim_lucky_wheel_spin(uuid) FROM authenticated'
    );
  });

  it('diamonds are paid through award_diamonds_v2 under the daily_bonus action with a per-slot reference', () => {
    expect(ledger).toContain('public.award_diamonds_v2(');
    expect(ledger).toContain("'daily_bonus'");
    expect(ledger).toContain(
      "'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text"
    );
  });

  it('no chip credit primitive appears anywhere in the daily bonus migrations', () => {
    for (const primitive of CHIP_CREDIT_PRIMITIVES) {
      expect(ledger, primitive).not.toContain(primitive);
      expect(caps, primitive).not.toContain(primitive);
    }
  });

  it('consumables are feature_purchases credits at cost 0 with a source', () => {
    expect(ledger).toContain("ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'purchase'");
    expect(ledger).toContain(
      'INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)'
    );
    expect(ledger).toContain("'daily_bonus')");
  });

  it('the bonus counts toward the per-player daily cap and has no platform ceiling', () => {
    expect(caps).toContain('SET counts_toward_daily_cap = true');
    expect(limit).toContain('SET budget_diamonds = 9223372036854775807');
    expect(limit).toContain("WHERE engine = 'club_arena_daily'");
  });

  it('the calendar cannot hold a tile above the 125-per-claim clamp', () => {
    expect(ledger).toContain(
      'diamonds     integer NOT NULL DEFAULT 0 CHECK (diamonds BETWEEN 0 AND 125)'
    );
  });

  it('the claim journal is append-only and the browser cannot read the payout table', () => {
    expect(ledger).toContain('trg_ca_daily_bonus_claims_append_only');
    expect(ledger).toContain(
      'REVOKE ALL ON TABLE public.ca_daily_bonus_calendar FROM PUBLIC, anon, authenticated'
    );
    expect(ledger).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid) TO authenticated, service_role'
    );
  });

  it('the claim names the day the sheet showed, and refuses before it opens or pays anything', () => {
    const day = migration('the_daily_bonus_claim_names_the_day_it_saw');
    expect(day).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid, uuid)'
    );
    expect(day).toContain('p_bonus_date date DEFAULT NULL');
    const refusal = day.indexOf("'day_rolled_over'");
    const opens = day.indexOf('v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today)');
    const pays = day.indexOf('public.award_diamonds_v2(');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(opens);
    expect(refusal).toBeLessThan(pays);
    expect(day).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date) TO authenticated, service_role'
    );
    // every rule the horse migration pinned survives the rewrite
    for (const rule of [
      'IF v_uid IS NULL AND public.fn_caller_is_engine() THEN',
      'Cannot claim a daily bonus for another player',
      'requires an authenticated caller',
      "'already_claimed'",
      "'vip_only'",
      'pg_advisory_xact_lock',
      "'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text",
    ]) {
      expect(day, rule).toContain(rule);
    }
    // fn_ca_mint_supply is the register read the assertion block compares
    // against; it is not the mint.
    const dayBody = day.replace(/fn_ca_mint_supply/g, '');
    for (const primitive of CHIP_CREDIT_PRIMITIVES) {
      expect(dayBody, primitive).not.toContain(primitive);
    }
  });

  it('a bonus credit that expires is spent before an allowance that renews, in every consumer', () => {
    const order = migration('an_expiring_credit_is_spent_before_an_allowance_that_renews');
    const body = (fn: string) => {
      const start = order.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(start, fn).toBeGreaterThan(0);
      const end = order.indexOf('$function$;', start);
      return order.slice(start, end);
    };
    const throwable = body('fn_use_throwable_v2');
    expect(throwable.indexOf('IF v_lifetime THEN')).toBeLessThan(
      throwable.indexOf('expires_at IS NOT NULL')
    );
    expect(throwable.indexOf('expires_at IS NOT NULL')).toBeLessThan(
      throwable.indexOf("'member_monthly'")
    );
    expect(throwable).toContain('ORDER BY expires_at ASC, created_at ASC');
    expect(throwable).toContain('public.deduct_diamonds(');

    const rabbit = body('fn_consume_rabbit_hunt_v2');
    expect(rabbit.indexOf('IF v_is_lifetime THEN')).toBeLessThan(
      rabbit.indexOf('expires_at IS NOT NULL')
    );
    expect(rabbit.indexOf('expires_at IS NOT NULL')).toBeLessThan(rabbit.indexOf("'vip_monthly'"));
    expect(rabbit).toContain('is engine-only');

    const bank = body('fn_consume_time_bank');
    expect(bank.indexOf('IF v_is_lifetime THEN')).toBeLessThan(
      bank.indexOf('expires_at IS NOT NULL')
    );
    expect(bank.indexOf('expires_at IS NOT NULL')).toBeLessThan(bank.indexOf('120 - v_used'));
    expect(bank).toContain('is engine-only');
    // no consumer is granted to a browser role it did not already have
    expect(order).not.toContain('GRANT EXECUTE');
  });

  it('the schema fragment declares every new object for the phantom gates', () => {
    const fragment = join(process.cwd(), 'scripts/ci/schema-manifest.d/cw-dailybonus.json');
    expect(existsSync(fragment)).toBe(true);
    const json = JSON.parse(readFileSync(fragment, 'utf8')) as {
      tables: string[];
      functions: string[];
    };
    expect(json.tables).toEqual(
      expect.arrayContaining([
        'ca_daily_bonus_calendar',
        'ca_daily_bonus_days',
        'ca_daily_bonus_claims',
      ])
    );
    expect(json.functions).toEqual(
      expect.arrayContaining(['fn_ca_daily_bonus_status', 'fn_ca_daily_bonus_claim'])
    );
  });
});
