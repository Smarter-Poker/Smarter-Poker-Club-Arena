/**
 * AN ERROR THE DATABASE ANSWERED IS AN ANSWER (review finding 2, 2026-09-21).
 *
 * A spin RPC error carrying a SQLSTATE means the database ran the spin and
 * rolled it back: nothing was charged. The wheel used to treat it as a lost
 * answer and resend it every eight seconds for as long as the page was open,
 * with the exit guard holding the player on it. And a receipt this browser
 * cannot verify (money may have moved) was resent for ever the same way.
 *
 * The spin door here is the real DiamondWheelService against a mocked
 * PostgREST rpc, so the classification the page acts on is the one that ships.
 */
vi.mock('../../src/hooks/useLiveBonusGuard', () => ({
  useLiveBonusGuard: vi.fn(() => () => {}),
}));
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import receipts from '../fixtures/diamond-wheel-v2-receipts.json';
import { readWheelPending } from '../../src/utils/wheelPendingSpin';
import { useLiveBonusGuard } from '../../src/hooks/useLiveBonusGuard';
import { supabase } from '../../src/lib/supabase';
const backend = vi.hoisted(() => ({
  state: vi.fn(),
  commit: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('../../src/services/DiamondWheelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/DiamondWheelService')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      // The spin doors stay real; only the reads around them are stubbed.
      getStateV2: backend.state,
      commit: backend.commit,
      welcomeState: async () => ({ available: false, enabled: false }),
      dailyBonusState: async () => ({ available: false, ticket_count: 0 }),
      history: async () => [],
    },
  };
});
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: { id: 'player' } }) }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => backend.toast }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ clubId: 'club' }),
  useNavigate: () => backend.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async () => 'd1000000-0000-4000-8000-000000000003',
}));
vi.mock('../../src/hooks/useGameFloor', () => ({
  useGameFloor: () => ({ floor: null, refresh: backend.refresh }),
}));
vi.mock('../../src/components/games/FloorFeed', () => ({ default: () => null }));
vi.mock('../../src/components/games/DiamondSpinsTabs', () => ({ default: () => null }));
vi.mock('../../src/components/wheel/DiamondWheel', () => ({
  default: ({ onLanded, spinning }: any) => (
    <button disabled={!spinning} onClick={onLanded}>
      Land Wheel
    </button>
  ),
}));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playWin: vi.fn(), playBigWin: vi.fn() },
}));
vi.mock('../../src/services/HapticService', () => ({ triggerHaptic: vi.fn() }));
import DiamondWheelPage from '../../src/pages/DiamondWheelPage';

const CLUB = 'd1000000-0000-4000-8000-000000000003';
const sample = receipts.find((r) => r.kind === 'wheel' && r.value.outcome?.kind === 'chips')!.value;
const state = {
  ok: true,
  contract_version: 2,
  available: true,
  frozen: false,
  segments: sample.segments,
  pending_awards: [],
  config: { spin_price_diamonds: 100, max_spins_per_player_per_day: 200 },
  player: {
    diamonds: 10000,
    spendable: 10000,
    is_member: true,
    spins_today: 0,
    seconds_until_next: 0,
  },
};
let ticket = 0;
const nextTicket = () => ({
  ok: true,
  commit_id: `d1000000-0000-4000-8000-${String(++ticket).padStart(12, '0')}`,
  server_seed_hash: 'a'.repeat(64),
});
type SpinArgs = { p_commit_id: string; p_client_seed: string; p_entry_diamonds: number };
/** The server's receipt for exactly this request. */
const receiptFor = (args: SpinArgs) => ({
  ...sample,
  entry_value_diamonds: args.p_entry_diamonds,
  player_cost_diamonds: args.p_entry_diamonds,
  fairness: {
    ...sample.fairness,
    commit_id: args.p_commit_id,
    server_seed_hash: 'a'.repeat(64),
    client_seed: args.p_client_seed,
  },
});
const failure = (code: string) => ({
  data: null,
  error: { code, message: 'The database said no', details: '', hint: '' },
});
const rpc = vi.mocked(supabase.rpc);
/** What fn_wheel_spin_v2 answers; every other RPC answers nothing. */
const spinAnswers = (answer: (args: SpinArgs) => unknown) =>
  rpc.mockImplementation((async (fn: string, args: SpinArgs) =>
    fn === 'fn_wheel_spin_v2' ? answer(args) : { data: null, error: null }) as never);
const spinCalls = () => rpc.mock.calls.filter(([fn]) => fn === 'fn_wheel_spin_v2');
const held = () => vi.mocked(useLiveBonusGuard).mock.lastCall?.[0];
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const ready = async () => {
  vi.useFakeTimers();
  render(<DiamondWheelPage />);
  await tick(0);
  expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
};
const spin = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Spin 100', exact: true }));
  await tick(0);
};

