import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe('session purchase request persistence', () => {
  it('survives a module reload after an ambiguous response', async () => {
    const firstRuntime = await import('../../src/utils/sessionPurchaseRequest');
    const requestId = firstRuntime.readOrCreateSessionPurchaseRequestId(
      'feature:account-a:tag_pack'
    );

    vi.resetModules();
    const reloadedRuntime = await import('../../src/utils/sessionPurchaseRequest');
    expect(reloadedRuntime.readOrCreateSessionPurchaseRequestId('feature:account-a:tag_pack')).toBe(
      requestId
    );
  });

  it('isolates account and SKU scopes, then rotates only the cleared request', async () => {
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const accountATag = requests.readOrCreateSessionPurchaseRequestId('feature:account-a:tag_pack');
    const accountAEmoji = requests.readOrCreateSessionPurchaseRequestId(
      'feature:account-a:emoji_pack'
    );
    const accountBTag = requests.readOrCreateSessionPurchaseRequestId('feature:account-b:tag_pack');

    expect(accountAEmoji).not.toBe(accountATag);
    expect(accountBTag).not.toBe(accountATag);
    requests.clearSessionPurchaseRequestId('feature:account-a:tag_pack');
    expect(requests.readOrCreateSessionPurchaseRequestId('feature:account-a:tag_pack')).not.toBe(
      accountATag
    );
    expect(requests.readOrCreateSessionPurchaseRequestId('feature:account-b:tag_pack')).toBe(
      accountBTag
    );
  });
});
