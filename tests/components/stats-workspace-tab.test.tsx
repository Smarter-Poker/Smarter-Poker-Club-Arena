import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  load: vi.fn(),
  saveReport: vi.fn(),
  saveLeak: vi.fn(),
  saveGoal: vi.fn(),
  addGoalProgress: vi.fn(),
  saveCollection: vi.fn(),
  addStudyHand: vi.fn(),
  savePreferences: vi.fn(),
  saveAlertRule: vi.fn(),
}));
vi.mock('../../src/services/StatsWorkspaceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/StatsWorkspaceService')>();
  return { ...actual, statsWorkspaceService: service };
});

import WorkspaceTab from '../../src/pages/stats/WorkspaceTab';
import { useUserStore } from '../../src/stores/useUserStore';
import { flushPreferencesBeforeLogout } from '../../src/lib/tableSettingIntents';

const snapshot = {
  reports: [],
  leaks: [],
  goals: [],
  progress: [],
  collections: [],
  alerts: [],
  preferences: { dashboardLayout: [], privacyPresentationMode: false },
  coverage: { capped: false, rowLimit: 100 },
};

describe('WorkspaceTab mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useUserStore.setState({ user: { id: 'workspace-owner' } as any });
    service.savePreferences.mockResolvedValue({ ok: true, data: true });
    service.load.mockResolvedValue({ ok: true, data: snapshot });
    service.saveReport.mockResolvedValue({ ok: true, data: 'report-1' });
    service.saveLeak.mockResolvedValue({ ok: true, data: 'leak-1' });
  });

  it('keeps report and leak evidence in their own payloads', async () => {
    render(<WorkspaceTab isOwnProfile />);
    await screen.findByText('Workspace Builder');

    fireEvent.change(screen.getByLabelText('Report Title'), { target: { value: 'River Review' } });
    fireEvent.change(screen.getByLabelText('Report Summary'), { target: { value: 'Fold More' } });
    fireEvent.change(screen.getByLabelText('Player Report Evidence Hand'), {
      target: { value: 'report-hand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Player-Authored Report' }));
    await waitFor(() => expect(service.saveReport).toHaveBeenCalledTimes(1));
    expect(service.saveReport.mock.calls[0][0].evidence).toEqual([{ hand_id: 'report-hand' }]);

    fireEvent.change(screen.getByLabelText('Leak To Practice'), {
      target: { value: 'Blind Leak' },
    });
    fireEvent.change(screen.getByLabelText('Leak Evidence Hand'), {
      target: { value: 'leak-hand' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Track Leak' }));
    await waitFor(() => expect(service.saveLeak).toHaveBeenCalledTimes(1));
    expect(service.saveLeak.mock.calls[0][0].evidenceHandIds).toEqual(['leak-hand']);
  });

  it('admits only one create while a mutation is in flight', async () => {
    let resolve!: (value: { ok: true; data: string }) => void;
    service.saveLeak.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<WorkspaceTab isOwnProfile />);
    await screen.findByText('Workspace Builder');
    fireEvent.change(screen.getByLabelText('Leak To Practice'), { target: { value: 'One Leak' } });
    const submit = screen.getByRole('button', { name: 'Track Leak' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(service.saveLeak).toHaveBeenCalledTimes(1);
    resolve({ ok: true, data: 'leak-1' });
    await waitFor(() =>
      expect(screen.getByText('Leak Added To Your Practice Queue.')).toBeVisible()
    );
  });

  it('changes privacy without overwriting a legacy or concurrently selected dashboard', async () => {
    service.load.mockResolvedValue({
      ok: true,
      data: {
        ...snapshot,
        preferences: {
          dashboardLayout: ['workspace', 'bogus', 'hands', 'hands'],
          privacyPresentationMode: false,
        },
      },
    });
    service.savePreferences.mockResolvedValue({ ok: true, data: undefined });

    render(<WorkspaceTab isOwnProfile />);
    await screen.findByText('Workspace Builder');
    fireEvent.click(screen.getByRole('button', { name: 'Use Presentation Mode' }));

    await waitFor(() => expect(service.savePreferences).toHaveBeenCalledTimes(1));
    expect(service.savePreferences).toHaveBeenCalledWith(
      { privacyPresentationMode: true },
      'workspace-owner'
    );
  });

  it('autosaves valid complete dashboard choices, ignores partial typing and tracks the original save through logout', async () => {
    let finish!: (value: { ok: true; data: boolean }) => void;
    service.load.mockResolvedValue({ ok: true, data: snapshot });
    service.savePreferences.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const onLayout = vi.fn();
    render(<WorkspaceTab isOwnProfile onDashboardLayoutChange={onLayout} />);
    await screen.findByText('Workspace Builder');
    const zones = screen.getByLabelText('Dashboard Zones');
    onLayout.mockClear();
    fireEvent.change(zones, { target: { value: 'over' } });
    fireEvent.change(zones, { target: { value: 'overview,' } });
    expect(service.savePreferences).not.toHaveBeenCalled();
    expect(onLayout).not.toHaveBeenCalled();
    fireEvent.change(zones, { target: { value: 'hands, overview' } });
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onLayout.mock.calls[0][0].slice(0, 2)).toEqual(['hands', 'overview']);
    await waitFor(() =>
      expect(service.savePreferences).toHaveBeenCalledWith(
        { dashboardLayout: ['hands', 'overview'] },
        'workspace-owner'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use Presentation Mode' }));
    expect(service.savePreferences).toHaveBeenCalledTimes(1);
    let flushed = false;
    const logout = flushPreferencesBeforeLogout('workspace-owner').then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    finish({ ok: true, data: true });
    await logout;
    expect(flushed).toBe(true);
    expect(service.savePreferences.mock.calls.map((call) => call[0])).toEqual([
      { dashboardLayout: ['hands', 'overview'] },
      { privacyPresentationMode: true },
    ]);
  });
});
