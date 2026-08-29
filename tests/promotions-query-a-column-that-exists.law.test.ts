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
    const owning = all().filter((m) => m.body.includes('FUNCTION public.fn_mystery_bounty_pay'));
    expect(owning.length, 'no migration defines fn_mystery_bounty_pay').toBeGreaterThan(0);
    const latest = owning[owning.length - 1].body;

    // The stamp must sit inside the credited branch.
    expect(latest).toMatch(
      /IF COALESCE\(v_credited, false\) THEN[\s\S]{0,400}?SET paid_at = now\(\)/
    );
    // And an award must not be completed over a refusal.
    expect(latest).toMatch(/v_refused/);
  });
});
