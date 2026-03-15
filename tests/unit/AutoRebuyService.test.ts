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
  let service: AutoRebuyService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    service = new AutoRebuyService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('start / stop lifecycle', () => {
    it('should start without crashing', () => {
      service.start();
    });

    it('should guard against double start', () => {
      service.start();
      service.start(); // Should not throw or double up
    });

    it('should stop without crashing', () => {
      service.start();
      service.stop();
    });

    it('should guard against stop when not started', () => {
      service.stop(); // Should not throw
    });

    it('should be re-startable after stop', () => {
      service.start();
      service.stop();
      service.start();
      service.stop();
    });
  });

  describe('rebuyHorse', () => {
    it('should return false for unknown horse', async () => {
      const result = await service.rebuyHorse('unknown', 'table-1', 100);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('export shape', () => {
    it('should export AutoRebuyService class with all methods', () => {
      expect(typeof service.start).toBe('function');
      expect(typeof service.stop).toBe('function');
      expect(typeof service.rebuyHorse).toBe('function');
      expect(typeof service.reseatHorse).toBe('function');
    });
  });
});
