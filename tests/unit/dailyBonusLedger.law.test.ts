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

  it('the popup is one per day on every device: the mark lives on the day row', () => {
    const once = migration('the_daily_bonus_pops_up_once_a_day_on_every_device');
    expect(once).toContain('ADD COLUMN IF NOT EXISTS sheet_shown_at timestamptz');
    expect(once).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_mark_shown()');
    expect(once).toContain('SET sheet_shown_at = COALESCE(sheet_shown_at, now())');
    expect(once).toContain("'shown_today', v_day.sheet_shown_at IS NOT NULL");
    expect(once).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_mark_shown() TO authenticated, service_role'
    );
    for (const primitive of CHIP_CREDIT_PRIMITIVES) {
      expect(once.replace(/fn_ca_mint_supply/g, ''), primitive).not.toContain(primitive);
    }
    const fragment = join(
      process.cwd(),
      'scripts/ci/schema-manifest.d/claude-dailybonus-audit.json'
    );
    const json = JSON.parse(readFileSync(fragment, 'utf8')) as {
      functions: string[];
      columns: Record<string, string[]>;
    };
    expect(json.functions).toContain('fn_ca_daily_bonus_mark_shown');
    expect(json.columns.ca_daily_bonus_days).toContain('sheet_shown_at');
  });

  it('the bonus keeps its own books: every refusal is recorded, every claim says where it came from, two rules file once a day', () => {
    const books = migration('the_daily_bonus_keeps_its_own_books');
    expect(books).toContain('CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_refusals');
    expect(books).toContain('ADD COLUMN IF NOT EXISTS claimed_from jsonb');
    expect(books).toContain(
      'DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date)'
    );
    expect(books).toContain('p_client jsonb DEFAULT NULL');
    // the claim body holds no bare refusal: every one goes through the writer
    const start = books.indexOf('CREATE FUNCTION public.fn_ca_daily_bonus_claim(');
    const end = books.indexOf('$$;', books.indexOf('AS $$', start));
    const body = books.slice(start, end);
    expect(body).not.toContain("jsonb_build_object('success', false");
    expect(body.match(/fn_ca_daily_bonus_refuse\(/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(body).toContain('PERFORM public.fn_ca_daily_bonus_velocity_check(v_today, v_from)');
    expect(body).toContain('PERFORM public.fn_ca_daily_bonus_budget_check(v_today)');
    // never a whole IP address
    expect(books).toContain("regexp_replace(v_ip, '\\.\\d{1,3}$', '.x')");
    // the rules file alerts, never refuse
    expect(books).toContain("'fn_ca_daily_bonus_claim.device_velocity'");
    expect(books).toContain("'fn_ca_daily_bonus_claim.ip_velocity'");
    expect(books).toContain("'fn_ca_daily_bonus_claim.budget_anomaly'");
    expect(books).toContain(
      'INSERT INTO public.financial_alerts (severity, source, message, context)'
    );
    for (const primitive of CHIP_CREDIT_PRIMITIVES) {
      expect(books.replace(/fn_ca_mint_supply/g, ''), primitive).not.toContain(primitive);
    }
    const fragment = join(process.cwd(), 'scripts/ci/schema-manifest.d/claude-dailybonus-p1.json');
    const json = JSON.parse(readFileSync(fragment, 'utf8')) as {
      tables: string[];
      functions: string[];
      columns: Record<string, string[]>;
    };
    expect(json.tables).toContain('ca_daily_bonus_refusals');
    expect(json.functions).toEqual(
      expect.arrayContaining([
        'fn_ca_daily_bonus_refuse',
        'fn_ca_daily_bonus_velocity_check',
        'fn_ca_daily_bonus_budget_check',
        'fn_ca_daily_bonus_claimed_from',
      ])
    );
    expect(json.columns.ca_daily_bonus_claims).toContain('claimed_from');
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
