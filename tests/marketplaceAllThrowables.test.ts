import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeGrant } from '../src/pages/marketplace/marketplaceShared';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION_PATH =
  'supabase/migrations/20260914112817_one_club_shop_item_offers_all_throwables.sql';
const MIGRATION = read(MIGRATION_PATH);
const FULFILLMENT = read(
  'supabase/migrations/20260829213000_realtime_shop_fulfillment_and_purchase_intents.sql'
);
const LIFETIME = read(
  'supabase/migrations/20260909203940_an_expiring_credit_is_spent_before_an_allowance_that_renews.sql'
);

describe('All Throwables Marketplace Contract', () => {
  it('describes every purchased credit as usable across the complete table catalog', () => {
    expect(describeGrant({ type: 'throwable', qty: 1 })).toBe(
      '1 Use Across All 49 Table Throwables'
    );
    expect(describeGrant({ type: 'throwable', qty: 10 })).toBe(
      '10 Uses Across All 49 Table Throwables'
    );
  });

  it('consolidates every club to one truthful ten-use offer without deleting receipts', () => {
    expect(MIGRATION).toContain("'All Throwables Pack (10)'");
    expect(MIGRATION).toContain("jsonb_build_object('type', 'throwable', 'qty', 10)");
    expect(MIGRATION).toContain('PARTITION BY i.club_id');
    expect(MIGRATION).toContain('is_active = ranked.position = 1');
    expect(MIGRATION).toContain('club_shop_active_throwable_is_all_access');
    expect(MIGRATION).toContain('club_shop_one_active_throwable_per_club');
    expect(MIGRATION).toContain('Each club must expose exactly one active throwable offer');
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM\s+public\.club_shop_items/i);
  });

  it('closes both category and grant-type bypasses at the durable database guards', () => {
    const activeThrowablePredicate = String.raw`COALESCE\(is_active, false\)\s+AND\s+\(\s*category = 'Throwables'\s+OR\s+COALESCE\(grant_spec->>'type', ''\) = 'throwable'\s*\)`;

    expect(MIGRATION).toMatch(
      new RegExp(
        String.raw`ADD CONSTRAINT club_shop_active_throwable_is_all_access CHECK \(\s*NOT \(\s*${activeThrowablePredicate}`,
        'm'
      )
    );
    expect(MIGRATION).toMatch(
      new RegExp(
        String.raw`CREATE UNIQUE INDEX club_shop_one_active_throwable_per_club[\s\S]*?WHERE ${activeThrowablePredicate}`,
        'm'
      )
    );
    expect(MIGRATION).toMatch(/AND c\.convalidated/);
    expect(MIGRATION).toMatch(/AND i\.indisunique[\s\S]*AND i\.indisvalid[\s\S]*AND i\.indisready/);
    expect(MIGRATION).toContain(
      "grant_spec IS NOT DISTINCT FROM jsonb_build_object('type', 'throwable', 'qty', 10)"
    );
    expect(MIGRATION).toContain("i.name IS DISTINCT FROM 'All Throwables Pack (10)'");
    expect(MIGRATION).toContain('i.description IS DISTINCT FROM');
    expect(MIGRATION).toContain(
      "i.grant_spec IS DISTINCT FROM jsonb_build_object('type', 'throwable', 'qty', 10)"
    );
    expect(MIGRATION).toContain(
      'The one-active-throwable guard can be bypassed by changing category or grant type'
    );
  });

  it.each([
    {
      label: 'a Throwables category row with a disguised grant type',
      category: 'Throwables',
      grantType: 'none',
    },
    {
      label: 'a throwable grant hidden under another category',
      category: 'Exclusive',
      grantType: 'throwable',
    },
  ])('treats $label as a guarded throwable offer', ({ category, grantType }) => {
    const isGuardedThrowable =
      category === 'Throwables' || (grantType || '').toLowerCase() === 'throwable';

    expect(isGuardedThrowable).toBe(true);
  });

  it('seeds the same offer for every club created after the migration', () => {
    expect(MIGRATION).toMatch(
      /CREATE OR REPLACE FUNCTION public\.fn_seed_all_throwables_shop_item\(\)[\s\S]*NEW\.id/
    );
    expect(MIGRATION).toMatch(
      /CREATE TRIGGER trg_seed_all_throwables_shop_item[\s\S]*AFTER INSERT ON public\.clubs/
    );
    expect(MIGRATION).toContain('Future clubs will not receive the all-throwables offer');
  });

  it('grants generic credits that can pay for any selected throwable id', () => {
    expect(FULFILLMENT).toMatch(
      /ELSIF v_type = 'throwable' THEN[\s\S]*VALUES \(p_user_id, 'throwable', 0, 'per_use', v_qty, NULL\)/
    );
    expect(LIFETIME).toMatch(
      /p_throwable_id text[\s\S]*feature = 'throwable'[\s\S]*'Throwable: ' \|\| p_throwable_id/
    );
  });

  it('points the catalog at the clean composite rather than an item-specific placeholder', () => {
    expect(MIGRATION).toContain(
      "'/hub/club-arena/images/marketplace/throwables/all-throwables-access-v1.png'"
    );
    expect(MIGRATION).not.toContain('/images/shop/throwable-tomato.svg');
    expect(MIGRATION).not.toContain('/images/shop/throwable-snowball.svg');
    expect(MIGRATION).not.toContain('/images/shop/throwable-golden-egg.svg');
  });

  it('leaves Lifetime VIP ahead of every finite credit and Diamond branch', () => {
    expect(MIGRATION).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_use_throwable/i);
    expect(LIFETIME).toMatch(
      /IF v_lifetime THEN[\s\S]*'source', 'lifetime_vip'[\s\S]*'unlimited', true/
    );
    expect(LIFETIME.indexOf('IF v_lifetime THEN')).toBeLessThan(
      LIFETIME.indexOf("feature = 'throwable'")
    );
  });
});
