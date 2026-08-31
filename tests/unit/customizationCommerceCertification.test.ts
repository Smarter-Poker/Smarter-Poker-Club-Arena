import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('customization commerce certification', () => {
  it('guards overlapping permanent entitlements before charging diamonds', () => {
    const migration = source(
      'supabase/migrations/20260830203000_entitlement_aware_customization_purchases.sql'
    );

    const lock = migration.indexOf('fn_purchase_feature:customization:');
    const ownership = migration.indexOf('sp_theme_asset_is_owned');
    const debit = migration.indexOf('deduct_diamonds');
    expect(lock).toBeGreaterThan(0);
    expect(ownership).toBeGreaterThan(lock);
    expect(debit).toBeGreaterThan(ownership);
    expect(migration).toContain("'ownership_source', 'entitlement'");
    expect(migration).toContain("'ownership_source', 'purchase_receipt'");
  });

  it('keeps the destructive harness reserved and new service keys server-safe', () => {
    const helper = source('tests/e2e/support/temporaryCustomizationAccount.ts');

    expect(helper).toContain("const ACCOUNT_PREFIX = 'ca-customization-cert-'");
    expect(helper).toContain("email.endsWith('@example.invalid')");
    expect(helper).toContain("key.startsWith('sb_secret_')");
    expect(helper).toContain('body: JSON.stringify({ should_soft_delete: false })');
    expect(helper).not.toContain('?should_soft_delete=false');
    expect(helper).toContain('reserved fixture still exists after hard delete');
  });

  it('certifies all live SKUs, double-buy serialization, realtime delivery and RLS', () => {
    const spec = source('tests/e2e/production-customization-commerce.spec.ts');

    expect(spec).toContain('expect(skus.length).toBeGreaterThanOrEqual(60)');
    expect(spec).toContain('for (const sku of purchaseOrder(skus, firstFeature))');
    expect(spec).toContain('Both requests must reach the RPC');
    expect(spec).toContain('await expectNoLockedAssets(secondStudio)');
    expect(spec).toContain("expect(linkedPurchase?.ownership_source).toBe('entitlement')");
    expect(spec).toContain('expect(leakedUnlocks).toEqual([])');
    expect(spec).toContain('cleanupTemporaryCustomizationAccount(environment, account)');
  });

  it('runs the isolated certification after every successful production publish', () => {
    const workflow = source('.github/workflows/post-deploy-e2e.yml');

    expect(workflow).toContain("CUSTOMIZATION_COMMERCE_CERTIFICATION: '1'");
    expect(workflow).toContain(
      'SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}'
    );
    expect(workflow).toContain('tests/e2e/production-customization-commerce.spec.ts');
  });
});
