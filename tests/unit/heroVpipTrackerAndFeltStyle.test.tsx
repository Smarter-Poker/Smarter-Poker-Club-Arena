import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HERO'S VPIP TRACKER, THE ANTE, AND THE STYLE ON THE FELT (Dan 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "IF THE GAME IS CLASSIC, ACTION OR MADNESS, IT MUST SAY IT ON THE TABLE
 * UNDER THE BLINDS." "ANTES OR VPIPS ARE NOT DISPLAYING OR CALCULATING."
 * "VPIP SHOULD BE DISPLAYED AS A REALTIME PERCENTAGE TRACKER TO THE LEFT OF
 * THE HERO (ONLY VISIBLE FOR THE USER)."
 */

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import HeroVpipTracker, {
  VPIP_BACKSTOP_MS,
  VPIP_REFRESH_DELAY_MS,
  vpipStanding,
} from '../../src/components/table/HeroVpipTracker';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('vpipStanding', () => {
  it('has nothing to judge without a floor, a seat, or an answer', () => {
    expect(vpipStanding(null)).toBe('none');
    expect(vpipStanding({ ok: false })).toBe('none');
    expect(vpipStanding({ ok: true, seated: false, required: 60 })).toBe('none');
    expect(vpipStanding({ ok: true, seated: true, required: 0, hands: 30, vpip: 10 })).toBe('none');
  });

  it('is sampling until the window, then safe / edge / under against the floor', () => {
    const base = { ok: true, seated: true, required: 60, window: 10 };
    expect(vpipStanding({ ...base, hands: 9, vpip: 10 })).toBe('sample');
    expect(vpipStanding({ ...base, hands: 10, vpip: null })).toBe('sample');
    expect(vpipStanding({ ...base, hands: 10, vpip: 59.9 })).toBe('under');
    expect(vpipStanding({ ...base, hands: 10, vpip: 60 })).toBe('edge');
    expect(vpipStanding({ ...base, hands: 10, vpip: 64.9 })).toBe('edge');
    expect(vpipStanding({ ...base, hands: 10, vpip: 65 })).toBe('safe');
  });
});

