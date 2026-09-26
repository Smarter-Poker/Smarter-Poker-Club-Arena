/**
 * THE CREATE-TABLE MTT TAB, RENDERED (owner requirements, 2026-09-20).
 *
 * The pure mappers are pinned elsewhere (TournamentFromTableConfig,
 * mttEntryRulesAndPrizeStyleAreIndependent, quarterHourStartSelect,
 * tableConfigRecurrence). This renders the real page on the MTT tab and drives
 * it the way an owner would, then reads what Start actually hands the
 * services: nothing reaches Supabase, the two creation calls are spied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const access = vi.hoisted(() => vi.fn());
const catalog = vi.hoisted(() => ({ read: vi.fn(), userId: 'user-a', save: vi.fn() }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: catalog.userId } }),
}));

vi.mock('../../src/lib/supabase', () => {
  const chain = (table: string) => {
    const args: Record<string, unknown> = {};
    const query: Record<string, any> = {
      then: (ok: (value: unknown) => unknown, fail: (error: unknown) => unknown) =>
        Promise.resolve(args.insert ? catalog.save(args.insert) : catalog.read(table, args)).then(
          ok,
          fail
        ),
    };
    for (const method of ['select', 'eq', 'order', 'abortSignal', 'insert', 'maybeSingle']) {
      query[method] = (...values: unknown[]) => {
        if (method === 'eq') args[String(values[0])] = values[1];
        else args[method] = values[0];
        return query;
      };
    }
    return query;
  };
  return {
    supabase: { from: chain, rpc: vi.fn(async () => ({ data: null, error: null })) },
    getAuthUser: vi.fn(async () => ({ data: { user: { id: catalog.userId } } })),
  };
});
vi.mock('../../src/core/MasterBus', () => {
  const channel = {
    on() {
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  return {
    masterBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
    },
  };
});
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn(async (id: string) => id),
}));
vi.mock('../../src/services/GameAccessService', () => ({ fetchGameCreationAccess: access }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));
// The cash flow is never on screen on the MTT tab; keep its dependencies out.
vi.mock('../../src/components/cash/CashGameCreateFlow', () => ({ default: () => null }));

import TableConfigPage from '../../src/pages/TableConfigPage';

const template = (id: string) => ({
  id,
  name: `Template ${id}`,
  game_type: 'NLH',
  game_mode: 'mtt',
  config: {},
});
const ok = (data: unknown) => ({ data, error: null });
function deferred() {
  let resolve!: (reply: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function view(clubId = 'club-a') {
  return (
    <MemoryRouter>
      <TableConfigPage clubIdOverride={clubId} gameTypeOverride="nlh" embedded />
    </MemoryRouter>
  );
}
async function open() {
  const result = render(view());
  await waitFor(() => expect(access).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: 'MTT' }));
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  catalog.userId = 'user-a';
  catalog.read.mockImplementation(async () => ok([template('A')]));
  catalog.save.mockResolvedValue(ok(template('Saved')));
  access.mockResolvedValue({ allowed: true, unionId: null, reason: 'ok' });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('refreshes a visible template catalog without overwriting the draft', async () => {
  await open();
  await screen.findByText('Template A');
  fireEvent.change(screen.getByPlaceholderText('Enter Table Name Here...'), {
    target: { value: 'Unsaved Draft' },
  });
  catalog.read.mockResolvedValue(ok([template('B')]));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByText('Template B');
  expect(screen.queryByText('Template A')).toBeNull();
  expect((screen.getByPlaceholderText('Enter Table Name Here...') as HTMLInputElement).value).toBe(
    'Unsaved Draft'
  );
});

it('does not read the unused template catalog on the regular cash flow', async () => {
  render(view());
  await waitFor(() => expect(access).toHaveBeenCalled());
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(catalog.read).not.toHaveBeenCalled();
});

it('aborts an old club read and refuses its late result', async () => {
  const old = deferred();
  catalog.read.mockImplementation((_table, args) =>
    args.club_id === 'club-a' ? old.promise : ok([template('B')])
  );
  const result = await open();
  await waitFor(() => expect(catalog.read).toHaveBeenCalled());
  const signal = catalog.read.mock.calls[0][1].abortSignal as AbortSignal;
  result.rerender(view('club-b'));
  await screen.findByText('Template B');
  expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(ok([template('Old')])));
  expect(screen.queryByText('Template Old')).toBeNull();
});

it('fences the previous account even when the club is unchanged', async () => {
  const old = deferred();
  catalog.read.mockReturnValue(old.promise);
  const result = await open();
  await waitFor(() => expect(catalog.read).toHaveBeenCalled());
  const signal = catalog.read.mock.calls[0][1].abortSignal as AbortSignal;
  catalog.userId = 'user-b';
  catalog.read.mockResolvedValue(ok([template('B')]));
  result.rerender(view());
  await screen.findByText('Template B');
  expect(signal.aborted).toBe(true);
  await act(async () => old.resolve(ok([template('Old')])));
  expect(screen.queryByText('Template Old')).toBeNull();
});

it('reports a failed refresh without erasing the last confirmed catalog', async () => {
  await open();
  await screen.findByText('Template A');
  catalog.read.mockResolvedValue({ data: null, error: { message: 'offline' } });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.getByText('Template A')).toBeTruthy();
  expect(toast.error).toHaveBeenCalledWith(
    'Could Not Refresh Templates. Reopen This View To Retry.'
  );
  catalog.read.mockResolvedValue(ok([template('B')]));
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await screen.findByText('Template B');
});

it('never reads the catalog while the document is hidden', async () => {
  await open();
  await screen.findByText('Template A');
  vi.useFakeTimers();
  const count = catalog.read.mock.calls.length;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(catalog.read).toHaveBeenCalledTimes(count);
});

it('keeps a confirmed template save when an older catalog read finishes later', async () => {
  await open();
  await screen.findByText('Template A');
  const stale = deferred();
  const successor = deferred();
  catalog.read.mockReturnValueOnce(stale.promise).mockReturnValueOnce(successor.promise);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  fireEvent.change(screen.getByPlaceholderText('Enter Table Name Here...'), {
    target: { value: 'Saved' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save As Template' }));
  await screen.findByText('Template Saved');
  await act(async () => stale.resolve(ok([template('A')])));
  expect(screen.getByText('Template Saved')).toBeTruthy();
  await act(async () => successor.resolve(ok([template('Saved'), template('A')])));
  expect(screen.getAllByText('Template Saved')).toHaveLength(1);
});

it('does not insert a former club save into the newly selected club', async () => {
  const pending = deferred();
  catalog.save.mockReturnValue(pending.promise);
  const result = await open();
  await screen.findByText('Template A');
  fireEvent.click(screen.getByRole('button', { name: 'Save As Template' }));
  await waitFor(() => expect(catalog.save).toHaveBeenCalled());
  catalog.read.mockResolvedValue(ok([template('B')]));
  result.rerender(view('club-b'));
  await screen.findByText('Template B');
  await act(async () => pending.resolve(ok(template('Saved'))));
  expect(screen.queryByText('Template Saved')).toBeNull();
  expect(toast.success).not.toHaveBeenCalled();
});
