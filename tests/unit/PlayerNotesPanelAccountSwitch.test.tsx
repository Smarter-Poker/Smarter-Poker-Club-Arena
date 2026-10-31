import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type NoteRead = {
  data: {
    id: string;
    notes: string;
    tags: string[];
    color_label: string;
  } | null;
  error: { message: string } | null;
};

const mocks = vi.hoisted(() => ({
  currentUser: { id: 'account-a' } as { id: string } | null,
  noteReads: new Map<string, Promise<NoteRead>>(),
  checkVIPStatus: vi.fn(),
  purchaseFeature: vi.fn(),
  showDiamondTopUp: vi.fn(),
  toast: { error: vi.fn() },
  save: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: mocks.currentUser }),
}));

vi.mock('../../src/services/VIPService', () => ({
  FEATURE_PRICING: { tag_pack: { cost: 1 } },
  vipService: {
    checkVIPStatus: mocks.checkVIPStatus,
    purchaseFeature: mocks.purchaseFeature,
  },
}));

vi.mock('../../src/services/PlayerNotesService', () => ({
  NOTE_COLORS: [{ name: 'None', value: 'none', hex: 'transparent' }],
  PLAYER_TAGS: ['Aggressive'],
  playerNotesService: { clearCache: vi.fn() },
}));

vi.mock('../../src/hooks/useStaggerAnimation', () => ({
  useStaggerAnimation: () => ({ style: () => ({}) }),
}));

vi.mock('../../src/components/common/DiamondTopUpToast', () => ({
  showDiamondTopUp: mocks.showDiamondTopUp,
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      let requestedUserId = '';
      const builder: Record<string, any> = {};
      builder.select = () => builder;
      builder.eq = (column: string, value: string) => {
        if (column === 'user_id') requestedUserId = value;
        return builder;
      };
      builder.maybeSingle = () => {
        if (table !== 'player_notes') return Promise.resolve({ data: null, error: null });
        return mocks.noteReads.get(requestedUserId) ?? Promise.resolve({ data: null, error: null });
      };
      builder.order = () => Promise.resolve({ data: [], error: null });
      builder.in = () => Promise.resolve({ data: [], error: null });
      builder.upsert = (...args: unknown[]) => mocks.save(...args);
      builder.delete = () => builder;
      return builder;
    },
  },
}));

import PlayerNotesPanel from '../../src/components/gameplay/PlayerNotesPanel';

function view() {
  return (
    <MemoryRouter>
      <PlayerNotesPanel targetUserId="opponent" targetName="Opponent" />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  mocks.currentUser = { id: 'account-a' };
  mocks.noteReads.clear();
  vi.clearAllMocks();
});

