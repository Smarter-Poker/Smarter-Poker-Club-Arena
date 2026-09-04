/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CASH GAME IS CREATED FROM A TEMPLATE, IN SIX LOCKED STEPS, BY THE
 *  DATABASE (Operation Table Stakes, Slice 1 - OPORD 1.3 sections 7-8,
 *  OPORD 1.4 section 2.6 and ruling R1). 2026-09-04.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The browser asks; the database decides. This file pins the client half of
 * acceptance A1.1-A1.6 and the shape of the flow:
 *
 *   A1.1  the flow never inserts a tables row - it calls fn_cash_game_create
 *         and nothing else writes;
 *   A1.4  a Hold'em game offers 9 or 6; an Omaha game offers 6 alone,
 *         locked, and says so (R1);
 *   A1.5  a variant the engine does not deal is offered disabled, never
 *         silently saved as NLHE (ROE 16);
 *   A1.6  the stay clock and rejoin window can only be RAISED from the house
 *         floor - the slider's minimum is the floor the snapshot carries;
 *   order the six steps render in the OPORD's order and each waits on the one
 *         before it.
 *
 * The SQL half (the refusals, the snapshot, the Main 1 row, the session
 * inheriting the clocks) is proved by scripts/dev/probe-cash-games.sql in a
 * rolled-back transaction; the transcript is in
 * docs/changelog/2026-09-04-cash-games-slice-1.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (id: string) => id,
}));
vi.mock('../src/services/GameServerAPI', () => ({ getTableState: vi.fn(async () => ({})) }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn() } }));

import CashGameCreateFlow from '../src/components/cash/CashGameCreateFlow';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FLOW = read('src/components/cash/CashGameCreateFlow.tsx');
const PAGE = read('src/pages/TableConfigPage.tsx');

