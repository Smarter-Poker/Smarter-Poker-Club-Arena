/**
 * KILL POTS ARE OFFERED ONLY WHILE THE REGISTRY SAYS SO (rule manifest kill-v1).
 *
 * "The client only offers the control under the same readiness. Nothing is
 * advertised or sold before the engine that enforces it is live." Two surfaces
 * could advertise a kill: the fixed-limit cash creation flow (the Kill Off /
 * Half / Full control and its threshold) and the lobby's Advanced Filters
 * (the LIMIT tab's Kill Pot chip). Both ask fn_platform_capabilities() and
 * draw nothing unless it answered `available: true` for
 * cash.fixed_limit.kill_pots. "Could not ask" draws nothing too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
      }),
    }),
  },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (id: string) => id,
}));
vi.mock('../../src/services/GameServerAPI', () => ({ getTableState: vi.fn(async () => ({})) }));

import CashGameCreateFlow from '../../src/components/cash/CashGameCreateFlow';
import AdvancedFilters from '../../src/components/lobby/AdvancedFilters';
import { resetPlatformCapabilityCache } from '../../src/hooks/usePlatformCapability';

type Readiness = 'planned' | 'tested' | 'deployed' | 'production_verified';

/** What fn_platform_capabilities answers, with the kill row at `readiness`. */
const registry = (readiness: Readiness, available: boolean) => [
  {
    id: 'cash.fixed_limit.kill_pots',
    version: 'kill-v1',
    title: 'Fixed Limit Kill Pots',
    scope: 'cash_table',
    variants: ['flh', 'flo8'],
    compatibility: {},
    readiness,
    available,
  },
];

let capabilityAnswer: { data: unknown; error: unknown } = { data: null, error: null };

const defaults = (template: string, variant: string) => ({
  template,
  variant,
  family: 'holdem',
  seats: template === 'classic' ? 9 : 6,
  seats_locked: false,
  seat_choices: template === 'classic' ? [9, 6] : [2, 3, 4, 5, 6, 7, 8, 9],
  min_buyin_bb: 40,
  max_buyin_bb: 200,
  regular_ante: template === 'classic' ? 'none' : 'sb',
  vpip_floor: template === 'classic' ? 0 : 30,
  vpip_window: 10,
  bombs:
    template === 'classic'
      ? { enabled: false, trigger: null, ante_bb: null, boards: null }
      : { enabled: true, trigger: 'timed_15m', ante_bb: 2, boards: 2 },
  straddle: false,
  stay_clock_min: 10,
  rejoin_window_min: 120,
  run_it_n_times: 'opt_in',
  rake: 'existing',
});

beforeEach(() => {
  resetPlatformCapabilityCache();
  mocks.rpc.mockReset();
  capabilityAnswer = { data: null, error: null };
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, string>) => {
    if (fn === 'fn_platform_capabilities') return capabilityAnswer;
    if (fn === 'fn_cash_template_defaults') {
      return { data: defaults(args.p_template, args.p_variant), error: null };
    }
    if (fn === 'fn_cash_game_create') {
      return { data: { ok: true, game_id: 'g1', table_id: 't1', name: 'x' }, error: null };
    }
    return { data: null, error: new Error(`unexpected rpc ${fn}`) };
  });
});
afterEach(cleanup);

const walkToRules = async (template: RegExp, variant: string) => {
  render(<CashGameCreateFlow clubId="club-1" canBuildHere deniedMessage={null} />);
  fireEvent.click(screen.getByRole('button', { name: template }));
  fireEvent.click(screen.getByRole('button', { name: variant }));
  fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use The Usual Stakes' }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
      false
    )
  );
};

const createOverrides = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() =>
    expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_game_create', expect.anything())
  );
  const call = mocks.rpc.mock.calls.find(([fn]) => fn === 'fn_cash_game_create')!;
  return (call[1] as { p_overrides: Record<string, unknown> }).p_overrides;
};

const capabilityAsked = () =>
  mocks.rpc.mock.calls.filter(([fn]) => fn === 'fn_platform_capabilities').length;

