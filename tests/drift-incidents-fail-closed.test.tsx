import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dashboard: vi.fn(),
  metrics: vi.fn(),
  act: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  reportError: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../src/services/DriftIncidentService', () => ({
  DriftIncidentService: {
    getDashboard: (...args: unknown[]) => mocks.dashboard(...args),
    getMetrics: (...args: unknown[]) => mocks.metrics(...args),
    act: (...args: unknown[]) => mocks.act(...args),
  },
}));
vi.mock('../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'operator' } }) }));
const isCurrent = () => true;
vi.mock('../src/hooks/useCashoutScope', () => ({
  useCashoutScopeKey: () => 'operator:drift-incidents',
  useCashoutScope: () => isCurrent,
}));
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => undefined }));
vi.mock('../src/components/common/Toast', () => ({
  useToast: () => ({ error: mocks.toastError, success: mocks.toastSuccess }),
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: mocks.reportError }));
vi.mock('../src/pages/DriftGatePanel', () => ({ default: () => <div>Gate Panel</div> }));
vi.mock('../src/components/layouts/StandardContentLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    pill,
    children,
  }: {
    title: string;
    pill?: string;
    children: React.ReactNode;
  }) => (
    <section aria-label={title}>
      {pill && <span data-testid={`${title}-pill`}>{pill}</span>}
      {children}
    </section>
  ),
}));

import DriftIncidentsPage from '../src/pages/DriftIncidentsPage';

const openIncident = {
  id: '11111111-1111-4111-8111-111111111111',
  can_act: true,
  detected_at: '2026-10-05T12:00:00Z',
  deadline_at: '2026-10-05T12:20:00Z',
  classification: 'ledger_imbalance',
  severity: 'critical',
  layer: 'ledger',
  status: 'open',
  source: 'fixture',
  club_id: null,
  union_id: null,
  table_id: null,
  tournament_id: null,
  hand_id: null,
  settlement_id: null,
  currency: 'club_chips',
  expected_amount: 10,
  actual_amount: 9,
  discrepancy_amount: -1,
  ledger_balanced: false,
  suspected_cause: null,
  auto_repair_status: 'pending',
  escalation_level: 0,
  past_target: false,
  occurrences: 1,
  acknowledged_by: null,
  acknowledged_at: null,
  assigned_to: null,
  root_cause: null,
  correction_ref: null,
  resolution: null,
  resolved_at: null,
  metadata: null,
  club_name: 'Midway',
  union_name: null,
  age_minutes: 1,
  events: [],
} as const;

beforeEach(() => {
  mocks.dashboard.mockReset();
  mocks.metrics.mockReset();
  mocks.act.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.reportError.mockReset();
  mocks.navigate.mockReset();
});

