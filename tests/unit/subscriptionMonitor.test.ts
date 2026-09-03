/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — subscriptionMonitor
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    getChannels: vi.fn().mockReturnValue([]),
    removeChannel: vi.fn(),
  },
}));

import { subscriptionMonitor, SubscriptionMonitor } from '../../src/utils/subscriptionMonitor';

describe('subscriptionMonitor', () => {
  it('should export subscriptionMonitor singleton', () => {
    expect(subscriptionMonitor).toBeDefined();
    expect(subscriptionMonitor).toBeInstanceOf(SubscriptionMonitor);
  });

  it('should export SubscriptionMonitor class', () => {
    expect(typeof SubscriptionMonitor).toBe('function');
  });
});
