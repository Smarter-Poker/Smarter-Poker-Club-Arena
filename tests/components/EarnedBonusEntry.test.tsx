import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useEarnedBonus } from '../../src/hooks/useEarnedBonus';
import BonusSetup from '../../src/components/games/BonusSetup';
import { WheelBonusEntryService } from '../../src/services/WheelBonusEntryService';
import { bonusTotal, type BonusBudget } from '../../src/utils/bonusGameBudget';
import { diamondBonusMinimum, plinkoTableVersion } from '../../src/utils/diamondBonusPayout';
const backend = vi.hoisted(() => ({ rpc: vi.fn(), user: 'alice' }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: backend.rpc } }));
vi.mock('../../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: backend.user } }),
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const club = '00000000-0000-0000-0000-000000000003';
const id = '00000000-0000-0000-0000-000000000004';
const award = {
  id,
  club_id: club,
  game: 'plinko',
  base_diamonds: 200,
  entry_diamonds: 100,
  boost_multiplier: 2,
  status: 'pending',
  cap_cents: 2000,
  bet_diamonds: 200,
  added_diamonds: 0,
  commit_id: null,
  result: null,
};
const RATE = 100;
/**
 * The award is boost 2, so the server quotes the Super guarantee and the Super
 * board (table version 4). Both are derived from the same rule the client
 * mirrors rather than typed as numbers, so the quote cannot drift from it: the
 * minimum is half the FULL funded entry, Double Down included, and the board is
 * the one the stake kind owns. Nobody chooses either.
 */
const quote = (doubled = false) => ({
  ok: true,
  contract_version: 2,
  enabled: true,
  award: { ...award, bet_diamonds: doubled ? 300 : 200, added_diamonds: doubled ? 100 : 0 },
  awards: [{ ...award, bet_diamonds: doubled ? 300 : 200, added_diamonds: doubled ? 100 : 0 }],
  game_state: {
    ok: true,
    game: 'plinko',
    club_id: club,
    available: true,
    frozen: false,
    tables: [],
    bets: [{ bet_diamonds: doubled ? 300 : 200, cap_cents: 2000, playable: true }],
    diamonds_per_chip: RATE,
    guarantee: 'super',
    minimum_payout_chips: diamondBonusMinimum((doubled ? 300 : 200) / RATE, 2),
    mode: null,
    plinko_table: plinkoTableVersion(2),
  },
});
/**
 * The page's saved preference carries the award it was answered for (R9/R6):
 * a Double Your Diamonds answer or a drop value given for one award is never
 * carried into the quote for another.
 */
const preference: BonusBudget = {
  base: 200,
  doubled: false,
  denomination: 20,
  award: { id, entryDiamonds: 100, boostMultiplier: 2 },
};
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  backend.rpc.mockReset();
  backend.user = 'alice';
});
afterEach(cleanup);
describe('server-owned earned game entry', () => {
  it('discovers a pending award after navigation is interrupted and preserves the original-stake addition', async () => {
    backend.rpc.mockImplementation((_name, args) =>
      Promise.resolve({ error: null, data: quote(args.p_double) })
    );
    const view = renderHook(({ budget }) => useEarnedBonus(club, 'plinko', budget), {
      wrapper,
      initialProps: { budget: preference },
    });
    expect(view.result.current.ready).toBe(false);
    await act(async () => {});
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.budget.base).toBe(200);
    expect(view.result.current.budget.award?.id).toBe(id);
    view.rerender({ budget: { ...preference, doubled: true } });
    expect(view.result.current.ready).toBe(false);
    await act(async () => {});
    expect(bonusTotal(view.result.current.budget)).toBe(300);
    expect(view.result.current.budget.denomination).toBe(20);
    expect(backend.rpc).toHaveBeenLastCalledWith('fn_wheel_bonus_state', {
      p_club_id: club,
      p_game: 'plinko',
      p_double: true,
      p_mode: null,
      p_award_id: null,
    });
  });
  it('quotes a new award without the answers saved for an earlier one', async () => {
    backend.rpc.mockImplementation((_name, args) =>
      Promise.resolve({ error: null, data: quote(args.p_double) })
    );
    const stale: BonusBudget = {
      ...preference,
      doubled: true,
      award: { ...preference.award!, id: '00000000-0000-0000-0000-000000000099' },
    };
    const view = renderHook(() => useEarnedBonus(club, 'plinko', stale), { wrapper });
    await act(async () => {});
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.budget.doubled).toBe(false);
    expect(view.result.current.budget.denomination).toBeNull();
    expect(bonusTotal(view.result.current.budget)).toBe(200);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.rpc).toHaveBeenLastCalledWith('fn_wheel_bonus_state', {
      p_club_id: club,
      p_game: 'plinko',
      p_double: false,
      p_mode: null,
      p_award_id: null,
    });
  });
  it('never lets a stale read grant another account its predecessor’s award', async () => {
    const pending = deferred<{ error: null; data: ReturnType<typeof quote> }>();
    backend.rpc.mockReturnValueOnce(pending.promise).mockResolvedValue({
      error: null,
      data: { ok: true, contract_version: 2, enabled: true, award: null, awards: [] },
    });
    const view = renderHook(() => useEarnedBonus(club, 'plinko', preference), { wrapper });
    backend.user = 'bob';
    view.rerender();
    await act(async () => {});
    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      pending.resolve({ error: null, data: quote() });
    });
    expect(view.result.current.award).toBeNull();
    expect(view.result.current.ready).toBe(false);
  });
  it('does not re-enable a consumed award from a stale server response', async () => {
    backend.rpc.mockResolvedValue({ error: null, data: quote() });
    const view = renderHook(() => useEarnedBonus(club, 'plinko', preference), { wrapper });
    await act(async () => {});
    await act(async () => {
      view.result.current.consume(id);
    });
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.award).toBeNull();
  });
  it('preserves legacy entry only when the server explicitly reports the contract inactive', async () => {
    backend.rpc.mockResolvedValue({
      error: null,
      data: { ok: true, contract_version: 2, enabled: false, award: null, awards: [] },
    });
    const direct: BonusBudget = { base: 100, doubled: false, denomination: 20 };
    const view = renderHook(() => useEarnedBonus(club, 'plinko', direct), { wrapper });
    await act(async () => {});
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.budget).toEqual(direct);
    backend.rpc.mockResolvedValue({ error: Error('Offline'), data: null });
    await act(async () => {
      await view.result.current.refresh();
    });
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.error).toMatch(/Could Not Be Checked/);
  });
  it.each([
    { club_id: '00000000-0000-0000-0000-000000000099' },
    { game: 'mines' },
    { base_diamonds: 300 },
    { boost_multiplier: 3 },
    { bet_diamonds: 400 },
    { added_diamonds: 100 },
  ])('rejects a substituted award quote', async (change) => {
    const data = quote();
    data.award = { ...data.award, ...change };
    data.awards = [data.award];
    backend.rpc.mockResolvedValue({ error: null, data });
    await expect(WheelBonusEntryService.state(club, 'plinko', false)).rejects.toThrow();
  });
  it('accepts a valid explicitly requested old award outside the recent inventory', async () => {
    backend.rpc.mockResolvedValue({ error: null, data: { ...quote(), awards: [] } });
    await expect(
      WheelBonusEntryService.state(club, 'plinko', false, undefined, id)
    ).resolves.toMatchObject({ award: { id } });
  });
  it('binds the requested award ID without selecting another pending game', async () => {
    backend.rpc.mockResolvedValue({ error: null, data: quote() });
    await expect(
      WheelBonusEntryService.state(
        club,
        'plinko',
        false,
        undefined,
        '00000000-0000-0000-0000-000000000099'
      )
    ).rejects.toThrow('Does Not Match');
  });
  it('shows the funded upgrade, the original Double Down cost, and Buy More without an editable entry', () => {
    const onChange = vi.fn();
    const budget = {
      base: 200,
      doubled: false,
      denomination: 20,
      award: { id, entryDiamonds: 100, boostMultiplier: 2 as const },
    };
    render(
      <MemoryRouter>
        <BonusSetup
          budget={budget}
          onChange={onChange}
          diamonds={100}
          disabled={false}
          game="plinko"
          clubId={club}
          offerAnswered={false}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('200 Diamonds Funded')).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByText(/You Need/)).toBeNull();
    const offer = screen.getByRole('dialog', { name: 'Double Your Diamonds' });
    expect(offer).toHaveTextContent('Add 100 Diamonds To Your 200 Diamond Bonus.');
    fireEvent.animationEnd(offer.querySelector('[data-motion="keep"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add The Diamonds' }));
    expect(bonusTotal(onChange.mock.calls[0][0])).toBe(300);
    expect(screen.getByRole('button', { name: 'Buy More' })).toBeEnabled();
  });
});
