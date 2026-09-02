import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import { gameManagementService } from '../../src/services/GameManagementService';

describe('GameManagementService Phase 6 RPC contracts', () => {
  beforeEach(() => rpc.mockReset());

  it('routes pause and resume through the authoritative engine admin endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ access_token: 'operator-token' }),
    });

    await gameManagementService.pause('table-1');
    await gameManagementService.resume('table-1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://engine.smarter.poker/admin/pause',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer operator-token' }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://engine.smarter.poker/admin/resume',
      expect.any(Object)
    );
    vi.unstubAllGlobals();
  });

  it('maps a bounded list page and opaque continuation cursor', async () => {
    rpc.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        items: [{ id: 'game-1', kind: 'table' }],
        counts: { total: 140, live: 7, scheduled: 12, closed: 121 },
        next_cursor: { sort_at: '2026-09-01T12:00:00Z', kind: 'table', id: 'game-1', bucket: 0 },
      },
    });

    const result = await gameManagementService.list('union', 'union-1');

    expect(rpc).toHaveBeenCalledWith('fn_list_managed_games', {
      p_scope: 'union',
      p_scope_id: 'union-1',
      p_cursor: null,
      p_cursor_kind: null,
      p_cursor_id: null,
      p_limit: 100,
      p_cursor_bucket: null,
      p_bucket: null,
    });
    expect(result.counts).toEqual({ total: 140, live: 7, scheduled: 12, closed: 121 });
    expect(result.nextCursor).toEqual({
      sortAt: '2026-09-01T12:00:00Z',
      kind: 'table',
      id: 'game-1',
      bucket: 0,
    });
  });

  /**
   * The bucket is the FIRST key the board orders by, so it is the first key of
   * the keyset cursor too. Drop it on the way back to the database and paging
   * silently restarts at the top of the next bucket instead of continuing -
   * rows repeat, rows vanish, and nothing errors. That is worth a pin of its
   * own rather than trusting the round trip.
   */
  it('sends the cursor bucket back when paging past the live games', async () => {
    rpc.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        items: [],
        counts: { total: 140, live: 7, scheduled: 12, closed: 121 },
        next_cursor: null,
      },
    });

    await gameManagementService.list('club', 'club-1', {
      sortAt: '2026-09-01T12:00:00Z',
      kind: 'tournament',
      id: 'game-9',
      bucket: 1,
    });

    expect(rpc).toHaveBeenCalledWith('fn_list_managed_games', {
      p_scope: 'club',
      p_scope_id: 'club-1',
      p_cursor: '2026-09-01T12:00:00Z',
      p_cursor_kind: 'tournament',
      p_cursor_id: 'game-9',
      p_limit: 100,
      p_cursor_bucket: 1,
      p_bucket: null,
    });
  });

  it('maps schedule evidence and exposes database rejection reasons', async () => {
    rpc.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        schedule: {
          schedule_id: 'schedule-1',
          execute_at: '2026-09-02T12:00:00Z',
          status: 'scheduled',
        },
      },
    });
    await expect(
      gameManagementService.scheduleClose('tournament', 'game-1', 4, '2026-09-02T12:00:00Z')
    ).resolves.toEqual({
      scheduleId: 'schedule-1',
      executeAt: '2026-09-02T12:00:00Z',
      status: 'scheduled',
    });

    rpc.mockResolvedValueOnce({ error: null, data: { ok: false, reason: 'schedule_not_pending' } });
    await expect(gameManagementService.cancelSchedule('schedule-1')).rejects.toThrow(
      'already started or finished'
    );
  });

  it('combines command and scale health without hiding either RPC failure', async () => {
    rpc
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          latest_event_sequence: 44,
          events_last_hour: 5,
          commands_last_24h: 8,
          rejected_last_24h: 1,
          integrity_alerts: 0,
        },
      })
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          scheduled_pending: 2,
          scheduled_rejected_24h: 1,
          event_rows: 80,
          retention_days: 30,
        },
      });

    await expect(gameManagementService.getHealth('club', 'club-1')).resolves.toMatchObject({
      latestEventSequence: 44,
      scheduledPending: 2,
      scheduledRejected24h: 1,
      eventRows: 80,
      retentionDays: 30,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
