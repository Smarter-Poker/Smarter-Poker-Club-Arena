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
 *         before it;
 *   I1-I5 (must-move audit lane I, 2026-09-09) the template's promise - ante,
 *         VPIP floor and window, bomb pots - is PRINTED, never offered, and
 *         never sent; a stakes rung the club already holds is greyed with the
 *         reason; two taps create once; a failed create re-arms for exactly one
 *         retry; a host without create rights cannot confirm.
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
  /* The flow reads the club's enabled games so the stakes step can grey a rung
     the club already holds (2026-09-09). A mock with only `rpc` sent that read
     down its error path and printed a TypeError on every run of this file - the
     component survived it, which is why nothing failed, but a test that
     exercises the failure branch is not testing the feature. */
  existingGames: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: mocks.existingGames, error: null }),
        }),
      }),
    }),
  },
}));
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

/**
 * What fn_cash_template_defaults answers, shaped like the LIVE SQL
 * (pg_get_functiondef on kuklfnapbkmacvwxktbh, 2026-09-09, must-move audit
 * lane I). This used to say vpip_window 40, madness 30% and an action/madness
 * Hold'em ladder of 2..8 - none of which the function has returned since the
 * ten-hand window and the 50% madness floor landed. A mock shaped like an old
 * server teaches the flow the wrong defaults and pins nothing.
 */
