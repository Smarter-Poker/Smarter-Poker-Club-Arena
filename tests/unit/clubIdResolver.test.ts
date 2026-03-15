/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubIdResolver
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
    },
  };
});

import { isUUID, resolveClubIdFilter } from '../../src/utils/clubIdResolver';

describe('isUUID', () => {
  it('should return true for a valid UUID', () => {
    expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('should return false for a slug', () => {
    expect(isUUID('shark-club')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isUUID('')).toBe(false);
  });

  it('should return false for partial UUID', () => {
    expect(isUUID('550e8400-e29b')).toBe(false);
  });
});

describe('resolveClubIdFilter', () => {
  it('should return id filter for UUID input', () => {
    const result = resolveClubIdFilter('550e8400-e29b-41d4-a716-446655440000');
    expect(result.column).toBe('id');
    expect(result.value).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should return club_id filter for non-UUID input', () => {
    const result = resolveClubIdFilter('shark-club');
    expect(result.column).toBe('club_id');
    expect(result.value).toBe('shark-club');
  });
});
