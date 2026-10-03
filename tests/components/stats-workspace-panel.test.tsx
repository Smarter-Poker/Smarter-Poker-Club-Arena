import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatsWorkspacePanel from '../../src/components/stats/StatsWorkspacePanel';
import type { StatsWorkspaceSnapshot } from '../../src/services/StatsWorkspaceService';

afterEach(cleanup);

const workspace: StatsWorkspaceSnapshot = {
  reports: [
    {
      id: 'report-1',
      idempotencyKey: 'range-30-v1',
      title: 'Opening Review',
      sourceKind: 'rule_derived',
      sourceVersion: 'rules-v1',
      body: {},
      evidence: [],
      clubId: null,
      rangeDays: 30,
      updatedAt: '2026-10-03T00:00:00Z',
    },
  ],
  leaks: [
    {
      id: 'leak-1',
      reportId: 'report-1',
      leakKey: 'blind-defense',
      title: 'Blind Defense',
      severity: 'medium',
      status: 'open',
      snapshot: {},
      evidenceHandIds: [],
      updatedAt: '2026-10-03T00:00:00Z',
    },
  ],
  goals: [],
  progress: [],
  collections: [
    {
      id: 'collection-1',
      name: 'Blind Defense',
      description: '',
      updatedAt: '2026-10-03T00:00:00Z',
      hands: [
        {
          handId: 'hand-1',
          addedAt: '2026-10-03T00:00:00Z',
          note: { handId: 'hand-1', note: 'Review Turn', tags: ['study'], updatedAt: null },
        },
      ],
    },
  ],
  preferences: { dashboardLayout: ['overview'], privacyPresentationMode: true },
  alerts: [
    {
      id: 'alert-1',
      name: 'Rake Threshold',
      metricKey: 'rake_per_100',
      comparator: 'gt',
      threshold: 12,
      enabled: true,
      cooldownMinutes: 1440,
      evaluationMode: 'on_stats_refresh',
      updatedAt: '2026-10-03T00:00:00Z',
      lastEvaluatedAt: null,
      lastValue: null,
      lastTriggeredAt: null,
    },
  ],
};

describe('StatsWorkspacePanel', () => {
  it('never exposes another player workspace', () => {
    render(
      <StatsWorkspacePanel
        isOwnProfile={false}
        workspace={workspace}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText('This Workspace Is Available Only To Its Player.')).toBeInTheDocument();
    expect(screen.queryByText('Opening Review')).not.toBeInTheDocument();
  });

  it('states provenance, note reuse, privacy mode and refresh-only alerts', () => {
    const onPrivacyModeChange = vi.fn();
    const onLeakStatusChange = vi.fn();
    render(
      <StatsWorkspacePanel
        isOwnProfile
        workspace={workspace}
        loading={false}
        error={null}
        onRetry={vi.fn()}
        onPrivacyModeChange={onPrivacyModeChange}
        onLeakStatusChange={onLeakStatusChange}
      />
    );
    expect(screen.getByText(/Generated From Versioned Rules, Not A Model/)).toBeInTheDocument();
    expect(screen.getByText('1 Saved Hand, With Private Notes')).toBeInTheDocument();
    expect(screen.getByText('Evaluated Only When Stats Refresh.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Full Detail' }));
    expect(onPrivacyModeChange).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByLabelText('Status For Blind Defense'), {
      target: { value: 'practicing' },
    });
    expect(onLeakStatusChange).toHaveBeenCalledWith('leak-1', 'practicing');
  });

  it('keeps loading, failure and empty states distinct', () => {
    const { rerender } = render(
      <StatsWorkspacePanel isOwnProfile workspace={null} loading error={null} onRetry={vi.fn()} />
    );
    expect(screen.getByText('Loading Your Saved Workspace.')).toBeInTheDocument();
    rerender(
      <StatsWorkspacePanel
        isOwnProfile
        workspace={null}
        loading={false}
        error="offline"
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could Not Be Loaded');
  });
});
