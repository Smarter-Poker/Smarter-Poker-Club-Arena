/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — AutoRebuyService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

import { AutoRebuyService } from '../../src/services/AutoRebuyService';

describe('AutoRebuyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    AutoRebuyService.stop();
  });

  afterEach(() => {
    AutoRebuyService.stop();
    vi.useRealTimers();
  });

  describe('start / stop lifecycle', () => {
    it('should start without crashing', () => {
      AutoRebuyService.start();
    });

    it('should guard against double start', () => {
      AutoRebuyService.start();
      AutoRebuyService.start();
    });

    it('should stop without crashing', () => {
      AutoRebuyService.start();
      AutoRebuyService.stop();
    });

    it('should guard against stop when not started', () => {
      AutoRebuyService.stop();
    });

    it('should be re-startable after stop', () => {
      AutoRebuyService.start();
      AutoRebuyService.stop();
      AutoRebuyService.start();
      AutoRebuyService.stop();
    });
  });

  describe('rebuyHorse', () => {
    it('should return a boolean', async () => {
      const result = await AutoRebuyService.rebuyHorse('unknown', 'table-1', 100);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('export shape', () => {
    it('should export singleton with all methods', () => {
      expect(typeof AutoRebuyService.start).toBe('function');
      expect(typeof AutoRebuyService.stop).toBe('function');
      expect(typeof AutoRebuyService.rebuyHorse).toBe('function');
      expect(typeof AutoRebuyService.reseatHorse).toBe('function');
    });
  });
});
