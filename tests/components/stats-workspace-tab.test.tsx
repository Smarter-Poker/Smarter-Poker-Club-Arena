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

  it('normalizes a legacy dashboard before saving presentation privacy', async () => {
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
    expect(service.savePreferences).toHaveBeenCalledWith({
      dashboardLayout: [
        'hands',
        'overview',
        'performance',
        'positions',
        'tournaments',
        'analysis',
        'trophies',
        'rake',
      ],
      privacyPresentationMode: true,
    });
  });
});
