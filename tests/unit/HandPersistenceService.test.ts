/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HandPersistenceService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { HandPersistenceService } from '../../src/services/HandPersistenceService';

describe('HandPersistenceService', () => {
  let service: HandPersistenceService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new HandPersistenceService('table-1');
  });

  describe('constructor', () => {
    it('should create instance with tableId', () => {
      expect(service).toBeDefined();
    });
  });

  describe('getCurrentHandId', () => {
    it('should return null when no hand started', () => {
      expect(service.getCurrentHandId()).toBeNull();
    });
  });

  describe('dispose', () => {
    it('should not crash when called', () => {
      service.dispose();
    });

    it('should be safe to call multiple times', () => {
      service.dispose();
      service.dispose();
    });
  });

  describe('cleanupOrphanedHands', () => {
    it('should not throw', async () => {
      await service.cleanupOrphanedHands();
    });
  });

  describe('export shape', () => {
    it('should export HandPersistenceService class', () => {
      expect(typeof HandPersistenceService).toBe('function');
      expect(typeof service.getCurrentHandId).toBe('function');
      expect(typeof service.wireToHandController).toBe('function');
      expect(typeof service.dispose).toBe('function');
      expect(typeof service.cleanupOrphanedHands).toBe('function');
    });
  });
});