describe('the cash creation flow offers kills only while the capability is live', () => {
  it.each([
    ['planned', false],
    ['tested', false],
  ] as const)(
    'a %s capability draws no control and sends no kill key',
    async (readiness, available) => {
      capabilityAnswer = { data: registry(readiness, available), error: null };
      await walkToRules(/^Classic/, 'FLH');
      await waitFor(() => expect(capabilityAsked()).toBeGreaterThan(0));
      expect(screen.queryByTestId('cash-create-kill')).toBeNull();
      expect(document.body.textContent).not.toMatch(/Kill/);
      const overrides = await createOverrides();
      expect(overrides).not.toHaveProperty('kill_mode');
      expect(overrides).not.toHaveProperty('kill_threshold_bb');
    }
  );

  it('a registry that could not be read is not a yes', async () => {
    capabilityAnswer = { data: null, error: { message: 'boom' } };
    await walkToRules(/^Classic/, 'FLH');
    await waitFor(() => expect(capabilityAsked()).toBeGreaterThan(0));
    expect(screen.queryByTestId('cash-create-kill')).toBeNull();
    expect(await createOverrides()).not.toHaveProperty('kill_mode');
  });

  it('never asks the registry for a game kill-v1 does not cover', async () => {
    capabilityAnswer = { data: registry('deployed', true), error: null };
    await walkToRules(/^Classic/, 'NLH');
    expect(capabilityAsked()).toBe(0);
    expect(screen.queryByTestId('cash-create-kill')).toBeNull();
  });

  it('a live capability offers Off / Half / Full and 8 / 10 / 12 / 15, and sends the choice', async () => {
    capabilityAnswer = { data: registry('deployed', true), error: null };
    await walkToRules(/^Classic/, 'FLH');
    const group = await screen.findByTestId('cash-create-kill');
    expect(group.getAttribute('aria-label')).toBe('Kill Pots');
    for (const label of ['Off', 'Half Kill', 'Full Kill']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // Off by default: no threshold row until a kill is chosen.
    expect(screen.queryByRole('button', { name: '10 BB' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Half Kill' }));
    for (const t of [8, 10, 12, 15]) {
      expect(screen.getByRole('button', { name: `${t} BB` })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '10 BB' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '12 BB' }));
    // The preview card's rule line says it too.
    expect(document.querySelector('.cgc')?.textContent).toMatch(/Half Kill At 12 BB/i);
    const overrides = await createOverrides();
    expect(overrides.kill_mode).toBe('half');
    expect(overrides.kill_threshold_bb).toBe(12);
  });

  it('a template that deals bomb pots cannot kill, and says so instead of offering it', async () => {
    capabilityAnswer = { data: registry('production_verified', true), error: null };
    await walkToRules(/^Action/, 'FLH');
    const group = await screen.findByTestId('cash-create-kill');
    expect(group.textContent).toContain('Kill Pots Cannot Run On A Game With Bomb Pots');
    expect(group.querySelectorAll('button').length).toBe(0);
    expect(await createOverrides()).not.toHaveProperty('kill_mode');
  });
});

describe('the lobby draws the Kill Pot chip only while the capability is live', () => {
  const openLimit = () =>
    render(
      <AdvancedFilters clubId="club-1" initialType="LIMIT" onClose={() => {}} onApply={() => {}} />
    );

  it('is absent while the registry says not available', async () => {
    capabilityAnswer = { data: registry('tested', false), error: null };
    openLimit();
    await waitFor(() => expect(capabilityAsked()).toBeGreaterThan(0));
    // The LIMIT grid still renders its ordinary chips.
    expect(screen.getAllByRole('button', { name: 'Ante' }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Kill Pot' })).toHaveLength(0);
  });

  it('is absent when the registry could not be read', async () => {
    capabilityAnswer = { data: null, error: { message: 'boom' } };
    openLimit();
    await waitFor(() => expect(capabilityAsked()).toBeGreaterThan(0));
    expect(screen.queryAllByRole('button', { name: 'Kill Pot' })).toHaveLength(0);
  });

  it('appears in Required and Exclude once the capability is deployed', async () => {
    capabilityAnswer = { data: registry('deployed', true), error: null };
    openLimit();
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'Kill Pot' })).toHaveLength(2)
    );
  });
});
