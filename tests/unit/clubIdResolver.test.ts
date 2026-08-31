/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — clubIdResolver
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const resolverMock = vi.hoisted(() => ({
  result: { data: null as { id: string } | null, error: null as unknown },
  calls: 0,
}));

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => {
            resolverMock.calls += 1;
            return Promise.resolve(resolverMock.result);
          };
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

import { clearClubUUIDCache, isUUID, resolveClubIdFilter } from '../../src/utils/clubIdResolver';
import {
  ClubNotFoundError,
  ClubResolutionError,
  resolveClubUUIDStrict,
} from '../../src/utils/strictClubIdResolver';

beforeEach(() => {
  resolverMock.result = { data: null, error: null };
  resolverMock.calls = 0;
  clearClubUUIDCache();
  localStorage.clear();
});

describe('isUUID', () => {
  it('should return true for a valid UUID', () => {
    expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('should return false for an integer string', () => {
    expect(isUUID('25450')).toBe(false);
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

  it('should return club_id filter with numeric value for integer string', () => {
    const result = resolveClubIdFilter('25450');
    expect(result.column).toBe('club_id');
    expect(result.value).toBe(25450);
  });

  it('should return slug filter for non-uuid non-numeric string', () => {
    const result = resolveClubIdFilter('midway-union');
    expect(result.column).toBe('slug');
    expect(result.value).toBe('midway-union');
  });
});

describe('resolveClubUUIDStrict', () => {
  it('returns a resolved club UUID', async () => {
    resolverMock.result = {
      data: { id: '550e8400-e29b-41d4-a716-446655440000' },
      error: null,
    };

    await expect(resolveClubUUIDStrict('shark-club')).resolves.toBe(
      '550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('reports a genuine absent row as not found', async () => {
    await expect(resolveClubUUIDStrict('missing-club')).rejects.toBeInstanceOf(ClubNotFoundError);
  });

  it('never turns a failed lookup into not found', async () => {
    resolverMock.result = {
      data: null,
      error: { message: 'permission denied', status: 403 },
    };

    const error = await resolveClubUUIDStrict('shark-club').catch((caught) => caught);
    expect(error).toBeInstanceOf(ClubResolutionError);
    expect(error).not.toBeInstanceOf(ClubNotFoundError);
  });
});
