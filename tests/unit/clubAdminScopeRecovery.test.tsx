// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClubSettingsPage from '../../src/pages/ClubSettingsPage';
import ClubControlActions from '../../src/components/club/ClubControlActions';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  emit: vi.fn(),
  listeners: new Map<string, (event: unknown) => void>(),
  workspace: {
    clubUUID: 'club-a',
    routeClubId: 'club-a',
    canControlClub: true,
    loading: false,
    error: null,
  },
  user: { id: 'owner' },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: mocks.user }) }));
vi.mock('../../src/contexts/ClubWorkspaceContext', () => ({
  useClubWorkspace: () => mocks.workspace,
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/retryFetch', () => ({ retryFetch: (read: () => unknown) => read() }));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../../src/services/ClubsService', () => ({ ClubsService: {} }));
vi.mock('../../src/services/MembershipService', () => ({ MembershipService: {} }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (id: string) => id,
  resolveClubIdFilter: (id: string) => ({ column: 'id', value: id }),
}));
vi.mock('../../src/lib/appBase', () => ({ publicOrigin: () => 'https://smarter.poker' }));
vi.mock('../../src/components/bbj/BBJThresholdPanel', () => ({ default: () => null }));
vi.mock('../../src/components/bbj/BBJMiniPanel', () => ({ default: () => null }));
vi.mock('../../src/components/club/SpinActivationPanel', () => ({ default: () => null }));
vi.mock('../../src/components/admin/AuditLog', () => ({ default: () => null }));
vi.mock('../../src/components/admin/StatsExport', () => ({ StatsExport: () => null }));
vi.mock('../../src/components/common/PageSkeleton', () => ({
  default: () => <p>Loading Settings</p>,
}));
vi.mock('../../src/components/club/ClubEntryMessage', () => ({ CLUB_ENTRY_MESSAGE_MAX: 240 }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: mocks.emit,
    subscribeDebounced: (type: string, handler: (event: unknown) => void) => {
      mocks.listeners.set(type, handler);
      return () => {
        if (mocks.listeners.get(type) === handler) mocks.listeners.delete(type);
      };
    },
    removeRegisteredChannel: vi.fn(),
    getOrCreateChannel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    executeOptimistic: async (_type: string, _payload: unknown, write: () => Promise<unknown>) =>
      write(),
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table: string) => {
      let id = '';
      let payload: unknown;
      const query = {
        eq: (_field: string, value: string) => {
          id = value;
          return query;
        },
        update: (next: unknown) => {
          payload = next;
          return query;
        },
        select: () => (payload ? mocks.write(payload, id) : query),
        maybeSingle: () =>
          table === 'profiles'
            ? Promise.resolve({ data: { player_number: 12345 }, error: null })
            : mocks.read(id),
      };
      return query;
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function club(id: string) {
  return {
    data: {
      id,
      owner_id: 'owner',
      club_id: id === 'club-a' ? 10001 : 10002,
      name: id === 'club-a' ? 'Club Alpha' : 'Club Beta',
      description: '',
      tagline: '',
      lobby_message: 'Welcome',
      is_public: true,
      requires_approval: true,
      default_rake_percent: -1,
      rake_cap: -1,
      spins_enabled: false,
      union_id: null,
    },
    error: null,
  };
}
function SwitchClub() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/clubs/club-b/settings')}>Open Club Beta</button>;
}
function openSettings() {
  return render(
    <MemoryRouter initialEntries={['/clubs/club-a/settings']}>
      <SwitchClub />
      <Routes>
        <Route path="/clubs/:clubId/settings" element={<ClubSettingsPage />} />
      </Routes>
    </MemoryRouter>
  );
}
const openControl = () => (
  <MemoryRouter>
    <ClubControlActions />
  </MemoryRouter>
);
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.workspace.canControlClub = true;
  mocks.read.mockImplementation(async (id) => club(id));
  mocks.write.mockResolvedValue({ data: [{ id: 'club-a' }], error: null });
});

describe('Club administration rejects stale operation completion', () => {
  it('loads the current policy again after same-club access refresh', async () => {
    mocks.read.mockResolvedValue({
      data: { lobby_message: 'First', is_public: true, requires_approval: true },
      error: null,
    });
    const view = render(openControl());
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('First')
    );
    mocks.workspace.canControlClub = false;
    view.rerender(openControl());
    mocks.read.mockResolvedValue({
      data: { lobby_message: 'Latest', is_public: false, requires_approval: true },
      error: null,
    });
    mocks.workspace.canControlClub = true;
    view.rerender(openControl());
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Latest')
    );
    expect(screen.getByText(/Private Club/)).toBeTruthy();
  });
  it('does not put an earlier club save into the next club form', async () => {
    const write = deferred<{ data: { id: string }[]; error: null }>();
    mocks.write.mockReturnValue(write.promise);
    openSettings();
    const name = await screen.findByLabelText('Club Name');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Club Alpha'));
    fireEvent.change(name, { target: { value: 'Alpha Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
    // The existing Discard action is available during the in-flight save.
    // Remove local dirty state so this case isolates the late save receipt.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Club Beta' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Club Name') as HTMLInputElement).value).toBe('Club Beta')
    );
    await act(async () => write.resolve({ data: [{ id: 'club-a' }], error: null }));
    expect((screen.getByLabelText('Club Name') as HTMLInputElement).value).toBe('Club Beta');
    expect(screen.queryByText(/Unsaved Change/)).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith('CLUB_SETTINGS_UPDATED', { clubId: 'club-a' });
  });
  it('does not preserve another club unsaved draft as the new club settings', async () => {
    openSettings();
    const name = await screen.findByLabelText('Club Name');
    fireEvent.change(name, { target: { value: 'Unsaved Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Club Beta' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Club Name') as HTMLInputElement).value).toBe('Club Beta')
    );
    expect(screen.queryByText(/Unsaved Change/)).toBeNull();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('reports clipboard denial without claiming the invite was copied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Permission Denied')) },
    });
    openSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Invite Link' }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('Invite Link Could Not Be Copied. Please Try Again.')
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });
  it('accepts saved settings events carrying the resolved club UUID', async () => {
    mocks.read.mockResolvedValue({
      ...club('club-a'),
      data: { ...club('club-a').data, id: 'canonical-a' },
    });
    openSettings();
    await waitFor(() =>
      expect((screen.getByLabelText('Club Name') as HTMLInputElement).value).toBe('Club Alpha')
    );
    mocks.read.mockResolvedValue({
      ...club('club-a'),
      data: { ...club('club-a').data, id: 'canonical-a', name: 'Alpha From Control' },
    });
    await act(async () =>
      mocks.listeners.get('CLUB_SETTINGS_UPDATED')?.({ payload: { clubId: 'canonical-a' } })
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Club Name') as HTMLInputElement).value).toBe(
        'Alpha From Control'
      )
    );
  });
});
