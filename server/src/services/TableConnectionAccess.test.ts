import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: mocks }));
import { authorizeTableConnection } from './TableConnectionAccess.js';

const table = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const scope = '33333333-3333-4333-8333-333333333333';
const verdict = () => ({
  table_id: table,
  user_id: user,
  scope_id: scope,
  allowed: true,
  reason: 'club_member',
  banned: false,
  ip_restricted: true,
});
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe('one-snapshot connection authority', () => {
  it.each(['seated', 'club_member', 'diamond_member'])(
    'accepts a complete %s verdict from one RPC',
    async (reason) => {
      mocks.rpc.mockResolvedValue({ data: { ...verdict(), reason }, error: null });
      await expect(authorizeTableConnection(table, user)).resolves.toEqual({
        allowed: true,
        reason,
        clubId: scope,
        banned: false,
        ipRestricted: true,
      });
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
      expect(mocks.rpc).toHaveBeenCalledWith('fn_ca_engine_table_connection_access', {
        p_table_id: table,
        p_user_id: user,
      });
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );

  it.each(['membership_required', 'observers_restricted', 'table_not_found', 'check_failed'])(
    'preserves %s without granting access',
    async (reason) => {
      mocks.rpc.mockResolvedValue({ data: { ...verdict(), allowed: false, reason }, error: null });
      await expect(authorizeTableConnection(table, user)).resolves.toMatchObject({
        allowed: false,
        reason,
      });
    }
  );

  it.each([
    null,
    [],
    {},
    { ...verdict(), user_id: table },
    { ...verdict(), table_id: user },
    { ...verdict(), banned: undefined },
    { ...verdict(), ip_restricted: null },
    { ...verdict(), scope_id: null },
    { ...verdict(), scope_id: 'other' },
    { ...verdict(), reason: 'membership_required' },
    { ...verdict(), allowed: 'true' },
  ])('refuses an incomplete, mismatched, or inconsistent result: %j', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(authorizeTableConnection(table, user)).resolves.toMatchObject({
      allowed: false,
      reason: 'check_failed',
    });
  });

  it('never converts an RPC error or rejected transport into access', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: verdict(), error: { code: '57014' } })
      .mockRejectedValueOnce(new Error('transport lost'));
    for (let i = 0; i < 2; i++) {
      await expect(authorizeTableConnection(table, user)).resolves.toMatchObject({
        allowed: false,
        reason: 'check_failed',
      });
    }
  });

  it('does not reuse a previously allowed verdict when restrictions change', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: verdict(), error: null })
      .mockResolvedValueOnce({ data: { ...verdict(), banned: true }, error: null });
    expect((await authorizeTableConnection(table, user)).banned).toBe(false);
    expect((await authorizeTableConnection(table, user)).banned).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not query with a guest or missing identity', async () => {
    await expect(authorizeTableConnection(table, 'guest')).resolves.toMatchObject({
      allowed: false,
    });
    await expect(authorizeTableConnection('', user)).resolves.toMatchObject({ allowed: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
