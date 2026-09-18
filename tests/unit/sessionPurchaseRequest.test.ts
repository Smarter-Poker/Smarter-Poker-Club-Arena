import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const v3Key = (scope: string) => `sp:purchase-request:v3:${encodeURIComponent(scope)}`;
const legacyIdKey = (scope: string) => `sp:purchase-request:v2:${encodeURIComponent(scope)}`;
const legacyPayloadKey = (scope: string) =>
  `sp:purchase-request-payload:v1:${encodeURIComponent(scope)}`;

beforeEach(() => sessionStorage.clear());

afterEach(() => {
  globalThis.sessionStorage?.clear?.();
  vi.unstubAllGlobals();
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

  it('persists the request identity and exact payload in one read-backed record', async () => {
    const scope = 'club-shop:account-a:club-a:time-bank:qty=1';
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const created = requests.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2000');

    expect(sessionStorage.length).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(v3Key(scope)) || '{}')).toEqual({
      version: 3,
      requestId: created.requestId,
      payloadKey: 'expected-price=2000',
    });
  });

  it('binds an ambiguous retry to the original payload across a module reload', async () => {
    const scope = 'club-shop:account-a:club-a:time-bank:qty=1';
    const firstRuntime = await import('../../src/utils/sessionPurchaseRequest');
    const first = firstRuntime.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2000');

    vi.resetModules();
    const reloadedRuntime = await import('../../src/utils/sessionPurchaseRequest');
    const replay = reloadedRuntime.readOrCreateSessionPurchaseRequest(scope, 'expected-price=9000');

    expect(replay.requestId).toBe(first.requestId);
    expect(replay.payloadKey).toBe('expected-price=2000');
    expect(replay.resumed).toBe(true);
  });

  it('migrates a complete legacy split record before clearing its old keys', async () => {
    const scope = 'club-shop:account-a:club-a:time-bank:qty=1';
    const requestId = '11111111-1111-4111-8111-111111111111';
    sessionStorage.setItem(legacyIdKey(scope), requestId);
    sessionStorage.setItem(legacyPayloadKey(scope), 'expected-price=2000');

    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const migrated = requests.readSessionPurchaseRequest(scope);

    expect(migrated).toEqual({
      requestId,
      payloadKey: 'expected-price=2000',
      resumed: true,
    });
    expect(sessionStorage.getItem(legacyIdKey(scope))).toBeNull();
    expect(sessionStorage.getItem(legacyPayloadKey(scope))).toBeNull();
    expect(sessionStorage.getItem(v3Key(scope))).not.toBeNull();
  });

  it('blocks an orphaned legacy request instead of rebinding it to current terms', async () => {
    const scope = 'club-shop:account-a:club-a:time-bank:qty=1';
    sessionStorage.setItem(legacyIdKey(scope), '11111111-1111-4111-8111-111111111111');
    const requests = await import('../../src/utils/sessionPurchaseRequest');

    expect(() => requests.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2000')).toThrow(
      /Earlier Purchase Could Not Be Safely Recovered/
    );
    expect(sessionStorage.getItem(legacyIdKey(scope))).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(v3Key(scope)) || '{}')).toMatchObject({
      version: 3,
      blocked: true,
      reason: 'incomplete_legacy_binding',
    });
    expect(() => requests.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2000')).toThrow(
      /Earlier Purchase Could Not Be Safely Recovered/
    );
  });

  it('fails closed when an atomic write cannot be read back', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });
    const requests = await import('../../src/utils/sessionPurchaseRequest');

    expect(() =>
      requests.readOrCreateSessionPurchaseRequest(
        'club-shop:account-a:club-a:time-bank:qty=1',
        'expected-price=2000'
      )
    ).toThrow('Protected Purchase Storage Is Unavailable');
  });

  it('rotates the atomic request only after its authoritative finish is cleared', async () => {
    const scope = 'club-shop:account-a:club-a:time-bank:qty=1';
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const first = requests.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2000');

    requests.clearSessionPurchaseRequestId(scope);
    const next = requests.readOrCreateSessionPurchaseRequest(scope, 'expected-price=2500');

    expect(next.requestId).not.toBe(first.requestId);
    expect(next.payloadKey).toBe('expected-price=2500');
    expect(next.resumed).toBe(false);
  });

  it('locates and retires only the exact verified request identity', async () => {
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const firstScope = 'marketplace:diamond-package-card:account-a:medium';
    const secondScope = 'marketplace:vip-card:account-a:vip-monthly';
    const first = requests.readOrCreateSessionPurchaseRequest(firstScope, 'medium-terms');
    const second = requests.readOrCreateSessionPurchaseRequest(secondScope, 'monthly-terms');

    expect(requests.readSessionPurchaseRequestById(first.requestId)).toEqual({
      scope: firstScope,
      requestId: first.requestId,
      payloadKey: 'medium-terms',
      resumed: true,
    });
    expect(requests.clearSessionPurchaseRequestById(first.requestId)).toBe(true);
    expect(requests.readSessionPurchaseRequestById(first.requestId)).toBeNull();
    expect(requests.readSessionPurchaseRequestById(second.requestId)?.scope).toBe(secondScope);
    expect(requests.clearSessionPurchaseRequestById(first.requestId)).toBe(false);
  });

  it('compare-and-swap retirement preserves a different scope or replacement identity', async () => {
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const firstScope = 'club-shop:account-a:club-a:item-a:qty=1';
    const secondScope = 'club-shop:account-a:club-a:item-b:qty=1';
    const first = requests.readOrCreateSessionPurchaseRequest(firstScope, 'expected-price=100');
    const second = requests.readOrCreateSessionPurchaseRequest(secondScope, 'expected-price=200');

    expect(requests.clearSessionPurchaseRequestIfMatches(firstScope, second.requestId)).toBe(false);
    expect(requests.clearSessionPurchaseRequestIfMatches(secondScope, first.requestId)).toBe(false);
    expect(requests.readSessionPurchaseRequest(firstScope)?.requestId).toBe(first.requestId);
    expect(requests.readSessionPurchaseRequest(secondScope)?.requestId).toBe(second.requestId);
    expect(requests.clearSessionPurchaseRequestIfMatches(firstScope, first.requestId)).toBe(true);
    expect(requests.readSessionPurchaseRequest(firstScope)).toBeNull();
    expect(requests.readSessionPurchaseRequest(secondScope)?.requestId).toBe(second.requestId);
  });

  it('refuses an ambiguous duplicated request identity', async () => {
    const requests = await import('../../src/utils/sessionPurchaseRequest');
    const firstScope = 'marketplace:diamond-package-card:account-a:medium';
    const duplicateScope = 'marketplace:diamond-package-card:account-a:large';
    const first = requests.readOrCreateSessionPurchaseRequest(firstScope, 'medium-terms');
    sessionStorage.setItem(
      v3Key(duplicateScope),
      JSON.stringify({ version: 3, requestId: first.requestId, payloadKey: 'large-terms' })
    );

    expect(() => requests.readSessionPurchaseRequestById(first.requestId)).toThrow(/Ambiguous/);
    expect(() => requests.clearSessionPurchaseRequestById(first.requestId)).toThrow(/Ambiguous/);
    expect(sessionStorage.getItem(v3Key(firstScope))).not.toBeNull();
    expect(sessionStorage.getItem(v3Key(duplicateScope))).not.toBeNull();
  });
});
