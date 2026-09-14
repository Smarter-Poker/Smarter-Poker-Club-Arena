import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), session: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: mocks.session }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
import { waitlistService } from '../../src/services/WaitlistService';

const entry = {
  id: 'entry-1',
  table_id: 'table-1',
  user_id: 'user-1',
  status: 'notified',
  created_at: '2026-09-14T10:00:00Z',
  notified_at: '2026-09-14T10:01:00Z',
  hold_expires_at: '2026-09-14T10:02:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ userId: 'user-1' });
  mocks.from.mockImplementation(() => {
    throw new Error('Browser table writes are revoked');
  });
});

describe('waitlist callers use the installed authenticated doors', () => {
  it('joins through the door and preserves an existing seat offer', async () => {
    mocks.rpc.mockResolvedValue({
      data: { ok: true, already_on_waitlist: true, entry },
      error: null,
    });
    await expect(waitlistService.joinWaitlist('table-1')).resolves.toMatchObject({
      id: entry.id,
      tableId: entry.table_id,
      userId: entry.user_id,
      status: 'notified',
      holdExpiresAt: entry.hold_expires_at,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_table_waitlist_join', {
      p_table_id: 'table-1',
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    { data: { ok: false, reason: 'already_seated' }, error: null },
    { data: null, error: { message: 'WAITLIST_TOURNAMENT_TABLE' } },
    { data: null, error: null },
    { data: { ok: true, entry: { ...entry, user_id: 'other-user' } }, error: null },
    { data: { ok: true, entry: { ...entry, table_id: 'other-table' } }, error: null },
  ])('does not claim a seat on a refused or invalid join %#', async (reply) => {
    mocks.rpc.mockResolvedValue(reply);
    await expect(waitlistService.joinWaitlist('table-1')).resolves.toBeNull();
  });

  it.each([0, 2])('returns the authoritative leave count %s', async (cancelled) => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, cancelled }, error: null });
    await expect(waitlistService.leaveWaitlist('table-1')).resolves.toEqual({
      success: true,
      cancelled,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_table_waitlist_leave', {
      p_table_id: 'table-1',
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: { message: 'permission denied' } },
    { data: null, error: null },
    { data: { ok: false, cancelled: 0 }, error: null },
    { data: { ok: true, cancelled: -1 }, error: null },
    { data: { ok: true }, error: null },
  ])('keeps leave failures distinct from an empty successful cancellation %#', async (reply) => {
    mocks.rpc.mockResolvedValue(reply);
    await expect(waitlistService.leaveWaitlist('table-1')).resolves.toMatchObject({
      success: false,
      cancelled: 0,
    });
    await expect(waitlistService.leave('table-1', 'user-1')).resolves.toBe(false);
  });

  it('contains network failures without pretending the queue changed', async () => {
    mocks.rpc.mockRejectedValue(new Error('offline'));
    await expect(waitlistService.joinWaitlist('table-1')).resolves.toBeNull();
    await expect(waitlistService.leaveWaitlist('table-1')).resolves.toMatchObject({
      success: false,
    });
    await expect(waitlistService.leave('table-1')).resolves.toBe(false);
  });

  it('routes the page leave wrapper through the same door', async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, cancelled: 1 }, error: null });
    await expect(waitlistService.leave('table-1', 'user-1')).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_table_waitlist_leave', {
      p_table_id: 'table-1',
    });
  });

  it('does not cancel the current user when an old page names a different user', async () => {
    await expect(waitlistService.leave('table-1', 'other-user')).resolves.toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('does nothing when signed out', async () => {
    mocks.session.mockReturnValue(null);
    await expect(waitlistService.joinWaitlist('table-1')).resolves.toBeNull();
    await expect(waitlistService.leaveWaitlist('table-1')).resolves.toMatchObject({
      success: false,
    });
    await expect(waitlistService.leave('table-1', 'user-1')).resolves.toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'only recovers a duplicate join after an authoritative read (success=%s)',
    async (success) => {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'unique violation' },
      });
      const query: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const method of ['select', 'eq', 'in', 'order', 'limit'])
        query[method] = vi.fn(() => query);
      query.maybeSingle = vi
        .fn()
        .mockResolvedValue(
          success ? { data: entry, error: null } : { data: null, error: { message: 'read failed' } }
        );
      mocks.from.mockReturnValue(query);
      const result = await waitlistService.joinWaitlist('table-1');
      if (success) expect(result?.id).toBe(entry.id);
      else expect(result).toBeNull();
      expect(query.eq).toHaveBeenCalledWith('table_id', 'table-1');
      expect(query.eq).toHaveBeenCalledWith('user_id', 'user-1');
      expect(query.in).toHaveBeenCalledWith('status', ['waiting', 'notified']);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    }
  );
});
