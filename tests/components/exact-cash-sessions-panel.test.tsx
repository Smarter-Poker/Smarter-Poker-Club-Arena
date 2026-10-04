import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const get = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/StatsCashSessionService', () => ({ StatsCashSessionService: { get } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import ExactCashSessionsPanel from '../../src/components/stats/ExactCashSessionsPanel';

const base = {
  contract_version: 2,
  scope: {
    target_user_id: 'u1',
    club_id: 'c1',
    asset: 'chips',
    range_days: 30,
    range_tz: 'UTC',
    visibility: 'owner',
  },
  coverage: {
    source: 'cash_player_session+ca_hand_facts',
    total_sessions: 2,
    returned_sessions: 2,
    capped: false,
  },
  generated_at: '2026-10-03',
  sessions: [
    {
      session_id: 's1',
      club_id: 'c1',
      table_id: 't1',
      cluster_id: null,
      variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      opened_at: '2026-10-03T00:00:00Z',
      closed_at: '2026-10-03T01:00:00Z',
      closed_reason: 'leave',
      duration_seconds: 3600,
      buyin_and_rebuys: 100,
      final_cashout: 140,
      session_result: 40,
      capture_status: 'exact',
      capture_reason: null,
      hand_count: 20,
      hand_net: 40,
      hand_evidence_status: 'exact_facts',
      overlap: false,
      overlap_count: 0,
      evidence: { kind: 'cash_session', session_id: 's1' },
    },
    {
      session_id: 's2',
      club_id: 'c1',
      table_id: 't2',
      cluster_id: null,
      variant: 'plo4',
      small_blind: 1,
      big_blind: 2,
      opened_at: '2026-10-02T00:00:00Z',
      closed_at: '2026-10-02T01:00:00Z',
      closed_reason: 'table_closed',
      duration_seconds: 3600,
      buyin_and_rebuys: 100,
      final_cashout: null,
      session_result: null,
      capture_status: 'partial',
      capture_reason: 'close_stack_unavailable',
      hand_count: null,
      hand_net: null,
      hand_evidence_status: 'overlap_unavailable',
      overlap: true,
      overlap_count: 1,
      evidence: { kind: 'cash_session', session_id: 's2' },
    },
  ],
};
describe('ExactCashSessionsPanel', () => {
  beforeEach(() => get.mockReset());
  it('separates exact close values from partial and overlapping evidence', async () => {
    get.mockResolvedValue(base);
    render(
      <MemoryRouter>
        <ExactCashSessionsPanel
          userId="u1"
          clubId="c1"
          clubLabel="Night Owls"
          days={30}
          timezone="UTC"
          asset="chips"
        />
      </MemoryRouter>
    );
    expect(await screen.findByText('Exact Session Ledger')).toBeInTheDocument();
    expect(screen.getByText('Exact Close')).toBeInTheDocument();
    expect(screen.getAllByText('Not Yet Measured').length).toBeGreaterThan(0);
    expect(screen.getByText(/Double Attribution/)).toBeInTheDocument();
    expect(screen.getByText('s1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Session Hands' })).toHaveAttribute(
      'href',
      '/hand-history?source=stats&statsSession=s1&statsAsset=chips&statsClub=c1'
    );
  });
  it('shows a verification failure instead of an empty ledger', async () => {
    get.mockResolvedValue(null);
    render(
      <MemoryRouter>
        <ExactCashSessionsPanel
          userId="u1"
          clubId={null}
          clubLabel="All Clubs"
          days={null}
          timezone="UTC"
          asset="chips"
        />
      </MemoryRouter>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could Not Be Verified');
  });
  it('never paints an older scope response over the current club', async () => {
    let resolveA!: (value: typeof base) => void;
    let resolveB!: (value: typeof base) => void;
    get
      .mockReturnValueOnce(new Promise((resolve) => (resolveA = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveB = resolve)));
    const { rerender } = render(
      <MemoryRouter>
        <ExactCashSessionsPanel
          userId="u1"
          clubId="a"
          clubLabel="Club A"
          days={30}
          timezone="UTC"
          asset="chips"
        />
      </MemoryRouter>
    );
    rerender(
      <MemoryRouter>
        <ExactCashSessionsPanel
          userId="u1"
          clubId="b"
          clubLabel="Club B"
          days={30}
          timezone="UTC"
          asset="chips"
        />
      </MemoryRouter>
    );
    resolveB({
      ...base,
      sessions: [
        {
          ...base.sessions[0],
          session_id: 'session-b',
          evidence: { kind: 'cash_session', session_id: 'session-b' },
        },
      ],
    });
    expect(await screen.findByText('session-b')).toBeInTheDocument();
    resolveA(base);
    await Promise.resolve();
    expect(screen.getByText('session-b')).toBeInTheDocument();
    expect(screen.queryByText('s1')).not.toBeInTheDocument();
  });
});