const defaults = (template: string, variant: string) => {
  const plo = ['plo4', 'plo5', 'plo6', 'plo8', 'flo8'].includes(variant);
  const holdem = ['nlh', 'flh'].includes(variant);
  const classic = template === 'classic';
  return {
    template,
    variant,
    family: plo ? 'plo' : holdem ? 'holdem' : variant === 'short_deck' ? 'shortdeck' : 'pineapple',
    seats: plo ? 6 : holdem && classic ? 9 : 6,
    seats_locked: plo,
    seat_choices: plo
      ? [6]
      : holdem
        ? classic
          ? [9, 6]
          : [2, 3, 4, 5, 6, 7, 8, 9]
        : [2, 3, 4, 5, 6, 7, 8],
    min_buyin_bb: classic ? 40 : template === 'action' ? 50 : 100,
    max_buyin_bb: 200,
    regular_ante: classic ? 'none' : template === 'action' ? 'sb' : 'bb',
    vpip_floor: classic ? 0 : template === 'action' ? 30 : 50,
    vpip_window: 10,
    bombs: classic
      ? { enabled: false, trigger: null, ante_bb: null, boards: null }
      : {
          enabled: true,
          trigger: template === 'action' ? 'timed_15m' : 'every_orbit',
          ante_bb: template === 'action' ? 2 : 3,
          boards: 2,
        },
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
  mocks.toast.error.mockReset();
  mocks.toast.success.mockReset();
  mocks.existingGames = [];
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
    expect(PAGE).not.toContain('buildTableData(');
    expect(PAGE).not.toMatch(/\.from\(\s*'tables'\s*\)[\s\S]{0,160}?\.insert\(/);
  });

  /* THE PIN MOVED WITH ITS MECHANISM (2026-09-09, must-move audit lane C).
     This used to read `expect(FLOW).not.toMatch(/\.from\('cash_games'\)/)`,
     which forbade the flow ANY contact with the table. A1.1's rule is that the
     browser never WRITES - the database resolves the snapshot and opens Main 1
     - and the flow now does one read of `cash_games`, selecting
     `name, template_name, variant, sb, bb, must_move` for the enabled games of
     this club, so the stakes step can grey a rung the club already holds
     instead of letting the host reach Confirm and be refused by
     ONE_GAME_PER_BLIND_CATEGORY or cash_games_one_per_key.

     So the pin is now on the verb rather than the table: reads are allowed,
     every mutating verb is not, on either table, and the only write path out of
     this file is still the one RPC. */
  it('every supabase call in the flow is a read; the only write is the RPC', () => {
    const MUTATORS = ['insert', 'update', 'upsert', 'delete'];
    for (const verb of MUTATORS) {
      expect(FLOW).not.toMatch(
        new RegExp(`\\.from\\(\\s*'(tables|cash_games)'\\s*\\)[\\s\\S]{0,200}?\\.${verb}\\(`)
      );
    }
    // The read that replaced the blanket ban, named so it cannot drift into a write.
    expect(FLOW).toMatch(/\.from\(\s*'cash_games'\s*\)[\s\S]{0,120}?\.select\(/);
    // And the game is still created by the function, never by the browser.
    expect(FLOW.match(/supabase\.rpc\(/g) ?? []).not.toHaveLength(0);
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
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    fireEvent.click(screen.getByRole('button', { name: /Automated Must Move/ }));
    await waitFor(() => expect(seatButtons()).toEqual([9, 6]));
    expect(screen.queryByText('6-Max Is Locked For Omaha Games')).toBeNull();
  });

  it('an Omaha game offers 6 alone, locked, and says why', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PLO4' }));
    fireEvent.click(screen.getByRole('button', { name: /Automated Must Move/ }));
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

describe('the flow shows the card the lobby will paint', () => {
  it('renders a CashGameCard preview once the choices are made', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Madness/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PLO6' }));
    fireEvent.click(screen.getByRole('button', { name: /Automated Must Move/ }));
    await waitFor(() => expect(seatButtons()).toEqual([6]));
    fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
    await waitFor(() => expect(document.querySelector('.cgc')).not.toBeNull());
    const card = document.querySelector('.cgc') as HTMLElement;
    expect(card.className).toContain('cgc--madness');
    expect(card.querySelector('.cgc__mode')?.textContent).toBe('MUST MOVE');
    // Nothing exists yet, so the card says so rather than inventing a count.
    expect(card.querySelector('.cgc__row--players')?.textContent).toBe('0');
    expect((card.querySelector('.cgc__hit--join') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the six steps render in the OPORD order and wait on each other', () => {
  it('template, variant, stakes, handedness, rules, confirm', () => {
    const order = [...FLOW.matchAll(/data-step="([a-z]+)"/g)].map((m) => m[1]);
    // 'preview' is the live card, not a choice: the numbered steps are the
    // ones a host answers, and they are in the OPORD's order.
    expect(order.filter((s) => s !== 'preview')).toEqual([
      'template',
      'variant',
      'mode',
      'stakes',
      'handedness',
      'overrides',
    ]);
    expect(FLOW).toMatch(/className="config-footer cash-create__footer"/);
  });

  it('nothing after the template is enabled until it is chosen', () => {
    mount();
    for (const b of document.querySelectorAll('[data-step="variant"] button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    expect((screen.getByRole('button', { name: 'NLH' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Save and Start stay disabled until every step is answered', async () => {
    mount();
    const save = () => screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    // Stakes wait on the table mode (R9), and the mode waits on the variant.
    for (const b of document.querySelectorAll('[data-step="stakes"] button')) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: /Automated Must Move/ }));
    await waitFor(() => expect(seatButtons().length).toBeGreaterThan(0));
    expect(save().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
    await waitFor(() => expect(save().disabled).toBe(false));
  });

  it('Save creates through the function with the resolved club, template, variant, stakes and seats', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Madness/ }));
    fireEvent.click(screen.getByRole('button', { name: 'PLO6' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
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
    expect(args.p_must_move).toBe(false);
    expect(args.p_overrides.stay_clock_min).toBe(10);
    expect(args.p_overrides.rejoin_window_min).toBe(120);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   MUST-MOVE AUDIT, LANE I (2026-09-09)
   ═══════════════════════════════════════════════════════════════════════════ */

const walkToRules = async (template: RegExp, variant: string, mode: RegExp) => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: template }));
  fireEvent.click(screen.getByRole('button', { name: variant }));
  fireEvent.click(screen.getByRole('button', { name: mode }));
  await waitFor(() => expect(seatButtons().length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
      false
    )
  );
};

const createArgs = () => {
  const call = mocks.rpc.mock.calls.find(([fn]) => fn === 'fn_cash_game_create');
  if (!call) throw new Error('fn_cash_game_create was not called');
  return call[1] as { p_overrides: Record<string, unknown> };
};

describe("I1 - the template's promise is printed, never offered (2026-09-09)", () => {
  it('the rules step has no ante radio, no bomb-pot switch, no bomb trigger, ante or boards control', async () => {
    await walkToRules(/^Action/, 'NLH', /Automated Must Move/);
    const rules = document.querySelector('[data-step="overrides"]') as HTMLElement;
    expect(rules.querySelector('input[name="regular_ante"]')).toBeNull();
    expect(rules.querySelector('input[name="bomb_trigger"]')).toBeNull();
    expect(rules.querySelector('input[name="bomb_boards"]')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Bomb Pots' })).toBeNull();
    expect(screen.queryByLabelText('Bomb Ante')).toBeNull();
    // And the source carries none of the old controls either.
    for (const gone of ['name="regular_ante"', 'label="Bomb Pots"', 'label="Bomb Ante"', 'name="bomb_trigger"']) {
      expect(FLOW).not.toContain(gone);
    }
  });

  it('an Action game prints its promise in Title Case, each line saying the template set it', async () => {
    await walkToRules(/^Action/, 'NLH', /Automated Must Move/);
    const promise = screen.getByTestId('cash-create-promise');
    expect(promise.getAttribute('role')).toBe('group');
    const rows = [...promise.querySelectorAll('[data-rule]')].map((r) => ({
      key: r.getAttribute('data-rule'),
      value: r.querySelector('.cash-create__rule-readout__value')?.textContent,
      note: r.querySelector('.cash-create__rule-readout__note')?.textContent,
    }));
    expect(rows.map((r) => r.key)).toEqual(['ante', 'vpip', 'bombs']);
    expect(rows[0].value).toBe('One Small Blind From Each Dealt In Player');
    expect(rows[1].value).toBe('30% Over 10 Hands');
    expect(rows[2].value).toBe('Double Board, 2 BB Ante, Every 15 Minutes');
    for (const r of rows) expect(r.note).toContain('Set By The Action Template');
    // Nothing in the group is a control.
    expect(promise.querySelectorAll('input, button, select').length).toBe(0);
  });

  it('a Classic game prints No Ante, No VPIP Floor, No Bomb Pots - the blurb, kept', async () => {
    await walkToRules(/^Classic/, 'NLH', /Manual Individual Table/);
    const values = [...screen.getByTestId('cash-create-promise').querySelectorAll('.cash-create__rule-readout__value')].map(
      (v) => v.textContent
    );
    expect(values).toEqual(['No Ante', 'No VPIP Floor', 'No Bomb Pots']);
    // The group title and every note say which template set it.
    expect(screen.getAllByText(/Set By The Classic Template/).length).toBe(4);
  });

  it('p_overrides never carries a template-locked key, and the preview card reads the snapshot', async () => {
    await walkToRules(/^Madness/, 'NLH', /Automated Must Move/);
    // The card the lobby will paint says the template's rules, not a host edit.
    expect(document.querySelector('.cgc')?.textContent).toContain('1 BB ANTE');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('fn_cash_game_create', expect.anything()));
    const { p_overrides } = createArgs();
    for (const locked of ['regular_ante', 'vpip_floor', 'vpip_window', 'bombs']) {
      expect(p_overrides, `${locked} must not be sent`).not.toHaveProperty(locked);
    }
    // What the host DOES edit still travels.
    expect(Object.keys(p_overrides).sort()).toEqual(
      ['max_buyin_bb', 'min_buyin_bb', 'options', 'rejoin_window_min', 'stay_clock_min']
    );
  });
});

describe('I4 - two taps create one game, and a failed create re-arms for exactly one retry', () => {
  it('a double tap on Save reaches fn_cash_game_create once', async () => {
    let release: (v: unknown) => void = () => {};
    mocks.rpc.mockImplementation(async (fn: string, args: Record<string, string>) => {
      if (fn === 'fn_cash_template_defaults') {
        return { data: defaults(args.p_template, args.p_variant), error: null };
      }
      if (fn === 'fn_cash_game_create') {
        return new Promise((resolve) => {
          release = () => resolve({ data: { ok: true, game_id: 'g1', table_id: 't1' }, error: null });
        });
      }
      return { data: null, error: new Error(`unexpected rpc ${fn}`) };
    });
    await walkToRules(/^Classic/, 'NLH', /Manual Individual Table/);
    const save = screen.getByRole('button', { name: /^Save$/ });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole('button', { name: /^Start$/ }));
    await waitFor(() =>
      expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'fn_cash_game_create')).toHaveLength(1)
    );
    release(null);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1'));
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'fn_cash_game_create')).toHaveLength(1);
  });

  it('a network failure mid-create toasts, re-enables Save, and the retry is one more call', async () => {
    let attempts = 0;
    mocks.rpc.mockImplementation(async (fn: string, args: Record<string, string>) => {
      if (fn === 'fn_cash_template_defaults') {
        return { data: defaults(args.p_template, args.p_variant), error: null };
      }
      if (fn === 'fn_cash_game_create') {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return { data: { ok: true, game_id: 'g1', table_id: 't1' }, error: null };
      }
      return { data: null, error: new Error(`unexpected rpc ${fn}`) };
    });
    await walkToRules(/^Classic/, 'NLH', /Manual Individual Table/);
    const save = () => screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    fireEvent.click(save());
    // The server's own sentence, not a fixed string - and not the reporter's
    // "[CashGameCreateFlow.create_failed]" prefix either: reportError used to
    // mutate the caller's error message in place (src/utils/errorReporter.ts,
    // fixed 2026-09-09), so this toast read as a stack trace to a host.
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Failed to fetch'));
    expect(mocks.navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/clubs/club-1'));
    expect(attempts).toBe(2);
  });
});

describe('I5 - a rung the club already holds is greyed with the reason', () => {
  const held = (extra: Array<Record<string, unknown>>) => {
    mocks.existingGames = extra;
  };

  it('Action NLH: every rung in a band the club holds is closed, with the holder as its title', async () => {
    held([
      { name: 'NLH 1/2 Action', template_name: 'action', variant: 'nlh', sb: 1, bb: 2, must_move: true },
    ]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Action/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
    // 0.50/1 and 1/2 are both `low`; 0.25/0.50 is micro and 2/5 is mid.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '0.50/1' }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect((screen.getByRole('button', { name: '1/2' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: '1/2' }).getAttribute('title')).toBe(
      'This Club Already Runs NLH 1/2 Action As Its Action Small Stakes Game'
    );
    expect((screen.getByRole('button', { name: '0.25/0.50' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '2/5' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Action Runs One Game Per Blind Band Per Variant/)).toBeTruthy();
  });

  it('Classic is unrestricted by band; only the exact must-move key is closed, and a manual table never is', async () => {
    held([
      { name: 'NLH 1/2 Classic', template_name: 'classic', variant: 'nlh', sb: 1, bb: 2, must_move: true },
    ]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    fireEvent.click(screen.getByRole('button', { name: /Automated Must Move/ }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '1/2' }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect((screen.getByRole('button', { name: '0.50/1' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '1/2' }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it('a chosen rung that closes when the template changes un-picks itself', async () => {
    held([
      { name: 'NLH 1/2 Action', template_name: 'action', variant: 'nlh', sb: 1, bb: 2, must_move: true },
    ]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
    await waitFor(() => expect(seatButtons().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '1/2' }));
    expect(screen.getByRole('button', { name: '1/2' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Action/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '1/2' }).getAttribute('aria-pressed')).toBe('false')
    );
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a host without create rights cannot confirm, and is told why (NOT_AUTHORIZED)', () => {
  it('Save and Start stay disabled and the denied message prints', async () => {
    render(
      <CashGameCreateFlow
        clubId="club-1"
        initialVariant={null}
        canBuildHere={false}
        deniedMessage="This Club Is Managed By Its Union"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Classic/ }));
    fireEvent.click(screen.getByRole('button', { name: 'NLH' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual Individual Table/ }));
    await waitFor(() => expect(seatButtons().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Use The Usual Stakes' }));
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Start$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This Club Is Managed By Its Union')).toBeTruthy();
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'fn_cash_game_create')).toHaveLength(0);
  });
});
