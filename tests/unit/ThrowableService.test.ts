/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ThrowableService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the throwable catalog, category grouping, VIP allowance constants,
 * createThrowEvent(), and getThrowableById().
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
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { throwableService } from '../../src/services/ThrowableService';

describe('ThrowableService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THROWABLE CATALOG
  // ─────────────────────────────────────────────────────────────────────────

  describe('getThrowables', () => {
    it('should contain exactly 25 throwables', () => {
      expect(throwableService.getThrowables().length).toBe(25);
    });

    it('should have unique IDs', () => {
      const ids = throwableService.getThrowables().map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid categories on every item', () => {
      const valid = ['reactions', 'throws', 'cheers', 'expressions', 'premium'];
      for (const t of throwableService.getThrowables()) {
        expect(valid).toContain(t.category);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CATEGORY GROUPING
  // ─────────────────────────────────────────────────────────────────────────

  describe('getThrowablesByCategory', () => {
    it('should have 5 reactions', () => {
      expect(throwableService.getThrowablesByCategory().reactions.length).toBe(5);
    });

    it('should have 5 throws', () => {
      expect(throwableService.getThrowablesByCategory().throws.length).toBe(5);
    });

    it('should have 5 cheers', () => {
      expect(throwableService.getThrowablesByCategory().cheers.length).toBe(5);
    });

    it('should have 5 expressions', () => {
      expect(throwableService.getThrowablesByCategory().expressions.length).toBe(5);
    });

    it('should have 5 premium', () => {
      expect(throwableService.getThrowablesByCategory().premium.length).toBe(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET BY ID
  // ─────────────────────────────────────────────────────────────────────────

  describe('getThrowableById', () => {
    it('should return throwable for valid ID', () => {
      const t = throwableService.getThrowableById('tomato');
      expect(t).not.toBeNull();
      expect(t!.name).toBe('Tomato');
      expect(t!.category).toBe('throws');
    });

    it('should return null for invalid ID', () => {
      expect(throwableService.getThrowableById('nonexistent')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CREATE THROW EVENT
  // ─────────────────────────────────────────────────────────────────────────

  describe('createThrowEvent', () => {
    it('should create event with correct fields', () => {
      const event = throwableService.createThrowEvent(0, 3, 'beer');
      expect(event).not.toBeNull();
      expect(event!.fromSeat).toBe(0);
      expect(event!.toSeat).toBe(3);
      expect(event!.throwableId).toBe('beer');
      expect(event!.throwable.name).toBe('Beer');
      expect(event!.throwable.category).toBe('cheers');
      expect(typeof event!.id).toBe('string');
      expect(typeof event!.timestamp).toBe('number');
    });

    it('should return null for invalid throwableId', () => {
      expect(throwableService.createThrowEvent(0, 1, 'invalid')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // USE THROWABLE — VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('useThrowable', () => {
    it('should reject invalid throwable ID', async () => {
      const result = await throwableService.useThrowable('user-1', 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Throwable not found');
    });
  });
});
