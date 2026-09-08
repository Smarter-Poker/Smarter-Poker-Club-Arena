/**
 * The store product ids are derived by one rule on the client and seeded by
 * the same rule in the database (20260908000009). Both halves are pinned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diamondProductId, vipProductId, parseIapProductId } from '../../src/lib/iapProducts';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('iap products: one naming rule', () => {
  it('diamond packages', () => {
    expect(diamondProductId('micro')).toBe('poker.smarter.clubarena.diamonds.micro');
    expect(diamondProductId('Whale')).toBe('poker.smarter.clubarena.diamonds.whale');
    expect(() => diamondProductId('../x')).toThrow();
  });
  it('vip tiers, with Stripe annual mapped to the store yearly', () => {
    expect(vipProductId('monthly')).toBe('poker.smarter.clubarena.vip.monthly');
    expect(vipProductId('yearly')).toBe('poker.smarter.clubarena.vip.yearly');
    expect(vipProductId('annual')).toBe('poker.smarter.clubarena.vip.yearly');
    expect(() => vipProductId('daily' as never)).toThrow();
  });
  it('parses its own output and nothing else', () => {
    expect(parseIapProductId('poker.smarter.clubarena.diamonds.micro')).toEqual({
      kind: 'diamonds',
      key: 'micro',
    });
    expect(parseIapProductId('poker.smarter.clubarena.vip.yearly')).toEqual({
      kind: 'vip',
      key: 'yearly',
    });
    expect(parseIapProductId('poker.smarter.clubarena.vip.daily')).toBeNull();
    expect(parseIapProductId('com.other.app.diamonds.micro')).toBeNull();
  });
});

describe('the database seeds the same rule and settles through the same path', () => {
  const sql = read(
    'supabase/migrations/20260908000009_in_app_purchases_settle_through_the_same_idempotent_diamond_.sql'
  );
  it('seeds iap_products from diamond_packages with the prefix', () => {
    expect(sql).toContain(
      "SELECT 'poker.smarter.clubarena.diamonds.' || package_key, 'diamonds', package_key"
    );
    expect(sql).toContain("('poker.smarter.clubarena.vip.monthly', 'vip', 'monthly'");
    expect(sql).toContain("('poker.smarter.clubarena.vip.yearly',  'vip', 'yearly'");
  });
  it('a diamond purchase settles through settle_diamond_card_purchase_atomic, never a second credit path', () => {
    expect(sql).toContain(
      "public.settle_diamond_card_purchase_atomic(v_purchase_id, 'iap:' || v_txn, 'iap:' || v_orig_txn)"
    );
    expect(sql).not.toMatch(/add_diamonds_to_balance\(/);
    expect(sql).not.toMatch(/UPDATE public\.profiles\s+SET diamonds/i);
  });
  it('is idempotent on the event id and unique per store transaction', () => {
    expect(sql).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS diamond_purchases_iap_transaction_uidx'
    );
  });
  it('is service-role only, and asks who is calling', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_iap_settle_event(jsonb) FROM PUBLIC, anon, authenticated;'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_iap_settle_event(jsonb) TO service_role;'
    );
    expect(sql).toMatch(/COALESCE\(auth\.role\(\), current_user\) NOT IN \('service_role'/);
  });
  it('never claws back a refunded diamond purchase (10.9 rule 3)', () => {
    const refund = sql.slice(
      sql.indexOf("ELSIF v_type IN ('CANCELLATION', 'REFUND', 'REFUND_REVERSED')"),
      sql.indexOf(
        "ELSE\n      v_result := jsonb_build_object('success', true, 'ignored', true, 'kind', 'diamonds'"
      )
    );
    expect(refund).toContain('IAP:diamond_refund_received');
    expect(refund).not.toMatch(/diamonds\s*-|deduct|remove_diamonds|subtract/i);
  });
});
