import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateRecordTopicAllowed } from './client.js';
afterEach(() => vi.unstubAllGlobals());
describe('private record ACL uses the viewer JWT through the owned Data API client', () => {
  it('forwards the exact viewer token and fixed ACL function without substituting service identity', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetcher);
    expect(
      await privateRecordTopicAllowed(
        'viewer-only-unit-token',
        'member-record:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'
      )
    ).toBe(true);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('/rpc/ca_member_record_can_subscribe');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer viewer-only-unit-token');
    expect(new Headers(options.headers).get('x-smarter-data-actor')).toBe('service');
  });
});
