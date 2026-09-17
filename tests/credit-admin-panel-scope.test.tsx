import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = {
  data: Record<string, unknown>[] | null;
  error: { message: string; code?: string } | null;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  userId: 'operator-a',
  scopeUserId: undefined as string | undefined,
  clubRole: 'owner',
  platformWide: false,
  rows: new Map<string, Record<string, unknown>[]>(),
  agentGates: new Map<string, Promise<Reply>>(),
  auditGates: new Map<string, Promise<Reply>>(),
  auditRows: [] as Record<string, unknown>[],
  profileGates: [] as Promise<Reply>[],
  queries: [] as {
    table: string;
    userId: string;
    filters: Map<string, unknown>;
    limit?: number;
    columns?: string;
  }[],
  toast: { error: vi.fn(), success: vi.fn() },
  export: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId }, isHydrating: false }),
}));
vi.mock('../src/hooks/useFinancialAdminScope', async (original) => {
  const real = await original<typeof import('../src/hooks/useFinancialAdminScope')>();
  const { useLocation } = await import('react-router-dom');
  return {
    ...real,
    useFinancialAdminScope: () => {
      const location = useLocation();
      return {
        status: 'ready',
        clubId: mocks.platformWide
          ? null
          : new URLSearchParams(location.search).get('club') || 'club-a',
        platformWide: mocks.platformWide,
        clubRole: mocks.clubRole,
        isPlatformStaff: mocks.platformWide,
        userId: mocks.scopeUserId ?? mocks.userId,
        message: null,
        reload: vi.fn(),
      };
    },
  };
});
vi.mock('../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: vi.fn() }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/components/common/PageSkeleton', () => ({
  default: () => <div>Loading credit</div>,
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/lib/export', () => ({ exportToCSV: mocks.export }));
vi.mock('../src/services/AgentService', () => ({ AgentService: { setCreditLimit: mocks.save } }));
vi.mock('../src/components/agent/CreditRequestWidget', () => ({
  CreditRequestManagerInbox: ({ clubId }: { clubId: string }) => (
    <div data-testid="manager-credit-inbox">{clubId}</div>
  ),
}));
vi.mock('../src/core/MasterBus', () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    masterBus: {
      subscribeDebounced: vi.fn(() => vi.fn()),
      getOrCreateChannel: vi.fn(() => channel),
      removeRegisteredChannel: vi.fn(),
      emit: vi.fn(),
    },
  };
});
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const query = {
        table,
        userId: mocks.userId,
        filters: new Map<string, unknown>(),
        limit: undefined as number | undefined,
        columns: undefined as string | undefined,
      };
      mocks.queries.push(query);
      const builder: Record<string, any> = {};
      builder.select = (columns: string) => {
        query.columns = columns;
        return builder;
      };
      builder.eq = (key: string, value: unknown) => {
        query.filters.set(key, value);
        return builder;
      };
      builder.in = builder.eq;
      builder.order = () => builder;
      builder.limit = (limit: number) => {
        query.limit = limit;
        return builder;
      };
      builder.then = (resolve: (result: Reply) => unknown, reject: (error: unknown) => unknown) => {
        const key = `${query.userId}:${query.filters.get('club_id') || 'club-a'}`;
        let result: Promise<Reply>;
        if (table === 'agents') {
          result =
            mocks.agentGates.get(key) ||
            Promise.resolve({
              data: (mocks.rows.get(key) || []).slice(0, query.limit),
              error: null,
            });
        } else if (table === 'profiles') {
          result =
            mocks.profileGates.shift() ||
            Promise.resolve({
              data: ((query.filters.get('id') as string[]) || []).map((id) => ({
                id,
                username: `Name ${id}`,
              })),
              error: null,
            });
        } else if (table === 'credit_assignments') {
          const ids = query.filters.get('agent_id') as string[];
          result =
            mocks.auditGates.get(`${query.userId}:${ids[0]}`) ||
            Promise.resolve({
              data: mocks.auditRows
                .filter((row) => ids.includes(row.agent_id as string))
                .slice(0, query.limit),
              error: null,
            });
        } else {
          result = Promise.resolve({ data: [], error: null });
        }
        return result.then(resolve, reject);
      };
      return builder;
    }),
  },
}));

import CreditAdminPanel from '../src/pages/CreditAdminPanel';

function row(id = 'agent-a', club = 'club-a', overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: `person-${id}`,
    club_id: club,
    status: 'active',
    credit_limit: '100.00',
    credit_used: '25.31',
    agent_wallet_balance: '500.00',
    ...overrides,
  };
}
function OtherClub() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/credit-admin?club=club-b')}>Open other club</button>;
}
function View({ revision = 0 }: { revision?: number }) {
  void revision;
  return (
    <MemoryRouter initialEntries={['/credit-admin?club=club-a']}>
      <OtherClub />
      <CreditAdminPanel />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'operator-a';
  mocks.scopeUserId = undefined;
  mocks.clubRole = 'owner';
  mocks.platformWide = false;
  mocks.rows = new Map([['operator-a:club-a', [row()]]]);
  mocks.agentGates = new Map();
  mocks.auditGates = new Map();
  mocks.auditRows = [];
  mocks.profileGates = [];
  mocks.queries = [];
  mocks.save.mockResolvedValue(true);
});
afterEach(cleanup);

