import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  route: { clubId: 'alpha-club' },
  actor: { id: 'operator-a' },
  access: {
    loading: false,
    error: null as string | null,
    isClubStaff: true,
    canControlClub: true,
  },
  resolveClub: vi.fn(),
  rpc: vi.fn(),
  queue: vi.fn(),
  openHand: vi.fn(),
  resolveFlag: vi.fn(),
  reportError: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: testState.route.clubId }),
}));

vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: testState.actor.id }, isHydrating: false }),
}));

vi.mock('../../src/hooks/useClubNavigationAccess', () => ({
  useClubNavigationAccess: () => ({
    ...testState.access,
    clubRole: 'owner',
    isPlatformStaff: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => testState.toast,
}));

vi.mock('../../src/components/club/ClubIntegrityHeader', () => ({
  default: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock('../../src/components/console/SpadeConsole', () => ({
  SpadeConsole: ({
    title,
    titleId,
    children,
    onClose,
    plates,
    role,
    ...props
  }: {
    title: string;
    titleId?: string;
    children?: ReactNode;
    onClose?: () => void;
    plates?: {
      primary?: { label: string; disabled?: boolean; onClick?: () => void };
      secondary?: { label: string; disabled?: boolean; onClick?: () => void };
    };
    role?: string;
    [key: string]: unknown;
  }) => (
    <section
      role={role}
      aria-modal={props['aria-modal'] as boolean | undefined}
      aria-labelledby={props['aria-labelledby'] as string | undefined}
    >
      <h2 id={titleId}>{title}</h2>
      {onClose && (
        <button type="button" data-testid="sc-close" onClick={onClose}>
          Close Console
        </button>
      )}
      {children}
      {plates?.secondary && (
        <button
          type="button"
          disabled={plates.secondary.disabled}
          onClick={plates.secondary.onClick}
        >
          {plates.secondary.label}
        </button>
      )}
      {plates?.primary && (
        <button type="button" disabled={plates.primary.disabled} onClick={plates.primary.onClick}>
          {plates.primary.label}
        </button>
      )}
    </section>
  ),
}));

vi.mock('../../src/components/handdetail/HandDetailView', () => ({
  default: () => <div>Replay Ready</div>,
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => testState.rpc(...args) },
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUIDStrict: (...args: unknown[]) => testState.resolveClub(...args),
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...args: unknown[]) => testState.reportError(...args),
}));

vi.mock('../../src/utils/handReplay', () => ({
  replayInputFromRow: () => ({}),
  buildReplay: () => ({}),
}));

vi.mock('../../src/services/HandFlagService', () => ({
  GODMODE_REASON_MIN: 8,
  FLAG_STATUS_LABEL: {
    open: 'Open',
    under_review: 'Under Review',
    resolved: 'Resolved',
    dismissed: 'Closed, No Change',
  },
  handFlagService: {
    clubQueue: (...args: unknown[]) => testState.queue(...args),
    openHand: (...args: unknown[]) => testState.openHand(...args),
    resolve: (...args: unknown[]) => testState.resolveFlag(...args),
  },
}));

import ClubHandReviewPage from '../../src/pages/ClubHandReviewPage';
import ReportReviewPage from '../../src/pages/ReportReviewPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function report(id: string, reason: string) {
  return {
    id,
    reporter_id: `${id}-reporter`,
    reported_user_id: `${id}-reported`,
    reason,
    details: `${reason} details`,
    status: 'pending' as const,
    created_at: '2026-10-03T12:00:00Z',
    reporter_username: `${id} reporter`,
    reported_username: `${id} reported`,
  };
}

function flag(id: string, clubId: string, note: string) {
  return {
    id,
    handId: `${id}-hand`,
    clubId,
    handNumber: id === 'alpha' ? 101 : 202,
    tableId: `${id}-table`,
    tableName: `${id} table`,
    flaggedBy: `${id}-player`,
    note,
    status: 'open' as const,
    operatorNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-10-03T12:00:00Z',
    updatedAt: '2026-10-03T12:00:00Z',
  };
}

beforeEach(() => {
  testState.route.clubId = 'alpha-club';
  testState.actor.id = 'operator-a';
  testState.access.loading = false;
  testState.access.error = null;
  testState.access.isClubStaff = true;
  testState.access.canControlClub = true;
  testState.resolveClub
    .mockReset()
    .mockImplementation(async (slug: string) =>
      slug === 'alpha-club' ? 'club-alpha' : 'club-beta'
    );
  testState.rpc.mockReset();
  testState.queue.mockReset().mockResolvedValue({ ok: true, flags: [] });
  testState.openHand.mockReset();
  testState.resolveFlag.mockReset().mockResolvedValue({ ok: true, flag: null });
  testState.reportError.mockReset();
  for (const fn of Object.values(testState.toast)) fn.mockReset();
});

describe('Player Report Review scope identity', () => {
  it('ignores a delayed report list from the previous club', async () => {
    const alpha = deferred<{ data: ReturnType<typeof report>[]; error: null }>();
    const beta = deferred<{ data: ReturnType<typeof report>[]; error: null }>();
    testState.rpc.mockImplementation((name: string, args: { p_club_id?: string }) => {
      if (name !== 'fn_list_player_reports') return Promise.resolve({ data: null, error: null });
      return args.p_club_id === 'club-alpha' ? alpha.promise : beta.promise;
    });

    const view = render(<ReportReviewPage />);
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith('fn_list_player_reports', expect.anything())
    );

    testState.route.clubId = 'beta-club';
    view.rerender(<ReportReviewPage />);
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith(
        'fn_list_player_reports',
        expect.objectContaining({ p_club_id: 'club-beta' })
      )
    );
    await act(async () => beta.resolve({ data: [report('beta', 'beta conduct')], error: null }));
    expect(await screen.findByText('Beta Conduct')).toBeVisible();

    await act(async () => alpha.resolve({ data: [report('alpha', 'alpha conduct')], error: null }));
    expect(screen.queryByText('Alpha Conduct')).toBeNull();
    expect(screen.getByText('Beta Conduct')).toBeVisible();
  });

  it('closes the selected case immediately when the club changes', async () => {
    testState.rpc.mockImplementation((name: string, args: { p_club_id?: string }) => {
      if (name !== 'fn_list_player_reports') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({
        data: args.p_club_id === 'club-alpha' ? [report('alpha', 'alpha conduct')] : [],
        error: null,
      });
    });
    const view = render(<ReportReviewPage />);
    fireEvent.click(await screen.findByText('Inspect Case'));
    expect(screen.getByRole('dialog')).toBeVisible();

    testState.route.clubId = 'beta-club';
    view.rerender(<ReportReviewPage />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Alpha Conduct')).toBeNull();
  });

  it('does not roll a failed old-club decision back into the new club', async () => {
    const action = deferred<{ data: null; error: { message: string } }>();
    testState.rpc.mockImplementation((name: string, args: { p_club_id?: string }) => {
      if (name === 'fn_action_player_report') return action.promise;
      if (name === 'fn_list_player_reports') {
        return Promise.resolve({
          data:
            args.p_club_id === 'club-alpha'
              ? [report('alpha', 'alpha conduct')]
              : [report('beta', 'beta conduct')],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const view = render(<ReportReviewPage />);
    fireEvent.click(await screen.findByText('Inspect Case'));
    fireEvent.click(screen.getByRole('button', { name: 'Take Action' }));
    await waitFor(() =>
      expect(testState.rpc).toHaveBeenCalledWith('fn_action_player_report', expect.anything())
    );

    testState.route.clubId = 'beta-club';
    view.rerender(<ReportReviewPage />);
    expect(await screen.findByText('Beta Conduct')).toBeVisible();
    await act(async () => action.resolve({ data: null, error: { message: 'old refusal' } }));

    expect(screen.queryByText('Alpha Conduct')).toBeNull();
    expect(screen.getByText('Beta Conduct')).toBeVisible();
    expect(testState.toast.error).not.toHaveBeenCalledWith('old refusal');
  });
});

describe('Club Hand Review scope identity', () => {
  it('never paints a delayed queue from the previous club', async () => {
    const alpha = deferred<{ ok: true; flags: ReturnType<typeof flag>[] }>();
    const beta = deferred<{ ok: true; flags: ReturnType<typeof flag>[] }>();
    testState.queue.mockImplementation((clubId: string) =>
      clubId === 'club-alpha' ? alpha.promise : beta.promise
    );
    const view = render(<ClubHandReviewPage />);
    await waitFor(() => expect(testState.queue).toHaveBeenCalledWith('club-alpha', 'open'));

    testState.route.clubId = 'beta-club';
    view.rerender(<ClubHandReviewPage />);
    await waitFor(() => expect(testState.queue).toHaveBeenCalledWith('club-beta', 'open'));
    await act(async () =>
      beta.resolve({ ok: true, flags: [flag('beta', 'club-beta', 'beta flag')] })
    );
    expect(await screen.findByText('Beta Flag')).toBeVisible();

    await act(async () =>
      alpha.resolve({ ok: true, flags: [flag('alpha', 'club-alpha', 'alpha flag')] })
    );
    expect(screen.queryByText('Alpha Flag')).toBeNull();
    expect(screen.getByText('Beta Flag')).toBeVisible();
  });

  it('retires an all-hole-card read when the route changes before it answers', async () => {
    const opened = deferred<{
      ok: true;
      read: {
        row: { hand_number: number };
        allHoleCards: Record<string, unknown>;
        seatsDealt: number;
        seatsWithCards: number;
        cardsComplete: boolean;
      };
    }>();
    testState.queue.mockResolvedValue({ ok: true, flags: [] });
    testState.openHand.mockReturnValue(opened.promise);
    const view = render(<ClubHandReviewPage />);

    const handInput = await screen.findByLabelText('Hand Number');
    fireEvent.change(handInput, { target: { value: '101' } });
    fireEvent.change(screen.getByLabelText('Why This Hand Is Being Opened'), {
      target: { value: 'Review flagged sequence' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Hand' }));
    await waitFor(() =>
      expect(testState.openHand).toHaveBeenCalledWith('club-alpha', 101, 'Review flagged sequence')
    );

    testState.route.clubId = 'beta-club';
    view.rerender(<ClubHandReviewPage />);
    await waitFor(() => expect(testState.queue).toHaveBeenCalledWith('club-beta', 'open'));
    await act(async () =>
      opened.resolve({
        ok: true,
        read: {
          row: { hand_number: 101 },
          allHoleCards: { player: ['As', 'Ah'] },
          seatsDealt: 2,
          seatsWithCards: 2,
          cardsComplete: true,
        },
      })
    );

    expect(screen.queryByText('Replay Ready')).toBeNull();
    expect(testState.toast.info).not.toHaveBeenCalled();
  });
});
