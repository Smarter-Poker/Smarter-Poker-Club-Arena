import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callServiceRpc,
  type CustomizationCertificationEnvironment,
} from '../e2e/support/temporaryCustomizationAccount';

const root = resolve(import.meta.dirname, '../..');

function source(path: string) {
  return readFileSync(resolve(root, path), 'utf8');
}

const environment: CustomizationCertificationEnvironment = {
  supabaseUrl: 'https://certification.invalid',
  serviceRoleKey: 'service-role-test-key',
  publishableKey: 'publishable-test-key',
};

describe('customization commerce certification', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
    expect(helper).toContain("'cleanup_reserved_certification_account'");
    expect(helper).toContain('p_user_id: account.id');
    expect(helper).not.toContain('/auth/v1/admin/users/${encodeURIComponent(account.id)}');
    expect(helper).toContain('reserved fixture still exists after hard delete');
    expect(helper).toContain('withCleanupRetries');
    expect(helper).toContain('PGRST00[0123]');
    expect(helper).toContain('CLEANUP_RETRY_DELAYS_MS');
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

  it('retries a POST only when PGRST002 proves the RPC was never dispatched', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'PGRST002', message: 'schema cache is reconnecting' }),
          { status: 503 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = callServiceRpc<{ success: boolean }>(environment, 'safe_probe', {
      reference: 'one-logical-operation',
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous POST gateway failure that could double-write', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'gateway unavailable' }), { status: 503 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callServiceRpc(environment, 'unsafe_probe', { amount: 1 })).rejects.toThrow(
      'failed (503)'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