describe('Drift Incidents fail-closed reads', () => {
  it('never turns a resolved row without its resolution time into a clear empty queue', async () => {
    mocks.dashboard.mockRejectedValue(new Error('resolved incident without resolved_at'));
    mocks.metrics.mockResolvedValue({ open_total: 1 });

    render(<DriftIncidentsPage />);

    expect(await screen.findByText(/Incident Timeline Unavailable/i)).toBeInTheDocument();
    expect(screen.getByTestId('Drift Incidents-pill')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('Incidents-pill')).toHaveTextContent('--');
    expect(screen.getByText('Queue Unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Open Incidents').parentElement).toHaveTextContent('--');
    expect(screen.getByText('Past 20m Target').parentElement).toHaveTextContent('--');
    expect(screen.getByRole('tab', { name: 'Open (--)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resolved (--)' })).toBeInTheDocument();
    expect(screen.queryByText('All Clear')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument();
  });

  it('keeps a verified incident queue when only metrics fail', async () => {
    mocks.dashboard.mockResolvedValue([openIncident]);
    mocks.metrics.mockRejectedValue(new Error('metrics unavailable'));

    render(<DriftIncidentsPage />);

    expect(await screen.findByText('Ledger Imbalance')).toBeInTheDocument();
    expect(screen.getByText('Live Incident Metrics Are Unavailable.')).toBeInTheDocument();
    expect(screen.getByTestId('Drift Incidents-pill')).toHaveTextContent('1 Open');
  });

  it('renders server-declared read-only incidents without unusable action controls', async () => {
    mocks.dashboard.mockResolvedValue([{ ...openIncident, can_act: false }]);
    mocks.metrics.mockResolvedValue({ open_total: 1 });

    render(<DriftIncidentsPage />);

    expect(await screen.findByText('Read Only For This Operator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('never paints a verified empty detail queue clear while metrics are unavailable', async () => {
    mocks.dashboard.mockResolvedValue([]);
    mocks.metrics.mockRejectedValue(new Error('metrics unavailable'));

    render(<DriftIncidentsPage />);

    expect(await screen.findByTestId('Drift Incidents-pill')).toHaveTextContent(
      'Open Count Unavailable'
    );
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument();
  });

  it('keeps acknowledged and reconciling obligations out of the green clear state', async () => {
    mocks.dashboard.mockResolvedValue([
      {
        ...openIncident,
        id: '22222222-2222-4222-8222-222222222222',
        status: 'acknowledged',
      },
      {
        ...openIncident,
        id: '33333333-3333-4333-8333-333333333333',
        status: 'reconciling',
      },
    ]);
    mocks.metrics.mockResolvedValue({ open_total: 2, auto_repairing: 0, suspense_today: 0 });

    render(<DriftIncidentsPage />);

    expect(await screen.findByTestId('Drift Incidents-pill')).toHaveTextContent('2 Open');
    expect(screen.getByText('Open Incidents').parentElement).toHaveTextContent('2');
    expect(screen.getByRole('tab', { name: 'Open (0)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Acknowledged (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Reconciling (1)' })).toBeInTheDocument();
    expect(screen.getByText('Open Queue Empty')).toBeInTheDocument();
    expect(screen.queryByText('All Clear')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument();
  });

  it('uses the authoritative open metric when the 500-row detail window is bounded', async () => {
    mocks.dashboard.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({
        ...openIncident,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        status: 'resolved',
        resolved_at: '2026-10-05T12:01:00Z',
      }))
    );
    mocks.metrics.mockResolvedValue({ open_total: 7, past_target: 3 });

    render(<DriftIncidentsPage />);

    expect(await screen.findByTestId('Drift Incidents-pill')).toHaveTextContent('7 Open');
    expect(screen.getByText('Open Incidents').parentElement).toHaveTextContent('7');
    expect(screen.getByText('Past 20m Target').parentElement).toHaveTextContent('3');
    expect(screen.getByText('Avg Loaded Resolution Age').parentElement).toHaveTextContent(
      '1m Loaded Window'
    );
    expect(screen.getByRole('tab', { name: 'Open (0+)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resolved (500+)' })).toBeInTheDocument();
    expect(screen.getByText('Open Queue Bounded')).toBeInTheDocument();
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument();
  });

  it('never turns a bounded 500-row detail window into an exact clear when metrics fail', async () => {
    mocks.dashboard.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => ({
        ...openIncident,
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        status: 'resolved',
        resolved_at: '2026-10-05T12:01:00Z',
      }))
    );
    mocks.metrics.mockRejectedValue(new Error('metrics unavailable'));

    render(<DriftIncidentsPage />);

    expect(await screen.findByTestId('Drift Incidents-pill')).toHaveTextContent(
      'Open Count Bounded'
    );
    expect(screen.getByText('Open Incidents').parentElement).toHaveTextContent('0+');
    expect(screen.getByText('Past 20m Target').parentElement).toHaveTextContent('0+');
    expect(screen.getByText('Open Queue Bounded')).toBeInTheDocument();
    expect(screen.queryByText(/^Clear$/)).not.toBeInTheDocument();
  });

  it('preserves the last verified queue when a refresh is rejected', async () => {
    mocks.dashboard
      .mockResolvedValueOnce([openIncident])
      .mockRejectedValue(new Error('refresh rejected'));
    mocks.metrics.mockResolvedValue({ auto_repairing: 0, suspense_today: 0 });

    render(<DriftIncidentsPage />);
    expect(await screen.findByText('Ledger Imbalance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByText(/Showing The Last Verified Queue/i)).toBeInTheDocument()
    );
    expect(screen.getByText('Ledger Imbalance')).toBeInTheDocument();
    expect(screen.getByTestId('Drift Incidents-pill')).toHaveTextContent('Last Verified');
  });

  it.each(['dashboard', 'metrics'] as const)(
    'clears protected data and leaves the route when %s authority is revoked for the same user',
    async (revokedRead) => {
      mocks.dashboard.mockResolvedValue([openIncident]);
      mocks.metrics.mockResolvedValue({ open_total: 1 });

      render(<DriftIncidentsPage />);
      expect(await screen.findByText('Ledger Imbalance')).toBeInTheDocument();

      if (revokedRead === 'dashboard') {
        mocks.dashboard.mockRejectedValueOnce({ code: '42501', message: 'Access Refused' });
      } else {
        mocks.metrics.mockRejectedValueOnce({ code: '42501', message: 'Access Refused' });
      }

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith('/financial-admin', { replace: true })
      );
      await waitFor(() => expect(screen.queryByText('Ledger Imbalance')).not.toBeInTheDocument());
      expect(screen.queryByText(/Showing The Last Verified Queue/i)).not.toBeInTheDocument();
    }
  );

  it('clears protected data and leaves the route when action authority is revoked', async () => {
    mocks.dashboard.mockResolvedValue([openIncident]);
    mocks.metrics.mockResolvedValue({ open_total: 1 });
    mocks.act.mockRejectedValue({ code: '42501', message: 'Action Access Refused' });

    render(<DriftIncidentsPage />);
    expect(await screen.findByText('Ledger Imbalance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/financial-admin', { replace: true })
    );
    await waitFor(() => expect(screen.queryByText('Ledger Imbalance')).not.toBeInTheDocument());
    expect(mocks.act).toHaveBeenCalledWith(openIncident.id, 'acknowledge', {
      note: null,
      rootCause: null,
    });
    expect(screen.queryByText(/Showing The Last Verified Queue/i)).not.toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalledWith('Incident action failed');
  });

  it('sanitizes dynamic operator copy and withholds raw supplemental metadata', async () => {
    mocks.dashboard.mockResolvedValue([
      {
        ...openIncident,
        source: 'ledger_write.audit',
        club_name: 'shark\u0000 club',
        union_name: 'midwest_union',
        suspected_cause: 'missing_post_balance',
        root_cause: 'matched deterministic record fade0000-0000-0000-0000-000000000001',
        table_id: '33333333-3333-4333-8333-333333333333',
        tournament_id: '44444444-4444-4444-8444-444444444444',
        hand_id: '55555555-5555-4555-8555-555555555555',
        settlement_id: '66666666-6666-4666-8666-666666666666',
        correction_ref: '77777777-7777-4777-8777-777777777777',
        assigned_to: '88888888-8888-4888-8888-888888888888',
        acknowledged_at: '2026-10-05T12:01:00Z',
        acknowledged_by: '99999999-9999-4999-8999-999999999999',
        metadata: {
          entity_id: '22222222-2222-4222-8222-222222222222',
          raw_decimal: 1234.56,
        },
        events: [
          {
            at: '2026-10-05T12:01:00Z',
            kind: 'repair_action',
            actor: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            detail: 'manual_review_started for bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ],
      },
    ]);
    mocks.metrics.mockResolvedValue({ auto_repairing: 0, suspense_today: 0 });

    const { container } = render(<DriftIncidentsPage />);

    expect((await screen.findAllByText(/Club Chips/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Shark Club')).toBeInTheDocument();
    expect(screen.getByText('Midwest Union')).toBeInTheDocument();
    expect(screen.getByText('Ledger Write Audit')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Ledger Imbalance/ }));
    expect(screen.getByText('Missing Post Balance')).toBeInTheDocument();
    expect(screen.getByText('Assigned Operator')).toBeInTheDocument();
    expect(screen.getAllByText(/Authorized Operator/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Manual Review Started For Withheld Reference')).toBeInTheDocument();
    expect(screen.getByText('Matched Deterministic Record Withheld Reference')).toBeInTheDocument();
    expect(screen.getAllByText('Linked Record')).toHaveLength(4);
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Additional Metadata Is Retained In The Durable Incident Record And Withheld From This Operator View.'
      )
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent('club_chips');
    expect(container).not.toHaveTextContent('midwest_union');
    expect(container).not.toHaveTextContent('22222222-2222-4222-8222-222222222222');
    expect(container.textContent).not.toMatch(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i);
    expect(container).not.toHaveTextContent('1234.56');
    expect(container.querySelector('pre')).toBeNull();
  });
});

describe('Drift Incidents painted foot contract', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/pages/DriftIncidentsPage.tsx'), 'utf8');
  const consoleCss = readFileSync(
    resolve(process.cwd(), 'src/components/console/SpadeConsole.css'),
    'utf8'
  );

  it('uses only the spade family whose flat foot maps to plate-free art', () => {
    const flatFootCss = consoleCss.match(/\.sc__foot\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(page.match(/family="spade"/g)).toHaveLength(3);
    expect(page.match(/crest="spade"/g)).toHaveLength(2);
    expect(page).not.toMatch(/crest="(?:club|diamond)"/);
    expect(page).not.toContain('family="shark"');
    expect(page).not.toContain('family="riveted"');
    expect(page.match(/foot="foot"/g)).toHaveLength(3);
    expect(flatFootCss).toContain('spade-console-v1/bottom-foot.png');
    expect(flatFootCss).not.toContain('bottom-plates.png');
  });
});
