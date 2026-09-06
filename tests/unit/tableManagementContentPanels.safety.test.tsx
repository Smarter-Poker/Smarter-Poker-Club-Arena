import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TICKER_SETTINGS } from '../../src/services/TickerManagementService';
import { ManagementContentError } from '../../src/services/ManagementContentError';

const mocks = vi.hoisted(() => {
  const toastError = vi.fn();
  const toastSuccess = vi.fn();
  return {
    tickerGet: vi.fn(),
    tickerSave: vi.fn(),
    messagesGet: vi.fn(),
    identitySave: vi.fn(),
    announcementSave: vi.fn(),
    toastError,
    toastSuccess,
    toast: { error: toastError, success: toastSuccess },
    confirm: vi.fn(),
    tickerEvent: null as null | ((payload: any) => void),
    messageEvent: null as null | ((payload: any) => void),
  };
});

vi.mock('../../src/services/TickerManagementService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/TickerManagementService')>();
  return {
    ...original,
    tickerManagementService: {
      getManagement: mocks.tickerGet,
      save: mocks.tickerSave,
    },
  };
});

vi.mock('../../src/services/ClubMessageManagementService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/ClubMessageManagementService')>();
  return {
    ...original,
    clubMessageManagementService: {
      get: mocks.messagesGet,
      saveIdentity: mocks.identitySave,
      manageAnnouncement: mocks.announcementSave,
    },
  };
});

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../src/components/common/confirmDialog', () => ({
  confirmDialog: mocks.confirm,
}));

vi.mock('../../src/hooks/useMasterBusSubscription', () => ({
  useMasterBusSubscription: (_event: string, callback: (payload: any) => void) => {
    mocks.tickerEvent = callback;
  },
  useMasterBusSubscriptions: (_events: string[], callback: (payload: any) => void) => {
    mocks.messageEvent = callback;
  },
}));

import TickerManagementPanel from '../../src/components/club/TickerManagementPanel';
import ClubMessageManagementPanel from '../../src/components/club/ClubMessageManagementPanel';

const tickerSnapshot = {
  settings: {
    ...DEFAULT_TICKER_SETTINGS,
    sources: { ...DEFAULT_TICKER_SETTINGS.sources },
    customMessages: [],
    serviceMessages: [],
  },
  revision: 3,
  updatedAt: '2026-09-01T12:00:00Z',
};

const messageSnapshot = {
  identity: { tagline: 'Sharks', lobbyMessage: 'Welcome', description: 'Play fair.' },
  identityRevision: 4,
  announcements: [],
};