describe('Player Notes Account Isolation', () => {
  it('ignores late account A Lifetime status and note data after account B becomes active', async () => {
    const accountAStatus = deferred<{ isVIP: boolean }>();
    const accountBStatus = deferred<{ isVIP: boolean }>();
    const accountANote = deferred<NoteRead>();
    const accountBNote = deferred<NoteRead>();
    mocks.noteReads.set('account-a', accountANote.promise);
    mocks.noteReads.set('account-b', accountBNote.promise);
    mocks.checkVIPStatus.mockImplementation((userId: string) =>
      userId === 'account-a' ? accountAStatus.promise : accountBStatus.promise
    );
    mocks.purchaseFeature.mockResolvedValue({ success: true, charged: 1 });

    const rendered = render(view());
    await waitFor(() => expect(mocks.checkVIPStatus).toHaveBeenCalledWith('account-a'));

    mocks.currentUser = { id: 'account-b' };
    rendered.rerender(view());
    await waitFor(() => expect(mocks.checkVIPStatus).toHaveBeenCalledWith('account-b'));

    await act(async () => {
      accountBStatus.resolve({ isVIP: false });
      accountBNote.resolve({ data: null, error: null });
      await Promise.all([accountBStatus.promise, accountBNote.promise]);
    });

    await act(async () => {
      accountAStatus.resolve({ isVIP: true });
      accountANote.resolve({
        data: {
          id: 'note-a',
          notes: 'Account A Secret',
          tags: ['Aggressive'],
          color_label: 'none',
        },
        error: null,
      });
      await Promise.all([accountAStatus.promise, accountANote.promise]);
    });

    expect(screen.getByPlaceholderText('Add Notes About This Player...')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Aggressive' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Aggressive' }));
    await waitFor(() =>
      expect(mocks.purchaseFeature).toHaveBeenCalledWith('account-b', 'tag_pack')
    );
    expect(mocks.purchaseFeature).not.toHaveBeenCalledWith('account-a', 'tag_pack');
  });

  it('lets account B start immediately and ignores account A purchase completion', async () => {
    const accountANote = deferred<NoteRead>();
    const accountAPurchase = deferred<{
      success: boolean;
      charged: number;
      alreadyOwned?: boolean;
    }>();
    const accountBPurchase = deferred<{
      success: boolean;
      charged: number;
      alreadyOwned?: boolean;
    }>();
    mocks.noteReads.set('account-a', accountANote.promise);
    mocks.noteReads.set('account-b', Promise.resolve({ data: null, error: null }));
    mocks.checkVIPStatus.mockResolvedValue({ isVIP: false });
    mocks.purchaseFeature.mockImplementation((userId: string) =>
      userId === 'account-a' ? accountAPurchase.promise : accountBPurchase.promise
    );

    const rendered = render(view());
    await waitFor(() => expect(mocks.checkVIPStatus).toHaveBeenCalledWith('account-a'));
    // A status request starting does not mean the note read has completed.
    // Keep that boundary explicit, then purchase through the enabled control.
    expect(screen.getByRole('button', { name: 'Aggressive' })).toBeDisabled();
    expect(mocks.purchaseFeature).not.toHaveBeenCalled();
    await act(async () => {
      accountANote.resolve({ data: null, error: null });
      await accountANote.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aggressive' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Aggressive' }));
    await waitFor(() =>
      expect(mocks.purchaseFeature).toHaveBeenCalledWith('account-a', 'tag_pack')
    );

    mocks.currentUser = { id: 'account-b' };
    rendered.rerender(view());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aggressive' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Aggressive' }));
    await waitFor(() =>
      expect(mocks.purchaseFeature).toHaveBeenCalledWith('account-b', 'tag_pack')
    );

    await act(async () => {
      accountAPurchase.resolve({ success: true, charged: 1 });
      await accountAPurchase.promise;
    });

    expect(screen.getByRole('button', { name: 'Aggressive' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(mocks.showDiamondTopUp).not.toHaveBeenCalled();

    await act(async () => {
      accountBPurchase.resolve({ success: true, charged: 1 });
      await accountBPurchase.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Aggressive' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );
  });

  it('fails closed instead of overwriting a note after its read fails', async () => {
    mocks.noteReads.set(
      'account-a',
      Promise.resolve({ data: null, error: { message: 'notes database unavailable' } })
    );
    mocks.checkVIPStatus.mockResolvedValue({ isVIP: false });

    render(view());

    expect(await screen.findByText('Player Note Could Not Be Loaded.')).toBe(
      screen.getByRole('alert')
    );
    expect(screen.getByPlaceholderText('Add Notes About This Player...')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Aggressive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Note' })).toBeDisabled();
    expect(mocks.purchaseFeature).not.toHaveBeenCalled();
  });
});

it('saves edited and cleared notes, blocks repeat saves and retains a failed draft', async () => {
  mocks.checkVIPStatus.mockResolvedValue({ isVIP: true });
  mocks.noteReads.set(
    'account-a',
    Promise.resolve({
      data: { id: 'note', notes: 'Previous Read', tags: [], color_label: 'none' },
      error: null,
    })
  );
  const saved = deferred<{ error: null }>();
  mocks.save.mockReturnValueOnce(saved.promise);
  const rendered = render(view());
  const input = await screen.findByDisplayValue('Previous Read');
  fireEvent.change(input, { target: { value: 'New Read' } });
  const save = screen.getByRole('button', { name: 'Save Note' });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(mocks.save).toHaveBeenCalledTimes(1);
  expect(mocks.save.mock.calls[0][0]).toMatchObject({
    user_id: 'account-a',
    target_user_id: 'opponent',
    notes: 'New Read',
  });
  await act(async () => saved.resolve({ error: null }));
  mocks.save.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(input, { target: { value: 'Keep My Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Note' }));
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith('Failed To Save Note. Your Draft Is Still Here.')
  );
  expect(input).toHaveValue('Keep My Draft');
  expect(input).not.toBeDisabled();
  mocks.save.mockResolvedValueOnce({ error: null });
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Note' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(3));
  expect(mocks.save.mock.calls[2][0]).toMatchObject({ notes: '' });
  rendered.unmount();
});

it('retries an unread note before permitting an edit', async () => {
  mocks.checkVIPStatus.mockResolvedValue({ isVIP: false });
  mocks.noteReads.set('account-a', Promise.reject(new Error('offline')));
  render(view());
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(screen.getByRole('button', { name: 'Save Note' })).toBeDisabled();
  mocks.noteReads.set(
    'account-a',
    Promise.resolve({
      data: { id: 'note', notes: 'Recovered Read', tags: [], color_label: 'none' },
      error: null,
    })
  );
  fireEvent.click(retry);
  expect(await screen.findByDisplayValue('Recovered Read')).not.toBeDisabled();
});
