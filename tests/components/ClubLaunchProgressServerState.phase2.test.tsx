/**
 * Create A Club, Phase 2 (2026-09-23): the owner's skips and the checklist's
 * completion latch live on the server.
 *
 * useClubLaunchSkips is the only reader and writer of skip state. With
 * `server` on it reads fn_club_opening_checklist_state once, moves any skips an
 * older build left in this browser to the server once, writes each skip and
 * undo through fn_club_opening_checklist_skip, and latches through
 * fn_club_opening_checklist_complete. Every error and every unreadable answer
 * is reported and falls back to today's local behaviour.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: h.rpc } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.reportError }));

import { useClubLaunchSkips } from '../../src/components/club/ClubLaunchProgress';

const KEY = 'club-launch-skips:club-a:owner-a';
const LATCH = '2026-09-23T10:00:00.123456+00:00';

type Reply = { data: unknown; error: { code: string; message: string } | null };
const state = (skippedTaskIds: string[], completedAt: string | null = null, clubId = 'club-a') => ({
  data: { clubId, completedAt, skippedTaskIds },
  error: null,
});
const failure = (
  code = '57014',
  message = 'canceling statement due to statement timeout'
): Reply => ({
  data: null,
  error: { code, message },
});

/** A server that keeps its own copy, so writes can be read back. */
function server(initial: { skipped?: string[]; completedAt?: string | null } = {}) {
  const store = { skipped: [...(initial.skipped ?? [])], completedAt: initial.completedAt ?? null };
  const replies: Partial<Record<string, Reply[]>> = {};
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    const queued = replies[name]?.shift();
    if (queued) return queued;
    if (name === 'fn_club_opening_checklist_state') return state(store.skipped, store.completedAt);
    if (name === 'fn_club_opening_checklist_skip') {
      const id = String(args.p_task_id);
      store.skipped = args.p_skipped
        ? [...new Set([...store.skipped, id])].sort()
        : store.skipped.filter((s) => s !== id);
      return state(store.skipped, store.completedAt);
    }
    if (name === 'fn_club_opening_checklist_complete') {
      store.completedAt ??= LATCH;
      return state(store.skipped, store.completedAt);
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { store, replies };
}

const calls = (name: string) => h.rpc.mock.calls.filter(([n]) => n === name);
const mountServer = (clubId = 'club-a') =>
  renderHook(({ id }: { id: string }) => useClubLaunchSkips(id, 'owner-a', { server: true }), {
    initialProps: { id: clubId },
  });

beforeEach(() => {
  localStorage.clear();
  h.rpc.mockReset();
  h.reportError.mockReset();
});

describe('reading the owner state', () => {
  it('asks once, and fails closed until the server answers', async () => {
    let answer!: (reply: Reply) => void;
    h.rpc.mockImplementation(
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        })
    );
    const { result, rerender } = mountServer();

    expect(result.current.completedAt).toBeUndefined();
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith('fn_club_opening_checklist_state', { p_club_id: 'club-a' });

    await act(async () => answer(state(['nlh'])));
    expect(result.current.completedAt).toBeNull();
    expect(result.current.skippedIds).toEqual(['nlh']);

    rerender({ id: 'club-a' });
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('reads back a latch, so a finished list stays finished after a reload', async () => {
    server({ skipped: ['mtt'], completedAt: LATCH });
    const { result } = mountServer();
    await waitFor(() => expect(result.current.completedAt).toBe(LATCH));
    expect(result.current.skippedIds).toEqual(['mtt']);
  });

  it('never applies one club answer to the next club', async () => {
    const answers: Array<(reply: Reply) => void> = [];
    h.rpc.mockImplementation(
      () =>
        new Promise<Reply>((resolve) => {
          answers.push(resolve);
        })
    );
    const { result, rerender } = mountServer('club-a');
    rerender({ id: 'club-b' });
    expect(result.current.completedAt).toBeUndefined();

    await act(async () => answers[0](state([], LATCH, 'club-a')));
    expect(result.current.completedAt).toBeUndefined();

    await act(async () => answers[1](state(['plo'], null, 'club-b')));
    expect(result.current.completedAt).toBeNull();
    expect(result.current.skippedIds).toEqual(['plo']);
  });

  it('touches no server at all for a standalone caller', () => {
    const { result } = renderHook(() => useClubLaunchSkips('club-a', 'owner-a'));
    expect(h.rpc).not.toHaveBeenCalled();
    expect(result.current.completedAt).toBeUndefined();
  });
});

describe('the one-time move of skips this browser kept', () => {
  it('moves only optional steps the server lacks, then removes the browser copy', async () => {
    server({ skipped: ['nlh'] });
    localStorage.setItem(KEY, JSON.stringify(['identity', 'nlh', 'opening-setup', 'Picture']));
    const { result } = mountServer();

    await waitFor(() => expect(result.current.completedAt).toBeNull());
    expect(calls('fn_club_opening_checklist_skip')).toEqual([
      [
        'fn_club_opening_checklist_skip',
        { p_club_id: 'club-a', p_task_id: 'identity', p_skipped: true },
      ],
    ]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(result.current.skippedIds).toEqual(['nlh', 'identity']);
  });

  it('keeps the browser copy when a move fails, reports it, and still shows the skip', async () => {
    const { replies } = server();
    replies.fn_club_opening_checklist_skip = [failure()];
    localStorage.setItem(KEY, JSON.stringify(['identity']));
    const { result } = mountServer();

    await waitFor(() => expect(result.current.completedAt).toBeNull());
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: '57014' }),
      'ClubLaunchSkips.local_move_failed',
      { taskId: 'identity' }
    );
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['identity']);
    expect(result.current.skippedIds).toEqual(['identity']);
  });
});

