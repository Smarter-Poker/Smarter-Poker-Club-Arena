import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionHistoryPage from '../../src/pages/SessionHistoryPage';

const mocks = vi.hoisted(() => ({
  userId: 'player-a',
  reads: [] as Array<{ userId: string; cutoff?: string; resolve: (result: any) => void }>,
  error: vi.fn(),
}));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId } }),
}));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ error: mocks.error, success: vi.fn() }),
}));
vi.mock('../../src/hooks/useVisibilityRefresh', () => ({ useVisibilityRefresh: () => undefined }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/components/rewards/RewardsSurfaceHeader', () => ({ default: () => null }));
vi.mock('../../src/utils/retryFetch', () => ({
  retryFetch: (read: () => PromiseLike<any>) => read(),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribeDebounced: () => () => undefined,
    getOrCreateChannel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeRegisteredChannel: vi.fn(),
  },
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => {
      const read = {
        userId: '',
        cutoff: undefined as string | undefined,
        resolve: (_result: any) => undefined,
      };
      const response = new Promise((resolve) => {
        read.resolve = resolve;
      });
      mocks.reads.push(read);
      const query = {
        select: () => query,
        eq: (_key: string, value: string) => {
          read.userId = value;
          return query;
        },
        order: () => query,
        limit: () => query,
        gte: (_key: string, cutoff: string) => {
          read.cutoff = cutoff;
          return query;
        },
        then: response.then.bind(response),
      };
      return query;
    },
  },
}));

function row(id: string, userId: string, hands: number) {
  return {
    id,
    user_id: userId,
    table_id: 'table',
    session_start: '2026-10-01T12:00:00Z',
    session_end: '2026-10-01T13:00:00Z',
    hands_played: hands,
    profit_loss: 0,
    trajectory: [],
    big_blind: 2,
  };
}
function page() {
  return (
    <MemoryRouter>
      <SessionHistoryPage />
    </MemoryRouter>
  );
}
async function resolve(index: number, data: unknown[], error: unknown = null) {
  await act(async () => mocks.reads[index].resolve({ data, error }));
}

beforeEach(() => {
  localStorage.clear();
  mocks.userId = 'player-a';
  mocks.reads.length = 0;
  mocks.error.mockReset();
  sessionStorage.clear();
});

describe('Session History request ownership', () => {
  it('loads the new filter without dropping it while the previous read is pending', async () => {
    render(page());
    expect(mocks.reads).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '7 Days' }));
    expect(mocks.reads).toHaveLength(2);
    expect(mocks.reads[1].cutoff! > mocks.reads[0].cutoff!).toBe(true);
    await resolve(1, [row('new', 'player-a', 7)]);
    expect(screen.getByText('7 Hands')).toBeInTheDocument();
    await resolve(0, [row('old', 'player-a', 30)]);
    expect(screen.queryByText('30 Hands')).not.toBeInTheDocument();
    expect(screen.getByText('7 Hands')).toBeInTheDocument();
  });

  it('hides cached previous-account records immediately and rejects its pending completion', async () => {
    sessionStorage.setItem(
      'sh_cache_player-a_30d',
      JSON.stringify([row('cached', 'player-a', 41)])
    );
    const view = render(page());
    expect(screen.getByText('41 Hands')).toBeInTheDocument();
    mocks.userId = 'player-b';
    view.rerender(page());
    expect(screen.queryByText('41 Hands')).not.toBeInTheDocument();
    expect(mocks.reads).toHaveLength(2);
    await resolve(0, [row('old', 'player-a', 99)]);
    expect(screen.queryByText('99 Hands')).not.toBeInTheDocument();
    await resolve(1, [row('current', 'player-b', 12)]);
    expect(screen.getByText('12 Hands')).toBeInTheDocument();
  });

  it('shows a failed read as an error with Retry instead of an empty history', async () => {
    render(page());
    await resolve(0, [], { message: 'Read failed' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could Not Load Session History.');
    expect(screen.queryByText(/No Sessions Found/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.reads).toHaveLength(2);
    await resolve(1, []);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/No Sessions Found/)).toBeInTheDocument();
  });
});
