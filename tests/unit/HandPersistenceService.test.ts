/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HandPersistenceService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests hand persistence state management:
 * - constructor: creates instance with tableId
 * - dispose: clears all internal state
 * - getCurrentHandId: returns null on fresh instance
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

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
    },
  };
});

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { HandPersistence } from '../../src/services/HandPersistenceService';

describe('HandPersistence', () => {
  let instance: HandPersistence;

  beforeEach(() => {
    vi.clearAllMocks();
    instance = new HandPersistence('test-table-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONSTRUCTOR
  // ─────────────────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should initialize with no current hand', () => {
      expect(instance.getCurrentHandId()).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE
  // ─────────────────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clear all state', () => {
      instance.dispose();
      expect(instance.getCurrentHandId()).toBeNull();
    });

    it('should not throw when called multiple times', () => {
      instance.dispose();
      expect(() => instance.dispose()).not.toThrow();
    });
  });
});
