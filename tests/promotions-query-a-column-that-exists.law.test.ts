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
import { sliceSqlStatement } from './helpers/sourceWindow';

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
    // Select literal CREATE OR REPLACE definitions only. A later terminal
    // migration deliberately mentions the function in its lock-order hardener
    // and ACL statements; those references do not replace this body and must
    // never hide the latest full definition from the guard.
    const definitions = all().flatMap(({ body }) =>
      [
        ...body.matchAll(/^[\t ]*CREATE OR REPLACE FUNCTION public\.fn_mystery_bounty_pay\s*\(/gim),
      ].map((match) =>
        sliceSqlStatement(
          body.slice(match.index),
          'CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pay'
        )
      )
    );
    expect(definitions.length, 'no migration defines fn_mystery_bounty_pay').toBeGreaterThan(0);
    const latest = definitions[definitions.length - 1];

    // The stamp must sit inside the credited branch.
    expect(latest).toMatch(
      /IF COALESCE\(v_credited, false\) THEN[\s\S]{0,400}?SET paid_at = now\(\)/
    );
    // And an award must not be completed over a refusal.
    expect(latest).toMatch(/v_refused/);
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