describe('the tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const seated = (over: Record<string, unknown> = {}) => ({
    data: {
      ok: true,
      seated: true,
      nit_game: true,
      required: 30,
      window: 10,
      hands: 7,
      vpip: 42.3,
      ...over,
    },
    error: null,
  });

  it("asks the database for the hero's own figure and prints it with the floor and the count", async () => {
    rpc.mockResolvedValue(seated());
    render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(rpc).toHaveBeenCalledWith('fn_cash_vpip_status', { p_table_id: 't1' });
    const el = screen.getByTestId('hero-vpip');
    expect(el.textContent).toContain('VPIP');
    expect(el.textContent).toContain('42%');
    expect(el.textContent).toContain('Min 30% · 7/10 Hands');
    expect(el.className).toContain('hero-vpip--sample');
    expect(el.style.left).toBe('50%');
    expect(el.style.top).toBe('100%');
  });

  it('refreshes after every hand, once the fact row has had time to land', async () => {
    rpc.mockResolvedValue(seated({ hands: 10, vpip: 25 }));
    const { rerender } = render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    const before = rpc.mock.calls.length;
    rerender(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={6}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    expect(rpc.mock.calls.length).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(VPIP_REFRESH_DELAY_MS + 1);
      await Promise.resolve();
    });
    expect(rpc.mock.calls.length).toBe(before + 1);
    const el = screen.getByTestId('hero-vpip');
    expect(el.className).toContain('hero-vpip--under');
    expect(el.textContent).toContain('Min 30% · 10 Hands');
    // ...and on the backstop, without a hand.
    await act(async () => {
      vi.advanceTimersByTime(VPIP_BACKSTOP_MS + 1);
      await Promise.resolve();
    });
    expect(rpc.mock.calls.length).toBe(before + 2);
  });

  it('renders nothing for a spectator, on a tournament, or for a table without a floor answer', async () => {
    rpc.mockResolvedValue(seated());
    const { rerender } = render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated={false}
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('hero-vpip')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    rerender(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('hero-vpip')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('shows the plain figure on a table with no floor', async () => {
    rpc.mockResolvedValue(seated({ nit_game: false, required: 0, hands: 3, vpip: 66.7 }));
    render(
      <HeroVpipTracker
        tableId="t1"
        heroSeated
        isTournament={false}
        handNumber={5}
        heroPos={{ x: 50, y: 100 }}
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    const el = screen.getByTestId('hero-vpip');
    expect(el.textContent).toContain('67%');
    expect(el.textContent).toContain('3 Hands');
    expect(el.className).toContain('hero-vpip--none');
  });
});

describe('the regular ante reaches the felt', () => {
  const base = {
    table_id: 't',
    hand_number: 1,
    pot: 0,
    community_cards: [],
    current_bet: 0,
    current_player: null,
    dealer_seat: 1,
    stage: 'preflop',
    winners: [],
    min_raise: 0,
    last_raise: 0,
    players: [],
  } as never;

  it('maps ante and ante_mode, and reads 0 / null off an older engine', () => {
    const map = (over: Record<string, unknown>) =>
      mapEngineSnapshot({ ...(base as object), ...over } as never, 'hero', 6);
    const on = map({ ante: 1, ante_mode: 'per_player' });
    expect(on.ante).toBe(1);
    expect(on.anteMode).toBe('per_player');
    const bba = map({ ante: 2, ante_mode: 'big_blind' });
    expect(bba.anteMode).toBe('big_blind');
    const old = map({});
    expect(old.ante).toBe(0);
    expect(old.anteMode).toBeNull();
    const junk = map({ ante: -3, ante_mode: 'weird' });
    expect(junk.ante).toBe(0);
    expect(junk.anteMode).toBeNull();
  });

  it('the masthead prints the ante beside the blinds and the style under them', () => {
    const page = read('src/pages/TablePage.tsx');
    const brand = page.slice(
      page.indexOf('className="table-brand__line table-brand__line--level"'),
      page.indexOf('{/* Dan 2026-08-19 item 15: the pot moved OUT of .table-surface.')
    );
    expect(brand).toMatch(/tableState\.ante > 0 && \(/);
    expect(brand).toMatch(/Ante \{formatChipFigure\(tableState\.ante\)\}/);
    expect(brand).toMatch(/tableState\.gameStyle && \(/);
    expect(brand).toMatch(/className="table-brand__style">\{tableState\.gameStyle\}/);
    // The ante sits on the blinds line; the style is the line after it.
    expect(brand.indexOf('table-brand__ante')).toBeLessThan(
      brand.indexOf('table-brand__line--style')
    );
  });

  it("the table page reads the game's template through the table's cluster_id", () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(/bomb_pot_min_players, bomb_pot_button_policy, cluster_id'/);
    expect(page).toMatch(
      /\.from\('cash_games'\)\s*\.select\('template_name'\)\s*\.eq\('id', table\.cluster_id\)/
    );
    expect(page).toMatch(/CASH_TEMPLATES\.find\(\(t\) => t\.id === template\)\?\.label/);
  });

  it("the tracker is mounted beside the seats, at the hero seat's point, cash only", () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toMatch(
      /<HeroVpipTracker\s+tableId=\{tableId\}\s+heroSeated=\{tableState\.heroSeat > 0\}\s+isTournament=\{tableState\.isTournament\}/
    );
    expect(page).toMatch(/seatPositions\[tableState\.heroSeat - 1\]/);
    const css = read('src/components/table/HeroVpipTracker.css');
    expect(css).toMatch(
      /transform: translate\(calc\(-100% - var\(--sp-hero-half\) - 10px\), -50%\);/
    );
    expect(css).not.toMatch(/:hover/);
  });
});