describe('Table Management content panels fail closed', () => {
  beforeEach(() => {
    for (const mock of [
      mocks.tickerGet,
      mocks.tickerSave,
      mocks.messagesGet,
      mocks.identitySave,
      mocks.announcementSave,
      mocks.toastError,
      mocks.toastSuccess,
      mocks.confirm,
    ])
      mock.mockReset();
    mocks.confirm.mockResolvedValue(true);
    mocks.tickerEvent = null;
    mocks.messageEvent = null;
  });

  it('locks ticker editing after a failed authoritative read and exposes retry', async () => {
    mocks.tickerGet.mockRejectedValue(new Error('Network unavailable'));
    render(<TickerManagementPanel scope="club" scopeId="club-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Ticker Editing Is Locked');
    expect(screen.getByLabelText('Overlay Alerts')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Ticker' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(mocks.tickerGet).toHaveBeenCalledTimes(2);
  });

  it('keeps a dirty ticker draft intact when another device publishes', async () => {
    mocks.tickerGet.mockResolvedValue(tickerSnapshot);
    render(<TickerManagementPanel scope="club" scopeId="club-1" />);
    await waitFor(() => expect(screen.getByLabelText('Overlay Alerts')).toBeEnabled());

    fireEvent.change(screen.getByLabelText(/Scroll Speed/), { target: { value: '33' } });
    act(() => mocks.tickerEvent?.({ scope: 'club', scopeId: 'club-1' }));

    expect(await screen.findByText('Newer Settings Are Available')).toBeInTheDocument();
    expect(screen.getByLabelText(/Scroll Speed/)).toHaveValue('33');
    expect(mocks.tickerGet).toHaveBeenCalledTimes(1);
  });

  it('retains the ticker draft and offers latest state after a compare-and-swap conflict', async () => {
    mocks.tickerGet.mockResolvedValue(tickerSnapshot);
    mocks.tickerSave.mockRejectedValue(
      new ManagementContentError('version_conflict', 'Newer settings exist.', 4)
    );
    render(<TickerManagementPanel scope="club" scopeId="club-1" />);
    await waitFor(() => expect(screen.getByLabelText(/Scroll Speed/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Scroll Speed/), { target: { value: '35' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save Ticker' }));

    expect(await screen.findByText('Newer Settings Are Available')).toBeInTheDocument();
    expect(screen.getByLabelText(/Scroll Speed/)).toHaveValue('35');
  });

  it('does not discard a ticker draft when loading latest is cancelled', async () => {
    mocks.tickerGet.mockResolvedValue(tickerSnapshot);
    mocks.confirm.mockResolvedValue(false);
    render(<TickerManagementPanel scope="club" scopeId="club-1" />);
    await waitFor(() => expect(screen.getByLabelText(/Scroll Speed/)).toBeEnabled());
    fireEvent.change(screen.getByLabelText(/Scroll Speed/), { target: { value: '41' } });
    act(() => mocks.tickerEvent?.({ scope: 'club', scopeId: 'club-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Load Latest' }));

    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.tickerGet).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/Scroll Speed/)).toHaveValue('41');
  });

  it('ignores a late ticker response from the previous scope', async () => {
    let resolveFirst!: (value: typeof tickerSnapshot) => void;
    mocks.tickerGet
      .mockImplementationOnce(
        () => new Promise<typeof tickerSnapshot>((resolve) => (resolveFirst = resolve))
      )
      .mockResolvedValueOnce({
        ...tickerSnapshot,
        settings: { ...tickerSnapshot.settings, speedSeconds: 39 },
        revision: 9,
      });
    const { rerender } = render(<TickerManagementPanel scope="club" scopeId="club-1" />);
    rerender(<TickerManagementPanel scope="club" scopeId="club-2" />);
    await waitFor(() => expect(screen.getByLabelText(/Scroll Speed/)).toHaveValue('39'));

    await act(async () => resolveFirst(tickerSnapshot));
    expect(screen.getByLabelText(/Scroll Speed/)).toHaveValue('39');
  });

  it('locks blank club-message fields after a failed read', async () => {
    mocks.messagesGet.mockRejectedValue(new Error('Permission refresh failed'));
    render(<ClubMessageManagementPanel clubId="club-1" clubName="Shark Club" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Message Editing Is Locked');
    expect(screen.getByLabelText('Club Tag Line')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Club Messages' })).toBeDisabled();
  });

  it('does not clobber a dirty identity draft when realtime reports a newer version', async () => {
    mocks.messagesGet.mockResolvedValue(messageSnapshot);
    render(<ClubMessageManagementPanel clubId="club-1" clubName="Shark Club" />);
    const tagline = await screen.findByLabelText('Club Tag Line');
    await waitFor(() => expect(tagline).toBeEnabled());
    await userEvent.clear(tagline);
    await userEvent.type(tagline, 'Local Draft');
    act(() => mocks.messageEvent?.({ clubId: 'club-1' }));

    expect(await screen.findByText('A Newer Version Is Available')).toBeInTheDocument();
    expect(tagline).toHaveValue('Local Draft');
    expect(mocks.messagesGet).toHaveBeenCalledTimes(1);
  });

  it('keeps a stale identity draft after a version conflict', async () => {
    mocks.messagesGet.mockResolvedValue(messageSnapshot);
    mocks.identitySave.mockRejectedValue(
      new ManagementContentError('version_conflict', 'Another operator saved first.', 5)
    );
    render(<ClubMessageManagementPanel clubId="club-1" clubName="Shark Club" />);
    const tagline = await screen.findByLabelText('Club Tag Line');
    await waitFor(() => expect(tagline).toBeEnabled());
    await userEvent.clear(tagline);
    await userEvent.type(tagline, 'Still Local');
    await userEvent.click(screen.getByRole('button', { name: 'Save Club Messages' }));

    expect(await screen.findByText('A Newer Version Is Available')).toBeInTheDocument();
    expect(tagline).toHaveValue('Still Local');
  });

  it('ignores a late club-message response from the previous host club', async () => {
    let resolveFirst!: (value: typeof messageSnapshot) => void;
    mocks.messagesGet
      .mockImplementationOnce(
        () => new Promise<typeof messageSnapshot>((resolve) => (resolveFirst = resolve))
      )
      .mockResolvedValueOnce({
        ...messageSnapshot,
        identity: { ...messageSnapshot.identity, tagline: 'Second Club' },
        identityRevision: 8,
      });
    const { rerender } = render(
      <ClubMessageManagementPanel clubId="club-1" clubName="First Club" />
    );
    rerender(<ClubMessageManagementPanel clubId="club-2" clubName="Second Club" />);
    await waitFor(() => expect(screen.getByLabelText('Club Tag Line')).toHaveValue('Second Club'));

    await act(async () => resolveFirst(messageSnapshot));
    expect(screen.getByLabelText('Club Tag Line')).toHaveValue('Second Club');
  });
});
