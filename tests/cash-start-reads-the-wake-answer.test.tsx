/**
 * START READS THE ENGINE'S ANSWER, AND EVERY RULE CONTROL EXPLAINS ITSELF
 * (Create A Club Phase 2, 2026-09-20).
 *
 * Owner report: after creating a cash table the host sometimes landed on
 * "This Table Is No Longer Running" or an endless "Reconnecting To The Table".
 *
 * One cause was here. `getTableState` never throws - it answers null for a
 * 403, a 404, a 503 and a dropped request - and Start awaited it inside a
 * try/catch that could therefore never fire, toasted "Game Created And
 * Started" and navigated to a felt whose engine had not woken.
 *
 *   A1  null, null, then a state: the host reaches /table/<id> only after the
 *       read that succeeded, and is not told "Started" before it;
 *   A2  null every time: the retry is BOUNDED (four reads), "Started" is never
 *       claimed, and the host leaves by the Save door with an honest sentence;
 *   A3  the whole wake is inside the one create: the double-tap guard still
 *       makes it one game, and TABLE_CREATED is emitted once;
 *   E   every switch and every slider of the rules step has a sibling Help
 *       button (click, tap and keyboard - never a title attribute).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  navigate: vi.fn(),
  emit: vi.fn(),
  getTableState: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    }),
  },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../src/services/GameServerAPI', () => ({ getTableState: mocks.getTableState }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: mocks.emit } }));

import CashGameCreateFlow, {
  GAME_CREATED_STILL_STARTING,
  WAKE_RETRY_DELAYS_MS,
} from '../src/components/cash/CashGameCreateFlow';

const defaults = {
  template: 'classic',
  variant: 'nlh',
  family: 'holdem',
  seats: 9,
  seats_locked: false,
  seat_choices: [9, 6],
  min_buyin_bb: 40,
  max_buyin_bb: 200,
  regular_ante: 'none',
  vpip_floor: 0,
  vpip_window: 10,
  bombs: { enabled: false, trigger: null, ante_bb: null, boards: null },
  straddle: false,
  stay_clock_min: 10,
  rejoin_window_min: 120,
  run_it_n_times: 'opt_in',
  rake: 'existing',
};

beforeEach(() => {
  for (const m of [mocks.rpc, mocks.navigate, mocks.emit, mocks.getTableState]) m.mockReset();
  for (const m of Object.values(mocks.toast)) m.mockReset();
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'fn_cash_template_defaults') return { data: defaults, error: null };
    if (fn === 'fn_cash_game_create') {
      return { data: { ok: true, game_id: 'g1', table_id: 't1', name: 'x' }, error: null };
    }
    return { data: null, error: new Error(`unexpected rpc ${fn}`) };
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const walkToRules = async (onSaved?: () => void) => {
  render(
    <CashGameCreateFlow clubId="club-1" canBuildHere deniedMessage={null} onSaved={onSaved} />
  );
  fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
  fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
  fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-step="handedness"] button[aria-pressed]').length
    ).toBeGreaterThan(0)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: /^Start$/ }) as HTMLButtonElement).disabled).toBe(
      false
    )
  );
};

/** Tap Start under fake timers and let the create RPC (a microtask) land. */
const tapStart = async () => {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: /^Start$/ }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const TOTAL_WAKE_MS = WAKE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

