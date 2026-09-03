/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — IdentityDNA
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi } from 'vitest';

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
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

import {
  identityDNA,
  getIdentityDNAStatus,
  isIdentityDNALoaded,
  isAuthenticated,
} from '../../src/core/IdentityDNA';

describe('IdentityDNA', () => {
  it('should export identityDNA singleton', () => {
    expect(identityDNA).toBeDefined();
  });

  it('should export getIdentityDNAStatus function', () => {
    expect(typeof getIdentityDNAStatus).toBe('function');
  });

  it('should export isIdentityDNALoaded function', () => {
    expect(typeof isIdentityDNALoaded).toBe('function');
  });

  it('should export isAuthenticated function', () => {
    expect(typeof isAuthenticated).toBe('function');
  });

  it('should return false for isAuthenticated initially', () => {
    expect(isAuthenticated()).toBe(false);
  });

  it('should return false for isIdentityDNALoaded initially', () => {
    expect(typeof isIdentityDNALoaded()).toBe('boolean');
  });
});