beforeEach(() => {
  ticket = 0;
  backend.state.mockResolvedValue(state);
  backend.commit.mockImplementation(async () => nextTicket());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  rpc.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

describe('an error the database answered is an answer', () => {
  it.each([
    ['a constraint the spin broke', '23514'],
    ['a refusal the function raised', 'P0001'],
    ['a missing function', '42883'],
    ['PostgREST refusing the request', 'PGRST301'],
  ])(
    '%s (%s): the saved spin is cleared, the next ticket dealt, and nothing is sent again',
    async (_why, code) => {
      spinAnswers(() => failure(code));
      await ready();
      await spin();
      expect(spinCalls()).toHaveLength(1);
      expect(backend.toast.error).toHaveBeenCalledWith('The Wheel Could Not Take That Spin');
      expect(readWheelPending('player', CLUB)).toBeNull();
      // A fresh ticket for the next spin; the refused one is never reused.
      expect(backend.commit).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Spin 100', exact: true })).toBeEnabled();
      expect(screen.queryAllByText(/Recover/)).toHaveLength(0);
      expect(held()).toBe(false);
      await tick(60_000);
      expect(spinCalls()).toHaveLength(1);
    }
  );

  it.each(['40001', '40P01', '55P03', '57014', 'PGRST000', 'PGRST002', 'PGRST003'])(
    'a passing error (%s) sends the same saved request at most three times, then lets it go',
    async (code) => {
      spinAnswers(() => failure(code));
      await ready();
      await spin();
      expect(spinCalls()).toHaveLength(1);
      // Sent again on the same schedule as a lost answer, as the same request.
      expect(readWheelPending('player', CLUB)).not.toBeNull();
      expect(held()).toBe(true);
      await tick(1000);
      expect(spinCalls()).toHaveLength(2);
      await tick(2000);
      expect(spinCalls()).toHaveLength(3);
      expect(spinCalls()[1]).toEqual(spinCalls()[0]);
      expect(spinCalls()[2]).toEqual(spinCalls()[0]);
      // The third such answer is a refusal: cleared, a new ticket, and quiet.
      expect(readWheelPending('player', CLUB)).toBeNull();
      expect(backend.toast.error).toHaveBeenLastCalledWith('The Wheel Could Not Take That Spin');
      expect(backend.commit).toHaveBeenCalledTimes(2);
      expect(held()).toBe(false);
      await tick(60_000);
      expect(spinCalls()).toHaveLength(3);
    }
  );

  it('a passing error, then the receipt: the saved spin plays, on one ticket', async () => {
    let sends = 0;
    spinAnswers((args) =>
      ++sends === 1 ? failure('40001') : { data: receiptFor(args), error: null }
    );
    await ready();
    await spin();
    await tick(1000);
    expect(spinCalls()).toHaveLength(2);
    expect(spinCalls()[1]).toEqual(spinCalls()[0]);
    expect(screen.getByRole('button', { name: 'Land Wheel' })).toBeEnabled();
    expect(backend.commit).toHaveBeenCalledTimes(1);
  });

  it('no code at all says nothing about the spin, so it is kept and sent again', async () => {
    spinAnswers(() => failure(''));
    await ready();
    await spin();
    for (const wait of [1000, 2000, 4000, 8000, 8000]) await tick(wait);
    expect(spinCalls()).toHaveLength(6);
    expect(new Set(spinCalls().map(([, args]) => JSON.stringify(args))).size).toBe(1);
    expect(readWheelPending('player', CLUB)).not.toBeNull();
    expect(held()).toBe(true);
    expect(backend.commit).toHaveBeenCalledTimes(1);
  });
});

describe('a receipt this browser cannot verify', () => {
  it.each([
    [
      'the page cannot match it to the request',
      (args: SpinArgs) => ({
        data: { ...receiptFor(args), entry_value_diamonds: 250 },
        error: null,
      }),
    ],
    [
      'the service cannot read it',
      () => ({ data: { ok: true, contract_version: 2 }, error: null }),
    ],
  ])(
    'when %s: three sends, then the saved spin waits and the player is let go',
    async (_why, answer) => {
      spinAnswers(answer);
      await ready();
      await spin();
      const commitId = (spinCalls()[0][1] as SpinArgs).p_commit_id;
      expect(spinCalls()).toHaveLength(1);
      expect(held()).toBe(true);
      await tick(1000);
      expect(spinCalls()).toHaveLength(2);
      const reads = backend.state.mock.calls.length;
      await tick(2000);
      expect(spinCalls()).toHaveLength(3);
      // Stopped: no fourth send, however long the page stays open.
      await tick(120_000);
      expect(spinCalls()).toHaveLength(3);
      // Money may have moved, so the saved spin is kept for the next visit...
      expect(readWheelPending('player', CLUB)).toMatchObject({ commitId });
      // ...the guard lets go, the wheel is read again, and the status says why.
      expect(held()).toBe(false);
      expect(backend.state.mock.calls.length).toBe(reads + 1);
      expect(
        screen.getByText('Your Last Spin Is Saved For The Next Time The Wheel Opens')
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Spin Saved', exact: true })).toBeDisabled();
      // Nothing was dealt over it: a new wager would take its one saved place.
      expect(backend.commit).toHaveBeenCalledTimes(1);
    }
  );

  it('the next visit sends the saved spin again, and a clean receipt plays it', async () => {
    spinAnswers(() => ({ data: { ok: true, contract_version: 2 }, error: null }));
    await ready();
    await spin();
    await tick(1000);
    await tick(2000);
    expect(spinCalls()).toHaveLength(3);
    const commitId = (spinCalls()[0][1] as SpinArgs).p_commit_id;
    cleanup();
    spinAnswers((args) => ({ data: receiptFor(args), error: null }));
    render(<DiamondWheelPage />);
    await tick(0);
    await tick(0);
    expect(spinCalls()).toHaveLength(4);
    expect(spinCalls()[3][1]).toMatchObject({ p_commit_id: commitId });
    expect(screen.getByRole('button', { name: 'Land Wheel' })).toBeEnabled();
    expect(backend.commit).toHaveBeenCalledTimes(1);
  });
});