describe('Credit admin scoped view', () => {
  it('mounts the selected club review inbox even with no agent rows and follows club changes', async () => {
    mocks.rows.set('operator-a:club-a', []);
    render(<View />);
    await waitFor(() => expect(screen.getByText('No Agents Found')).toBeInTheDocument());
    expect(screen.getByTestId('manager-credit-inbox')).toHaveTextContent('club-a');
    fireEvent.click(screen.getByRole('button', { name: 'Open other club' }));
    await waitFor(() =>
      expect(screen.getByTestId('manager-credit-inbox')).toHaveTextContent('club-b')
    );
  });

  it('does not mount a manager review inbox for an unselected platform-wide scope', async () => {
    mocks.platformWide = true;
    render(<View />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled()
    );
    expect(screen.queryByTestId('manager-credit-inbox')).not.toBeInTheDocument();
  });

  it('exports recorded debt and labels its bounded shown-row scope', async () => {
    mocks.rows.set(
      'operator-a:club-a',
      Array.from({ length: 101 }, (_, i) => row(`agent-${i}`))
    );
    render(<View />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export Shown Rows' }));
    const [rows, filename] = mocks.export.mock.calls[0];
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({
      clubId: 'club-a',
      debtOwed: '25.31',
      currentBalance: '500.00',
    });
    expect(filename).toBe('credit_admin_shown_rows.csv');
    expect(screen.getByText(/Totals And CSV Cover The Shown Rows Only/)).toBeInTheDocument();
    expect(screen.queryByText('Total Exposure')).not.toBeInTheDocument();
    expect(mocks.queries.find((q) => q.table === 'agents')).toMatchObject({
      limit: 100,
      columns:
        'id, user_id, club_id, agent_wallet_balance::text, credit_limit::text, credit_used::text, status',
    });
  });

  it('keeps missing debt unavailable and disables edits without substituting a derived debt', async () => {
    mocks.rows.set('operator-a:club-a', [row('agent-a', 'club-a', { credit_used: null })]);
    render(<View />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Export Shown Rows' }));
    expect(mocks.export.mock.calls[0][0][0].debtOwed).toBe('Unavailable');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('shows a failed data read as an error, not an empty or zero-debt view', async () => {
    mocks.agentGates.set(
      'operator-a:club-a',
      Promise.resolve({ data: null, error: { code: '42501', message: 'Access refused' } })
    );
    render(<View />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText('No Agents Found')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export Shown Rows' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(2);
  });

  it('drops a previous account response even when the club stays the same', async () => {
    const gate = deferred<Reply>();
    mocks.agentGates.set('operator-a:club-a', gate.promise);
    mocks.rows.set('operator-b:club-a', [row('agent-b')]);
    const view = render(<View />);
    await waitFor(() => expect(mocks.queries.some((q) => q.table === 'agents')).toBe(true));
    mocks.userId = 'operator-b';
    view.rerender(<View revision={1} />);
    await waitFor(() => expect(screen.getByText('Name person-agent-b')).toBeInTheDocument());
    await act(async () => {
      gate.resolve({ data: [row()], error: null });
      await gate.promise;
    });
    expect(screen.queryByText('Name person-agent-a')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export Shown Rows' }));
    expect(mocks.export.mock.calls[0][0].map((r: { id: string }) => r.id)).toEqual(['agent-b']);
  });

  it('drops slow profile enrichment after the route changes clubs', async () => {
    const gate = deferred<Reply>();
    mocks.profileGates.push(gate.promise);
    mocks.rows.set('operator-a:club-b', [row('agent-b', 'club-b')]);
    render(<View />);
    await waitFor(() => expect(mocks.queries.some((q) => q.table === 'profiles')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Open other club' }));
    await waitFor(() => expect(screen.getByText('Name person-agent-b')).toBeInTheDocument());
    await act(async () => {
      gate.resolve({ data: [{ id: 'person-agent-a', username: 'Wrong old club' }], error: null });
      await gate.promise;
    });
    expect(screen.queryByText('Wrong old club')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export Shown Rows' }));
    expect(mocks.export.mock.calls[0][0][0].clubId).toBe('club-b');
  });

  it('does not read under a ready scope belonging to the previous account', async () => {
    mocks.scopeUserId = 'previous-operator';
    render(<View />);
    await act(async () => {});
    expect(mocks.queries.filter((q) => q.table === 'agents')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Export Shown Rows' })).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('drops an old audit failure after switching accounts', async () => {
    const gate = deferred<Reply>();
    mocks.auditGates.set('operator-a:agent-a', gate.promise);
    mocks.rows.set('operator-b:club-a', [row('agent-b')]);
    const view = render(<View />);
    await waitFor(() =>
      expect(mocks.queries.some((q) => q.table === 'credit_assignments')).toBe(true)
    );
    mocks.userId = 'operator-b';
    view.rerender(<View revision={1} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled()
    );
    await act(async () => {
      gate.resolve({ data: null, error: { code: '42501', message: 'Old audit refused' } });
      await gate.promise;
    });
    expect(screen.queryByText('Recent Credit Changes Are Unavailable.')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('reads canonical recent credit changes only for shown agents with exact decimal transport', async () => {
    mocks.auditRows = [
      {
        id: 'change-a',
        agent_id: 'agent-a',
        old_limit: '123.45',
        new_limit: '234.56',
        created_at: '2026-09-15T04:00:00Z',
      },
      {
        id: 'other-club-change',
        agent_id: 'other-club-agent',
        old_limit: '345.67',
        new_limit: '456.78',
        created_at: '2026-09-15T04:01:00Z',
      },
    ];
    render(<View />);
    await waitFor(() =>
      expect(screen.getByText('Recent Credit Changes For Agents In View')).toBeInTheDocument()
    );
    expect(screen.getByText('123.45')).toBeInTheDocument();
    expect(screen.getByText('234.56')).toBeInTheDocument();
    expect(screen.queryByText('456.78')).not.toBeInTheDocument();
    const query = mocks.queries.find((q) => q.table === 'credit_assignments');
    expect(query).toMatchObject({
      limit: 5,
      columns: 'id, agent_id, old_limit::text, new_limit::text, created_at',
    });
    expect(query?.filters.get('agent_id')).toEqual(['agent-a']);
    expect(query?.filters.has('club_id')).toBe(false);
    expect(mocks.queries.some((q) => q.table === 'commission_rate_audit')).toBe(false);
  });

  it('refuses an audit response containing an agent outside the shown scope', async () => {
    mocks.auditGates.set(
      'operator-a:agent-a',
      Promise.resolve({
        data: [
          {
            id: 'wrong-change',
            agent_id: 'other-club-agent',
            old_limit: '345.67',
            new_limit: '456.78',
            created_at: '2026-09-15T04:00:00Z',
          },
        ],
        error: null,
      })
    );
    render(<View />);
    await waitFor(() =>
      expect(screen.getByText('Recent Credit Changes Are Unavailable.')).toBeInTheDocument()
    );
    expect(screen.queryByText('456.78')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled();
  });

  it('keeps a refused canonical audit read unavailable instead of claiming no visible changes', async () => {
    mocks.auditGates.set(
      'operator-a:agent-a',
      Promise.resolve({ data: null, error: { code: '42501', message: 'Audit access refused' } })
    );
    render(<View />);
    await waitFor(() =>
      expect(screen.getByText('Recent Credit Changes Are Unavailable.')).toBeInTheDocument()
    );
    expect(
      screen.queryByText('No Visible Credit Changes For Agents In This View.')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Shown Rows' })).toBeEnabled();
  });

  it('keeps nullable canonical audit limits unavailable and does not query an empty agent scope', async () => {
    mocks.auditRows = [
      {
        id: 'change-a',
        agent_id: 'agent-a',
        old_limit: null,
        new_limit: '234.56',
        created_at: null,
      },
    ];
    const view = render(<View />);
    await waitFor(() => expect(screen.getByText('234.56')).toBeInTheDocument());
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    mocks.userId = 'operator-b';
    mocks.rows.set('operator-b:club-a', []);
    view.rerender(<View revision={1} />);
    await waitFor(() => expect(screen.getByText('No Agents Found')).toBeInTheDocument());
    expect(
      mocks.queries.some((q) => q.table === 'credit_assignments' && q.userId === 'operator-b')
    ).toBe(false);
  });

  it('refuses returned rows from outside the selected club', async () => {
    mocks.rows.set('operator-a:club-a', [row('wrong-club-agent', 'club-b')]);
    render(<View />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export Shown Rows' })).not.toBeInTheDocument();
  });

  it('does not publish stale save success into another account and blocks repeated submits', async () => {
    const gate = deferred<boolean>();
    mocks.save.mockReturnValue(gate.promise);
    mocks.rows.set('operator-b:club-a', [row('agent-b')]);
    const view = render(<View />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '200.25' } });
    const save = screen.getByRole('button', { name: '✓' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith('agent-a', 200.25, 'operator-a', expect.any(String));
    mocks.userId = 'operator-b';
    view.rerender(<View revision={1} />);
    await waitFor(() => expect(screen.getByText('Name person-agent-b')).toBeInTheDocument());
    await act(async () => {
      gate.resolve(true);
      await gate.promise;
    });
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('retires old save UI ownership on a same-component authority change without unlocking a newer save', async () => {
    const oldSave = deferred<boolean>();
    const newSave = deferred<boolean>();
    mocks.save.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
    const view = render(<View />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: '✓' }));

    // Same auth user, URL and component key; only freshly observed authority changes.
    mocks.clubRole = 'co_owner';
    view.rerender(<View revision={1} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: '✓' }));
    expect(mocks.save).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldSave.resolve(true);
      await oldSave.promise;
    });
    expect(screen.getByRole('button', { name: '...' })).toBeDisabled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    await act(async () => {
      newSave.resolve(true);
      await newSave.promise;
    });
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });
});
