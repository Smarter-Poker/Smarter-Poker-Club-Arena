/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A QUERY MUST FILTER ON A COLUMN THAT EXISTS (2026-08-29)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `PromotionService.applyDepositBonus` and `processReferral` filtered on
 * `is_active`. The `promotions` table has no such column -- it carries
 * `status text CHECK (status IN ('scheduled','active','paused','completed',
 * 'cancelled'))`, confirmed against the live schema on 2026-08-29.
 *
 * So PostgREST returned 42703 and the whole query failed. Neither call site
 * destructured `error`, so the failure was indistinguishable from "no such
 * promotion configured": `applyDepositBonus` returned 0 every time and
 * `processReferral` returned without paying, for as long as both have existed.
 *
 * The tell that this was a mistake rather than a design is inside the same
 * file: `getPromotions` filters on `status` correctly, and the mapper's own
 * comment reads "promotions has `status` (open/active/...), not a boolean
 * is_active." Two paths in one file disagreeing, with only one of them ever
 * exercised.
 *
 * No money was lost -- no deposit_match or refer_friend promotion has ever
 * been configured, so there was nothing to pay. That is luck, not safety: the
 * day somebody configures one, it silently pays nobody.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on prose describing the old code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const SERVICE = code(read('src/services/PromotionService.ts'));

describe('PromotionService filters on real columns', () => {
  it('never filters promotions on is_active', () => {
    expect(
      SERVICE,
      'promotions has no is_active column; PostgREST fails the whole query with 42703'
    ).not.toMatch(/\.eq\(\s*'is_active'/);
  });

  it('filters on status instead', () => {
    // Both bonus paths, plus the listing path that was always right.
    const statusFilters = SERVICE.match(/\.eq\(\s*'status',\s*'active'\s*\)/g) ?? [];
    expect(statusFilters.length).toBeGreaterThanOrEqual(2);
  });

  it('checks the error on both bonus lookups', () => {
    // The discarded error is what turned a broken query into "no promotion
    // exists". A promotion that cannot be READ is not a promotion that is
    // absent.
    expect(SERVICE).toMatch(/deposit_bonus_lookup_failed/);
    expect(SERVICE).toMatch(/referral_promo_lookup_failed/);
  });
});

describe('the money-path migrations that guard the bounty chests', () => {
  const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');
  const all = () =>
    fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: f, body: fs.readFileSync(path.join(MIGRATIONS, f), 'utf8') }));

  it('an award cannot commit without recipients', () => {
    /**
     * fn_mystery_bounty_reserve consumes the chest and inserts the award
     * BEFORE it knows who the recipients are, and then `RETURN`s -- which
     * COMMITS -- when there are none. The chest is then swept to the champion
     * as "unclaimed", which is money taken from the knocker who earned it.
     *
     * The guard is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so it
     * sees the whole transaction and covers every writer, not just this one.
     */
    const owning = all().filter((m) => m.body.includes('trg_bounty_award_has_recipients'));
    expect(owning.length, 'the award guard migration is missing').toBeGreaterThan(0);
    const latest = owning[owning.length - 1].body;
    expect(latest).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    expect(latest).toMatch(/NO recipients/);
  });

  it('a recipient is only marked paid when the credit moved', () => {
    /**
     * `paid_at` was stamped before the credit result was read, and the retry
     * loop selects `WHERE paid_at IS NULL` -- so a refused credit was excluded
     * from retry forever, and fn_mystery_bounty_settle then reported the event
     * "balanced" off that same false flag.
     */
    const owning = all().filter((m) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_mystery_bounty_pay\s*\(/i.test(m.body)
    );
    expect(owning.length, 'no migration defines fn_mystery_bounty_pay').toBeGreaterThan(0);
    const latest = owning[owning.length - 1].body;
    const creditedImplementation = owning.find((m) =>
      m.body.includes('A RECIPIENT IS ONLY "PAID" IF THE CREDIT ACTUALLY MOVED')
    )?.body;
    expect(
      creditedImplementation,
      'the credit-checked mystery bounty payer migration is missing'
    ).toBeDefined();

    // The original correction must keep the paid marker inside the branch
    // whose wallet credit actually moved.
    expect(creditedImplementation).toMatch(
      /IF COALESCE\(v_credited, false\) THEN[\s\S]*?SET paid_at = now\(\)/
    );
    expect(creditedImplementation).toMatch(/v_refused/);

    // The outbox hardening edits that exact credited branch in the stored
    // function body, strengthening it to require the exact paid amount before
    // the same recipient UPDATE. It then seals the implementation behind a
    // tournament-first wrapper.
    const hardening = all().find((m) =>
      m.body.includes('fn_mystery_bounty_pay exact-credit substitution did not match exactly once')
    )?.body;
    expect(hardening, 'the atomic mystery payer hardening is missing').toBeDefined();
    expect(hardening).toMatch(
      /v_old := \$old\$IF COALESCE\(v_credited, false\) THEN[\s\S]*?v_new := \$new\$IF COALESCE\(v_credited, false\)[\s\S]*?UPDATE public\.tournament_bounty_award_recipients/
    );
    expect(hardening).toContain(
      'RETURN public.fn_mystery_bounty_pay_unguarded_20260907(p_award_id)'
    );

    // The terminal authority must now own the tournament and keep the
    // exact-credit check in its self-contained root. Stage two removes the
    // temporary rolling-deployment helper, so delegating to it here would
    // reopen the money path after cleanup.
    const latestPayer = latest.match(
      /CREATE OR REPLACE FUNCTION public\.fn_mystery_bounty_pay\(p_award_id uuid\)[\s\S]*?\$function\$;/
    )?.[0];
    expect(latestPayer, 'the latest migration has no complete mystery payer root').toBeDefined();
    expect(latestPayer).toMatch(
      /PERFORM 1 FROM public\.tournaments t WHERE t\.id=v_tournament_id FOR UPDATE;[\s\S]*?IF COALESCE\(v_credited, false\)[\s\S]*?AND round\(COALESCE\(\(v_settle->>'paid'\)::numeric,0\),2\)[\s\S]*?UPDATE public\.tournament_bounty_award_recipients[\s\S]*?SET paid_at = now\(\)/
    );
    expect(latestPayer).not.toContain('fn_mystery_bounty_pay_unguarded_20260907');
  });
});