describe('the local fallback', () => {
  it('falls back to this browser when the store is missing, and asks nothing else', async () => {
    const { replies } = server();
    replies.fn_club_opening_checklist_state = [
      failure('PGRST202', 'Could not find the function public.fn_club_opening_checklist_state'),
    ];
    localStorage.setItem(KEY, JSON.stringify(['tagline']));
    const { result } = mountServer();

    await waitFor(() => expect(result.current.completedAt).toBeNull());
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PGRST202' }),
      'ClubLaunchSkips.server_read_failed'
    );
    expect(result.current.skippedIds).toEqual(['tagline']);

    act(() => result.current.skip('mtt'));
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['tagline', 'mtt']);
    await expect(result.current.complete()).resolves.toBe(false);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable answer as a failure, never as an empty checklist', async () => {
    const { replies } = server({ completedAt: LATCH });
    replies.fn_club_opening_checklist_state = [{ data: 0, error: null }];
    const { result } = mountServer();

    await waitFor(() => expect(result.current.completedAt).toBeNull());
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      'ClubLaunchSkips.server_read_failed'
    );
  });
});

describe('writing skips', () => {
  it('writes a skip and its undo to the server, not to this browser', async () => {
    const { store } = server();
    const { result } = mountServer();
    await waitFor(() => expect(result.current.completedAt).toBeNull());

    act(() => result.current.skip('plo'));
    expect(result.current.skippedIds).toEqual(['plo']);
    await waitFor(() => expect(store.skipped).toEqual(['plo']));
    expect(calls('fn_club_opening_checklist_skip').at(-1)).toEqual([
      'fn_club_opening_checklist_skip',
      { p_club_id: 'club-a', p_task_id: 'plo', p_skipped: true },
    ]);

    act(() => result.current.undoSkip('plo'));
    expect(result.current.skippedIds).toEqual([]);
    await waitFor(() => expect(store.skipped).toEqual([]));
    expect(calls('fn_club_opening_checklist_skip').at(-1)?.[1]).toEqual({
      p_club_id: 'club-a',
      p_task_id: 'plo',
      p_skipped: false,
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps today behaviour when a server write fails: the step resolves and this browser keeps it', async () => {
    const { replies } = server();
    const { result } = mountServer();
    await waitFor(() => expect(result.current.completedAt).toBeNull());
    replies.fn_club_opening_checklist_skip = [failure()];

    act(() => result.current.skip('spin'));
    await waitFor(() =>
      expect(h.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: '57014' }),
        'ClubLaunchSkips.server_write_failed',
        { taskId: 'spin', skipped: true }
      )
    );
    expect(result.current.skippedIds).toEqual(['spin']);
    expect(JSON.parse(localStorage.getItem(KEY) || '[]')).toEqual(['spin']);
  });

  it('an undo that lands also clears the step from a browser copy still waiting to move', async () => {
    const { replies } = server();
    replies.fn_club_opening_checklist_skip = [failure()];
    localStorage.setItem(KEY, JSON.stringify(['identity']));
    const { result } = mountServer();
    await waitFor(() => expect(result.current.skippedIds).toEqual(['identity']));

    act(() => result.current.undoSkip('identity'));
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    expect(result.current.skippedIds).toEqual([]);
  });
});

describe('the latch', () => {
  it('latches through the server and holds the answer', async () => {
    server({ skipped: ['nlh'] });
    const { result } = mountServer();
    await waitFor(() => expect(result.current.completedAt).toBeNull());

    let latched = false;
    await act(async () => {
      latched = await result.current.complete();
    });
    expect(latched).toBe(true);
    expect(calls('fn_club_opening_checklist_complete')).toEqual([
      ['fn_club_opening_checklist_complete', { p_club_id: 'club-a' }],
    ]);
    expect(result.current.completedAt).toBe(LATCH);
  });

  it('a refused latch is reported and changes nothing', async () => {
    const { replies } = server();
    replies.fn_club_opening_checklist_complete = [
      failure('55000', 'Complete The Opening Setup Wizard First'),
    ];
    const { result } = mountServer();
    await waitFor(() => expect(result.current.completedAt).toBeNull());

    let latched = true;
    await act(async () => {
      latched = await result.current.complete();
    });
    expect(latched).toBe(false);
    expect(result.current.completedAt).toBeNull();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: '55000' }),
      'ClubLaunchSkips.latch_failed'
    );
  });

  it('asks nothing while the state is still being read', async () => {
    h.rpc.mockImplementation(() => new Promise(() => {}));
    const { result } = mountServer();
    await expect(result.current.complete()).resolves.toBe(false);
    expect(calls('fn_club_opening_checklist_complete')).toEqual([]);
  });
});
