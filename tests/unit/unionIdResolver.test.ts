import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_: string, slug: string) => ({ maybeSingle: () => mocks.lookup(slug) }),
      }),
    }),
  },
}));
import {
  clearUnionUUIDCache,
  resolveUnionUUID,
  resolveUnionUUIDSync,
} from '../../src/utils/unionIdResolver';
const ID = '11111111-1111-4111-8111-111111111111';
describe('union route identifiers stop at the database boundary', () => {
  beforeEach(() => {
    clearUnionUUIDCache();
    mocks.lookup.mockReset();
  });
  it('never passes an unknown slug off as a UUID', async () => {
    mocks.lookup.mockResolvedValue({ data: null, error: null });
    expect(await resolveUnionUUID('demo')).toBeNull();
    expect(resolveUnionUUIDSync('demo')).toBeNull();
  });
  it('keeps a failed lookup distinct from a missing union and allows retry', async () => {
    const error = { code: '503', message: 'unavailable' };
    mocks.lookup
      .mockResolvedValueOnce({ data: null, error })
      .mockResolvedValueOnce({ data: { id: ID }, error: null });
    await expect(resolveUnionUUID('midway')).rejects.toBe(error);
    expect(await resolveUnionUUID('midway')).toBe(ID);
    expect(await resolveUnionUUID('midway')).toBe(ID);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
  it('keeps UUID routes network-free', async () => {
    expect(await resolveUnionUUID(ID)).toBe(ID);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
