import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Dispute, DisputeStatus } from '../../src/services/DisputeService';

const m = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  return {
    user: { id: 'player-a' },
    getMyDisputes: vi.fn(),
    getClubDisputes: vi.fn(),
    startReview: vi.fn(),
    resolveDispute: vi.fn(),
    escalateDispute: vi.fn(),
    withdrawDispute: vi.fn(),
    reportError: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
    channel,
    removeRegisteredChannel: vi.fn(),
  };
});

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: m.user, isHydrating: false }),
}));

vi.mock('../../src/hooks/useVisibilityRefresh', () => ({
  useVisibilityRefresh: vi.fn(),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => m.toast,
}));

vi.mock('../../src/components/club/ClubIntegrityHeader', () => ({
  default: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    titleId,
    children,
  }: {
    title: string;
    titleId?: string;
    children: ReactNode;
  }) => (
    <section>
      <h2 id={titleId}>{title}</h2>
      {children}
    </section>
  ),
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    getOrCreateChannel: vi.fn(() => m.channel),
    removeRegisteredChannel: (...args: unknown[]) => m.removeRegisteredChannel(...args),
    subscribeDebounced: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (clubId: string) => clubId,
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => m.reportError(...args),
}));

vi.mock('../../src/services/DisputeService', () => ({
  parseDisputeAdjustmentAmount: (value: string) => Number(value),
  DisputeService: {
    getMyDisputes: (...args: unknown[]) => m.getMyDisputes(...args),
    getClubDisputes: (...args: unknown[]) => m.getClubDisputes(...args),
    startReview: (...args: unknown[]) => m.startReview(...args),
    resolveDispute: (...args: unknown[]) => m.resolveDispute(...args),
    escalateDispute: (...args: unknown[]) => m.escalateDispute(...args),
    withdrawDispute: (...args: unknown[]) => m.withdrawDispute(...args),
  },
}));

import DisputeManagementPage from '../../src/pages/DisputeManagementPage';

function dispute(status: DisputeStatus = 'open'): Dispute {
  return {
    id: `dispute-${status}`,
    submittedBy: 'player-a',
    submitterName: 'Player One',
    targetType: 'cashout_request',
    targetId: 'cashout-a',
    clubId: 'club-a',
    amount: 125.5,
    reason: 'wrong amount',
    status,
    resolution: status === 'resolved' ? 'account reconciled' : undefined,
    createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z',
  };
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/disputes" element={<DisputeManagementPage />} />
        <Route path="/clubs/:clubId/disputes" element={<DisputeManagementPage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function expandLoadedCase() {
  const submitter = await screen.findByText('By Player One');
  const caseButton = submitter.closest('button');
  expect(caseButton).not.toBeNull();
  fireEvent.click(caseButton!);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getMyDisputes.mockResolvedValue([]);
  m.getClubDisputes.mockResolvedValue([]);
  m.startReview.mockResolvedValue(undefined);
  m.resolveDispute.mockResolvedValue(undefined);
  m.escalateDispute.mockResolvedValue(undefined);
  m.withdrawDispute.mockResolvedValue(undefined);
  m.channel.on.mockReturnValue(m.channel);
  m.channel.subscribe.mockReturnValue(m.channel);
});

afterEach(() => cleanup());

describe('Dispute Management route authority', () => {
  it.each<DisputeStatus>(['open', 'under_review'])(
    'keeps the personal %s case free of staff controls and permits the supported withdrawal',
    async (status) => {
      const row = dispute(status);
      m.getMyDisputes.mockResolvedValue([row]);

      mount('/disputes');
      await expandLoadedCase();

      expect(screen.getByRole('button', { name: 'Withdraw Dispute' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Start Review' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Resolve Dispute' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Escalate' })).toBeNull();
      expect(screen.queryByLabelText('Resolution Notes')).toBeNull();
      expect(screen.queryByLabelText('Balance Adjustment Type')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Withdraw Dispute' }));
      await waitFor(() => expect(m.withdrawDispute).toHaveBeenCalledWith(row.id, 'player-a'));
      expect(m.startReview).not.toHaveBeenCalled();
      expect(m.resolveDispute).not.toHaveBeenCalled();
      expect(m.escalateDispute).not.toHaveBeenCalled();
    }
  );

  it.each<DisputeStatus>(['resolved', 'escalated', 'withdrawn'])(
    'keeps the personal %s case read-only',
    async (status) => {
      m.getMyDisputes.mockResolvedValue([dispute(status)]);

      mount('/disputes');
      await screen.findByText('By Player One');

      expect(screen.queryByRole('button', { name: 'Withdraw Dispute' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start Review' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Resolve Dispute' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Escalate' })).toBeNull();
      expect(screen.queryByLabelText('Balance Adjustment Type')).toBeNull();
    }
  );

  it('retains the staff review and debit-credit resolution controls only in club scope', async () => {
    const row = dispute('open');
    m.getClubDisputes.mockResolvedValue([row]);

    mount('/clubs/club-a/disputes');
    await expandLoadedCase();

    expect(screen.queryByRole('button', { name: 'Withdraw Dispute' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Review' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resolve Dispute' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Escalate' })).toBeVisible();
    expect(screen.getByLabelText('Resolution Notes')).toBeVisible();
    expect(screen.getByLabelText('Balance Adjustment Type')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Start Review' }));
    await waitFor(() => expect(m.startReview).toHaveBeenCalledWith(row.id, 'player-a'));
    expect(m.withdrawDispute).not.toHaveBeenCalled();
  });
});