describe('A - Start reads the answer of the wake', () => {
  it('null, null, then a state: reaches the felt only after the read that succeeded', async () => {
    mocks.getTableState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ table_id: 't1', stage: 'idle', players: [] });
    await walkToRules();
    await tapStart();

    // First read said "not awake": nobody is told it started, nobody is moved.
    expect(mocks.getTableState).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();

    await advance(WAKE_RETRY_DELAYS_MS[0]);
    expect(mocks.getTableState).toHaveBeenCalledTimes(2);
    expect(mocks.navigate).not.toHaveBeenCalled();

    await advance(WAKE_RETRY_DELAYS_MS[1]);
    expect(mocks.getTableState).toHaveBeenCalledTimes(3);
    expect(mocks.getTableState).toHaveBeenCalledWith('t1');
    expect(mocks.toast.success).toHaveBeenCalledWith('Game Created And Started');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/table/t1');

    // And it stopped: success ends the retry, it does not keep polling.
    await advance(60_000);
    expect(mocks.getTableState).toHaveBeenCalledTimes(3);
  });

  it('an engine that answers first time is one read and no wait', async () => {
    mocks.getTableState.mockResolvedValue({ table_id: 't1' });
    await walkToRules();
    await tapStart();
    expect(mocks.getTableState).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/table/t1');
  });

  it('null every time: bounded, never claims Started, and leaves by the Save door', async () => {
    mocks.getTableState.mockResolvedValue(null);
    await walkToRules();
    await tapStart();
    await advance(TOTAL_WAKE_MS);

    expect(mocks.getTableState).toHaveBeenCalledTimes(WAKE_RETRY_DELAYS_MS.length + 1);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith(GAME_CREATED_STILL_STARTING);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1');
    expect(mocks.navigate).not.toHaveBeenCalledWith('/table/t1');

    // Bounded means bounded: no background loop survives the request.
    await advance(120_000);
    expect(mocks.getTableState).toHaveBeenCalledTimes(WAKE_RETRY_DELAYS_MS.length + 1);
    // The whole wake is about four seconds, never an open-ended wait.
    expect(TOTAL_WAKE_MS).toBeGreaterThanOrEqual(3_000);
    expect(TOTAL_WAKE_MS).toBeLessThanOrEqual(5_000);
  });

  it('an embedded host gets control back instead of a navigation, exactly like Save', async () => {
    mocks.getTableState.mockResolvedValue(null);
    const onSaved = vi.fn();
    await walkToRules(onSaved);
    await tapStart();
    await advance(TOTAL_WAKE_MS);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('the sentence is Title Case and carries no em dash', () => {
    expect(GAME_CREATED_STILL_STARTING).not.toMatch(/[–—]/);
    for (const word of GAME_CREATED_STILL_STARTING.split(/\s+/)) {
      expect(word[0], word).toBe(word[0].toUpperCase());
    }
  });

  it('taps during the wake create nothing more, and TABLE_CREATED is emitted once', async () => {
    mocks.getTableState.mockResolvedValue(null);
    await walkToRules();
    await tapStart();
    // Mid-wake: both buttons are disabled by `busy`, and the ref guards the rest.
    fireEvent.click(screen.getByRole('button', { name: /Starting/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await advance(TOTAL_WAKE_MS);
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'fn_cash_game_create')).toHaveLength(1);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('TABLE_CREATED', { tableId: 't1', clubId: 'club-1' });
    // The request is over: the buttons re-arm.
    expect((screen.getByRole('button', { name: /^Start$/ }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});

describe('E - every switch and every slider of the rules step has help', () => {
  it('each role="switch" has a sibling Help button named for it', async () => {
    await walkToRules();
    const switches = [...document.querySelectorAll('[data-step="overrides"] [role="switch"]')];
    expect(switches.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Private Game',
      'VIP Only',
      'Anonymous Seats',
      'Ban Chat',
      'Insurance',
      'Seven Deuce Bonus',
    ]);
    for (const sw of switches) {
      const label = sw.getAttribute('aria-label');
      const help = sw.closest('.config-toggle')?.querySelector('button[aria-label^="Help: "]');
      expect(help, `${label} has no Help button`).toBeTruthy();
      expect(help!.getAttribute('aria-label')).toBe(`Help: ${label}`);
      expect(help!.hasAttribute('title')).toBe(false);
    }
  });

  it('each slider has a sibling Help button named for it', async () => {
    await walkToRules();
    const sliders = [...document.querySelectorAll('[data-step="overrides"] input[type="range"]')];
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Minimum Buy In',
      'Maximum Buy In',
      'Stay Clock',
      'Rejoin Window',
      'Action Time',
    ]);
    for (const slider of sliders) {
      const label = slider.getAttribute('aria-label');
      const help = slider.closest('.config-slider')?.querySelector('button[aria-label^="Help: "]');
      expect(help, `${label} has no Help button`).toBeTruthy();
      expect(help!.getAttribute('aria-label')).toBe(`Help: ${label}`);
    }
  });

  it('the help opens on click and is written in Title Case without em dashes', async () => {
    await walkToRules();
    const helps = [
      ...document.querySelectorAll('[data-step="overrides"] button[aria-label^="Help: "]'),
    ] as HTMLButtonElement[];
    expect(helps.length).toBe(11);
    for (const help of helps) {
      fireEvent.click(help);
      const text = screen.getByRole('tooltip').textContent ?? '';
      expect(text.length, help.getAttribute('aria-label') ?? '').toBeGreaterThan(10);
      expect(text).not.toMatch(/[–—]/);
      for (const word of text.trim().split(/\s+/)) {
        if (/^[a-z]/.test(word)) throw new Error(`"${word}" is not Title Case in: ${text}`);
      }
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
    }
  });
});
