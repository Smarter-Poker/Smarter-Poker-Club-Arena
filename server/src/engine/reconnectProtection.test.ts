import { describe, it, expect } from 'vitest';
import { reconnectProtectionSeconds } from './reconnectProtection.js';

describe('one reconnect allowance, with a 50 percent VIP extension', () => {
  const now = Date.parse('2026-09-08T00:00:00Z');
  it('grants 30 seconds to non-members and exactly 45 to active VIP members', () => {
    expect(reconnectProtectionSeconds({}, now)).toBe(30);
    expect(
      reconnectProtectionSeconds({ is_vip: true, vip_expires_at: '2026-10-01T00:00:00Z' }, now)
    ).toBe(45);
    expect(reconnectProtectionSeconds({ is_vip: true, vip_tier: 'lifetime' }, now)).toBe(45);
  });
  it.each([undefined, null, 'invalid', '2026-09-07T00:00:00Z', '2026-09-08T00:00:00Z'])(
    'does not grant a paid membership benefit for expiry %s',
    (vip_expires_at) => {
      expect(reconnectProtectionSeconds({ is_vip: true, vip_expires_at }, now)).toBe(30);
    }
  );
  it('does not infer membership from a stale lifetime label', () => {
    expect(reconnectProtectionSeconds({ is_vip: false, vip_tier: 'lifetime' }, now)).toBe(30);
  });
});