describe('a promotion cannot advertise a prize nobody can win, silently', () => {
  /**
   * `promotion_leaderboards.prize` is read and rendered to players. NOTHING
   * writes it: updateLeaderboardScore upserts `score` only, and
   * recalculate_leaderboard_ranks writes `rank` and `updated_at` only. There is
   * no high-hand scorer, no rake-race settler and no leaderboard payout job
   * anywhere in the repo.
   *
   * So a club can advertise a prize pool on a leaderboard / high_hand /
   * rake_race promotion, players can enter and qualify, and nobody can ever be
   * paid. Measured 2026-08-29: four promotions carrying 9,500 of advertised
   * pool, zero leaderboard entries, zero prizes written.
   *
   * The payout itself is NOT built here on purpose -- how a pool splits by
   * rank and what qualifies are product rules, and inventing them is the
   * mistake that had fn_settle_tournament_rake paying nobody for 39 events.
   * The guard makes the gap loud instead of silent.
   *
   * WHEN THE PAYOUT IS BUILT: delete the trigger and this test together.
   */
  const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');

  it('warns when an unpayable promotion type goes active with a prize pool', () => {
    const owning = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .filter((b) => b.includes('trg_promotion_prize_has_no_payout_path'));

    expect(owning.length, 'the no-payout-path guard migration is missing').toBeGreaterThan(0);
    const latest = owning[owning.length - 1];
    expect(latest).toMatch(/'leaderboard', 'high_hand', 'rake_race'/);
    expect(latest).toMatch(/promotions\.no_payout_path/);
    // It must WARN, never block: refusing the insert would break a club
    // mid-setup for a feature gap that is not their fault.
    expect(latest).not.toMatch(/RAISE EXCEPTION[^;]*no_payout_path/);
  });

  it('still has no writer for promotion_leaderboards.prize — the guard is not vacuous', () => {
    // If this ever fails, the payout was built: delete the trigger and this
    // whole describe block.
    const svc = read('src/services/PromotionService.ts');
    expect(svc).not.toMatch(/promotion_leaderboards[\s\S]{0,300}?prize:/);
  });
});