/** What fn_cash_template_defaults answers, shaped like the SQL. */
const defaults = (template: string, variant: string) => {
  const plo = ['plo4', 'plo5', 'plo6', 'plo8', 'flo8'].includes(variant);
  const holdem = ['nlh', 'flh'].includes(variant);
  return {
    template,
    variant,
    family: plo ? 'plo' : holdem ? 'holdem' : variant === 'short_deck' ? 'shortdeck' : 'pineapple',
    seats: plo ? 6 : holdem && template === 'classic' ? 9 : 6,
    seats_locked: plo,
    seat_choices: plo ? [6] : holdem && template === 'classic' ? [9, 6] : [2, 3, 4, 5, 6, 7, 8],
    min_buyin_bb: template === 'classic' ? 40 : template === 'action' ? 50 : 100,
    max_buyin_bb: 200,
    regular_ante: template === 'classic' ? 'none' : template === 'action' ? 'sb' : 'bb',
    vpip_floor: template === 'classic' ? 0 : 30,
    vpip_window: 40,
    bombs: { enabled: template !== 'classic', trigger: 'timed_15m', ante_bb: 2, boards: 2 },
    straddle: false,
    stay_clock_min: 10,
    rejoin_window_min: 120,
    run_it_n_times: 'opt_in',
    rake: 'existing',
  };
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.navigate.mockReset();
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, string>) => {
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

const mount = (initialVariant: string | null = null) =>
  render(
    <CashGameCreateFlow
      clubId="club-1"
      initialVariant={initialVariant}
      canBuildHere
      deniedMessage={null}
    />
  );

const seatButtons = () =>
  [...document.querySelectorAll('[data-step="handedness"] button[aria-pressed]')].map((b) =>
    Number(b.textContent?.replace(/\D/g, ''))
  );

describe('A1.1 - the browser never writes a tables row', () => {
  it('the flow calls fn_cash_game_create and no table-shaped insert exists in src/', () => {
    expect(FLOW).toContain("supabase.rpc('fn_cash_game_create'");
    expect(FLOW).not.toMatch(/\.from\(\s*'tables'\s*\)/);
    expect(FLOW).not.toMatch(/\.from\(\s*'cash_games'\s*\)/);
    expect(PAGE).not.toContain('buildTableData(');
    expect(PAGE).not.toMatch(/\.from\(\s*'tables'\s*\)[\s\S]{0,160}?\.insert\(/);
  });

  it('the Regular tab renders the flow and nothing of the old cash form', () => {
    expect(PAGE).toMatch(/<CashGameCreateFlow/);
    expect(PAGE).not.toContain('label="Cap"');
    expect(PAGE).not.toContain('label="Auto UTG Straddle"');
    expect(PAGE).not.toContain('label="Rake Percent"');
  });
});

describe('A1.4 - handedness follows the family (R1)', () => {
  it("a Classic Hold'em game offers 9 or 6, 9 first", async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    await waitFor(() => expect(seatButtons()).toEqual([9, 6]));
    expect(screen.queryByText('6-Max Is Locked For Omaha Games')).toBeNull();
  });

  it('an Omaha game offers 6 alone, locked, and says why', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PLO4' }));
    await waitFor(() => expect(seatButtons()).toEqual([6]));
    expect(screen.getByText('6-Max Is Locked For Omaha Games')).toBeTruthy();
    const only = document.querySelector('[data-step="handedness"] button[aria-pressed]');
    expect(only?.getAttribute('aria-pressed')).toBe('true');
  });

  it('the defaults are asked of the database, never computed here', () => {
    expect(FLOW).toContain("supabase.rpc('fn_cash_template_defaults'");
    expect(FLOW).not.toMatch(/seat_choices:\s*\[/);
    expect(FLOW).not.toMatch(/min_buyin_bb:\s*\d/);
  });
});

describe('A1.5 - an undealt variant is offered disabled, never saved as NLHE (ROE 16)', () => {
  it('a route opened for a variant the engine does not deal shows it disabled', () => {
    mount('nlhe');
    const dead = screen.getByRole('button', {
      name: /NLHE - Not Available Yet/,
    }) as HTMLButtonElement;
    expect(dead.disabled).toBe(true);
    // And nothing was pre-selected in its place.
    for (const b of document.querySelectorAll('[data-step="variant"] button[aria-pressed]')) {
      expect(b.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('the refusal copy exists for the database saying the same thing', () => {
    expect(read('src/config/cashGames.ts')).toContain('This Variant Is Not Available Yet');
  });
});

describe('A1.6 - the two clocks can only be raised', () => {
  it('the stay clock and rejoin window sliders bottom out at the snapshot floor', () => {
    const stay = FLOW.slice(
      FLOW.indexOf('label="Stay Clock"'),
      FLOW.indexOf('/>', FLOW.indexOf('label="Stay Clock"'))
    );
    expect(stay).toMatch(/min=\{snapshot\.stay_clock_min\}/);
    const rejoin = FLOW.slice(
      FLOW.indexOf('label="Rejoin Window"'),
      FLOW.indexOf('/>', FLOW.indexOf('label="Rejoin Window"'))
    );
    expect(rejoin).toMatch(/min=\{snapshot\.rejoin_window_min\}/);
  });

  it('and the refusals are worded as a floor, not a range', () => {
    const vocab = read('src/config/cashGames.ts');
    expect(vocab).toContain('The Stay Clock Can Only Be Raised Above 10 Minutes');
    expect(vocab).toContain('The Rejoin Window Can Only Be Raised Above 120 Minutes');
  });
});

describe('the six steps render in the OPORD order and wait on each other', () => {
  it('template, variant, stakes, handedness, rules, confirm', () => {
    const order = [...FLOW.matchAll(/data-step="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['template', 'variant', 'stakes', 'handedness', 'overrides']);
    expect(FLOW).toMatch(/className="config-footer cash-create__footer"/);
  });

  it('nothing after the template is enabled until it is chosen', () => {
    mount();
    for (const b of document.querySelectorAll('[data-step="variant"] button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: /Classic/ }));
    expect((screen.getByRole('button', { name: 'NLH' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Save and Start stay disabled until every step is answered', async () => {
    mount();
    const save = () => screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    await waitFor(() => expect(seatButtons().length).toBeGreaterThan(0));
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
    await waitFor(() => expect(save().disabled).toBe(false));
  });

  it('Save creates through the function with the resolved club, template, variant, stakes and seats', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Madness/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PLO6' }));
    await waitFor(() => expect(seatButtons()).toEqual([6]));
    fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_game_create', expect.anything())
    );
    const [, args] = mocks.rpc.mock.calls.find(([fn]) => fn === 'fn_cash_game_create')!;
    expect(args.p_club_id).toBe('club-1');
    expect(args.p_template).toBe('madness');
    expect(args.p_variant).toBe('plo6');
    expect(args.p_handedness).toBe(6);
    expect(args.p_sb).toBeGreaterThan(0);
    expect(args.p_bb).toBeGreaterThan(args.p_sb);
    expect(args.p_overrides.stay_clock_min).toBe(10);
    expect(args.p_overrides.rejoin_window_min).toBe(120);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1'));
  });
});
