/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT TAB SAYS ITS BUY-IN, NEVER ITS BLINDS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-04, verbatim: "THE ACTION BOX SHOULDN'T SAY MTT 200/400 OR MTT
 * 25/50 IT SHOULD BE DISPLAYING THE HOLE CARDS WHEN THEY ARE PRESENT, OR MTT
 * AND BUY IN AMOUNT UNDER IT FOR QUICK REFERENCE."
 *
 * The multi-table pill's sub-line was written for cash tables: the live pot
 * while a hand runs, otherwise `stakes`. A tournament reports its current blind
 * level as `stakes`, so an MTT tab read "MTT 200/400", changed every level, and
 * once the numbers outgrew a ~47px pill was cut mid-figure ("51115/...").
 *
 * What is pinned here:
 *   - a tournament tab with no live hand prints its code over its buy-in total
 *     (the lobby's total: buy-in plus fee), and never blinds or a pot;
 *   - a freeroll prints the lobby's own word for one;
 *   - an unknown buy-in prints the code alone, not a fallback to blinds;
 *   - hole cards, when present, replace all of it;
 *   - the figure cannot outgrow the pill, whatever the buy-in;
 *   - a cash tab is exactly what it was.
 *
 * Registry: docs/laws.d/a-tournament-tab-says-its-buy-in.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TableTabBar, type TabInfo } from '../src/components/table/TableTabBar';
import {
  TOURNAMENT_TAB_LABEL_MAX_GLYPHS,
  tournamentTabBuyInLabel,
  tournamentTabEventName,
  readTournamentTabInfo,
} from '../src/lib/tournamentTabLabel';
import { isTournamentGameCode } from '../src/utils/gameCode';
import { FREE_BUY_LABEL } from '../src/utils/freeBuy';
import { sliceCssRule, sliceStatement } from './helpers/sourceWindow';

const metadata = vi.hoisted(() => ({
  read: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: { getSession: metadata.getSession },
    from: (table: string) => ({
      select: (columns: string) => ({
        in: (key: string, ids: string[]) => metadata.read(table, columns, key, ids),
      }),
    }),
  },
}));

// Labels are rendered by the real TableTabBar. Its closed account menu is a
// separate boundary: mounting it thousands of times hydrates identity and is
// unrelated to the exhaustive event-name/buy-in matrix below.
vi.mock('../src/components/table/TableMenu', () => ({
  default: () => null,
  createDefaultMenuSections: () => [],
}));

// Button-skin lookup also hydrates identity; labels do not depend on a skin.
vi.mock('../src/hooks/useButtonImage', () => ({
  useButtonImage: (iconName: string) => `/test-buttons/${iconName}.webp`,
}));

vi.mock('../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

afterEach(() => {
  cleanup();
  expect(
    metadata.getSession,
    'tab-label fixtures must not hydrate an unrelated account'
  ).not.toHaveBeenCalled();
  metadata.getSession.mockClear();
});

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
  id: 'table-1',
  name: 'NLH 200/400',
  stakes: '200/400',
  isMyTurn: false,
  seated: true,
  ...over,
});

/** Render one tab and hand back its pill. */
const pill = (info: TabInfo): HTMLElement => {
  const { container } = render(
    <TableTabBar tabs={[info]} activeTabId={info.id} onTabSelect={() => {}} onAddTable={() => {}} />
  );
  const el = container.querySelector<HTMLElement>(`[data-tabid="${info.id}"]`);
  if (!el) throw new Error('the tab pill did not render');
  return el;
};
const nameOf = (el: HTMLElement) => el.querySelector('.table-tab-bar__tab-name')?.textContent ?? '';
const subOf = (el: HTMLElement) => el.querySelector('.table-tab-bar__tab-sub')?.textContent ?? null;

describe('a tournament tab with no live hand', () => {
  it('reads the approved Midway scope and renders the exact booked price', async () => {
    metadata.read
      .mockResolvedValueOnce({ data: [{ id: 'table-1', tournament_id: 'event-1' }], error: null })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'event-1',
            name: 'Sunrise Bounty (NLH)',
            club_id: 'member-club',
            union_id: 'fade0000-0000-0000-0000-000000000001',
            buy_in_amount: 5,
            buy_in_fee: 0.5,
          },
        ],
        error: null,
      });
    const info = (await readTournamentTabInfo(['table-1'])).get('table-1')!;
    expect(info.buyIn).toBe(5.5);
    const el = pill(
      tab({
        gameCode: 'MTT',
        isTournament: true,
        tournamentBuyIn: info.buyIn,
        tournamentBuyInLabel: info.buyInLabel,
      })
    );
    expect(subOf(el)).toBe('5.50');
    expect(tournamentTabBuyInLabel(5.5)).toBe('6');
    metadata.read.mockClear();
  });

  it('prints the code over the buy-in total, and neither blinds nor a pot', () => {
    const el = pill(tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 55, pot: 51115 }));
    expect(nameOf(el)).toBe('MTT');
    expect(subOf(el)).toBe('55');
    expect(el.textContent).not.toContain('200/400');
    expect(el.textContent).not.toContain('Pot');
    expect(el.textContent).not.toContain('51');
  });

  it('prints the lobby word for a freeroll', () => {
    const el = pill(tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 0 }));
    expect(nameOf(el)).toBe('MTT');
    expect(subOf(el)).toBe(FREE_BUY_LABEL);
    expect(el.textContent).not.toContain('200/400');
  });

  it('prints the code alone while the buy-in is not known, never the blinds', () => {
    const el = pill(tab({ gameCode: 'MTT', isTournament: true, pot: 900 }));
    expect(nameOf(el)).toBe('MTT');
    expect(subOf(el)).toBeNull();
    expect(el.textContent).toBe('MTT');
  });

  it('is recognised by its code before the table page has reported anything', () => {
    for (const code of ['MTT', 'SNG', 'SPIN']) {
      const el = pill(tab({ id: `t-${code}`, gameCode: code, tournamentBuyIn: 11 }));
      expect(nameOf(el)).toBe(code);
      expect(subOf(el)).toBe('11');
      expect(el.textContent).not.toContain('200/400');
      cleanup();
    }
  });

  it('holds still for a spectator too: buy-in, not blinds', () => {
    const el = pill(
      tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 215, seated: false, pot: 4000 })
    );
    expect(subOf(el)).toBe('215');
    expect(el.textContent).not.toContain('Pot');
  });
});

describe('an MTT tab names its event over its buy-in', () => {
  /* Dan 2026-10-21, verbatim: "FOR MTT'S IT SHOULD SAY THE TOURNAMENT NAME AS
     WELL AS THE BUY IN INSIDE THE ACTION TAB. NOT JUST 35". */
  it('prints the tournament name on top and the buy-in under it', () => {
    const el = pill(
      tab({
        gameCode: 'MTT',
        isTournament: true,
        tournamentBuyIn: 35,
        tournamentName: 'Midway Nightly Bounty',
      })
    );
    expect(nameOf(el)).toBe('Midway Nightly Bounty');
    expect(subOf(el)).toBe('35');
    expect(el.querySelector('.table-tab-bar__tab-name')?.getAttribute('title')).toBe(
      'Midway Nightly Bounty'
    );
    expect(el.textContent).not.toContain('200/400');
  });

  it('a freeroll names its event over the freeroll word', () => {
    const el = pill(
      tab({
        gameCode: 'MTT',
        isTournament: true,
        tournamentBuyIn: 0,
        tournamentName: 'Daily Freeroll',
      })
    );
    expect(nameOf(el)).toBe('Daily Freeroll');
    expect(subOf(el)).toBe(FREE_BUY_LABEL);
  });

  it('keeps MTT on top while the name is unknown or empty, never a blank line', () => {
    for (const tournamentName of [undefined, '', '   ']) {
      const el = pill(
        tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 35, tournamentName })
      );
      expect(nameOf(el)).toBe('MTT');
      expect(subOf(el)).toBe('35');
      cleanup();
    }
  });

  it('drops the trailing game tag on the pill, keeps the full name on its title', () => {
    const el = pill(
      tab({
        gameCode: 'MTT',
        isTournament: true,
        tournamentBuyIn: 30,
        tournamentName: 'Prime Time Main Event (NLH)',
      })
    );
    expect(nameOf(el)).toBe('Prime Time Main Event');
    expect(subOf(el)).toBe('30');
    expect(el.querySelector('.table-tab-bar__tab-name')?.getAttribute('title')).toBe(
      'Prime Time Main Event (NLH)'
    );
    expect(el.className).toContain('table-tab-bar__tab--event');
  });

  it('keeps a name that is only a parenthetical, and says MTT for none at all', () => {
    expect(tournamentTabEventName('(NLH)')).toBe('(NLH)');
    expect(tournamentTabEventName('Lunch Rush (NLH Deep)')).toBe('Lunch Rush');
    expect(tournamentTabEventName('Mid-Morning Turbo (6-Max NLH)')).toBe('Mid-Morning Turbo');
    expect(tournamentTabEventName('Nightly 10K Satellite 15')).toBe('Nightly 10K Satellite 15');
    expect(tournamentTabEventName(undefined)).toBe('');
    expect(tournamentTabEventName('   ')).toBe('');
  });

  /* Every distinct MTT and satellite name registering or running in production
     on 2026-10-21 (277 events, 75 names, Midway Union and Diamond Arena), each
     at the real entry totals those events charge. Every one must print a name
     and a figure, and never fall back to blinds or a bare code. */
  const LIVE_EVENT_NAMES = [
    'Afternoon Bounty (NLH)',
    'Afternoon Deep Stack (NLH)',
    'Afternoon Free Buy (NLH)',
    'Brunch Special PKO (PLO8)',
    'Coffee Break Freeroll (PLO4)',
    'Daily 25 Chip Freezeout',
    'Dinner Break PLO (PLO4)',
    'Evening Mystery Bounty (PLO5)',
    'Fight Night Opener Satellite 5',
    'Fight Night PKO Satellite 5',
    'Five-Card Bounty',
    'Five-Card Reload',
    'Friday Feature Satellite 10',
    'Friday Feature Satellite 5',
    'Friday Fight Night Opener',
    'Friday Fight Night PKO',
    'Friday Five-Card Bounty',
    'Friday Graveyard',
    'Friday Morning PLO',
    'Friday Night Feature',
    'Friday PLO5 Bounty Satellite 5',
    'Friday Rebuy Rush',
    'Friday Six-Card Nightcap',
    'Grand Championship Satellite 10',
    'Happy Hour Bounty (NLH)',
    'Late Night PKO (PLO4)',
    'Lunch Rush (NLH Deep)',
    'Mid-Morning Turbo (6-Max NLH)',
    'Midday Free Buy (NLH)',
    'Midday Turbo (NLH)',
    'Midnight Bounty (NLH)',
    'Midnight Free Buy (NLH)',
    'Midweek Bounty',
    'Midweek Mystery',
    'Morning Free Buy (NLH)',
    'Morning Grinder (PLO)',
    'Night Owl Special (NLH)',
    'Nightly 10K (NLH)',
    'Nightly 10K Satellite 15',
    'Nightly 10K Satellite 5',
    'Omaha Thursday Graveyard',
    'Omaha Thursday Opener',
    'PLO5 Mystery Bounty Satellite 5',
    'PLO8 Hi-Lo Nightcap',
    'PLO8 Morning Stack',
    'Prime Time Free Buy (NLH)',
    'Prime Time Main Event (NLH)',
    'Prime Time Satellite 10',
    'Prime Time Satellite 3',
    'Saturday Big Stack Satellite 10',
    'Saturday Big Stack Satellite 5',
    'Saturday Five-Card Stack',
    'Saturday Graveyard PLO',
    'Saturday Morning Stack',
    'Saturday Mystery',
    'Saturday Night Big Stack',
    'Saturday Night Mystery Satellite 5',
    'Saturday Stackfest Opener',
    'Six-Card Deep Night',
    'Six-Card Feature',
    'Stackfest Opener Satellite 5',
    'Sunday 200 Deep Stack',
    'Sunday Deep Stack Satellite 10',
    'Sunday Deep Stack Satellite 25',
    'Sunday Deep Stack Satellite 5',
    'Sunrise Bounty (NLH)',
    'Thursday Night PKO',
    'Thursday Six-Card Satellite 5',
    'Union Grand Championship (NLH)',
    'Union Late Night Turbo (NLH)',
    'Union Morning Classic (NLH)',
    'Union Mystery Bounty (PLO5)',
    'Union PKO Afternoon (PLO4)',
    'Wednesday Feature',
    'Wednesday PLO Stack',
  ];
  const LIVE_ENTRY_TOTALS = [
    0, 3, 5, 10, 15, 20, 25, 30, 35, 50, 100, 150, 200, 250, 300, 350, 500, 2000,
  ];

  it('every live scheduled or running event prints its name over its buy-in', () => {
    for (const name of LIVE_EVENT_NAMES) {
      const shown = tournamentTabEventName(name);
      expect(shown, name).not.toBe('');
      expect(shown, name).not.toMatch(/\)$/);
      expect(shown, name).not.toContain('\u2014');
      for (const total of LIVE_ENTRY_TOTALS) {
        const el = pill(
          tab({
            id: `live-${total}`,
            gameCode: 'MTT',
            isTournament: true,
            tournamentBuyIn: total,
            tournamentName: name,
          })
        );
        expect(nameOf(el), name).toBe(shown);
        expect(subOf(el), `${name} @ ${total}`).toBe(tournamentTabBuyInLabel(total));
        expect(el.textContent).not.toContain('200/400');
        cleanup();
      }
    }
  });

  it('an event pill may run wider than a code pill on desktop only', () => {
    const css = read('src/components/table/TableTabBar.css');
    const rule = sliceCssRule(css, '\n  .table-tab-bar__tab.table-tab-bar__tab--event {');
    expect(rule).toMatch(/max-width:\s*210px/);
    expect(css).toMatch(
      /@media \(min-width: 481px\) {\s*\.table-tab-bar__tab\.table-tab-bar__tab--event/
    );
  });

  it('SNG and SPIN keep their code', () => {
    for (const code of ['SNG', 'SPIN']) {
      const el = pill(
        tab({
          id: `n-${code}`,
          gameCode: code,
          isTournament: true,
          tournamentBuyIn: 11,
          tournamentName: 'Some Event',
        })
      );
      expect(nameOf(el)).toBe(code);
      cleanup();
    }
  });

  it('a cash tab ignores a stray name', () => {
    const el = pill(
      tab({ stakes: '1/2', gameCode: 'NLH', isTournament: false, tournamentName: 'X' })
    );
    expect(nameOf(el)).toBe('NLH');
    expect(subOf(el)).toBe('1/2');
  });

  it('the container hands the bar the event name', () => {
    const multi = read('src/pages/MultiTablePage.tsx');
    expect(multi).toMatch(/tournamentName: t\.tournamentName,/);
  });

  it('a long name ellipsises on one line inside the pill', () => {
    const css = read('src/components/table/TableTabBar.css');
    const rule = sliceCssRule(css, '\n.table-tab-bar__tab-label .table-tab-bar__tab-name--event {');
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/max-width:\s*100%/);
  });
});

describe('hole cards win', () => {
  it('a tournament tab holding live cards shows the cards and nothing else', () => {
    const el = pill(
      tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 55, holeCards: 'Ah,Qc' })
    );
    const cards = el.querySelectorAll('.table-tab-bar__mini-card');
    expect(cards.length).toBe(2);
    expect(el.querySelector('.table-tab-bar__tab-name')).toBeNull();
    expect(subOf(el)).toBeNull();
    expect(el.textContent).not.toContain('55');
    expect(el.textContent).not.toContain('200/400');
  });

  it('the cards are reported by the table page whichever tab is in front', () => {
    /* A background felt and a felt behind a lobby "+" tab stay MOUNTED (their
       slot is display:none), so the only way the preview could stop is the
       report itself being gated on focus. It is not: the memo reads the hero's
       seat and the hand, and nothing about which tab is active or visible. */
    const tablePage = read('src/pages/TablePage.tsx');
    const memo = sliceStatement(tablePage, 'const heroTabCards = useMemo(');
    expect(memo).toContain('hero.holeCards');
    expect(memo).not.toMatch(/isActive|isVisible/);
    const report = sliceStatement(tablePage, 'onTableInfoUpdate({');
    expect(report).toMatch(/holeCards: heroTabCards/);
  });
});

describe('the figure cannot outgrow the pill', () => {
  it('formats the buy-in compactly, rounded down, with no decimals under a thousand', () => {
    expect(tournamentTabBuyInLabel(55)).toBe('55');
    expect(tournamentTabBuyInLabel(999)).toBe('999');
    expect(tournamentTabBuyInLabel(1100)).toBe('1.1K');
    expect(tournamentTabBuyInLabel(10000)).toBe('10K');
    expect(tournamentTabBuyInLabel(51115)).toBe('51.1K');
    expect(tournamentTabBuyInLabel(2500000)).toBe('2.5M');
    expect(tournamentTabBuyInLabel(0)).toBe(FREE_BUY_LABEL);
  });

  it('says nothing for a figure it does not have', () => {
    expect(tournamentTabBuyInLabel(undefined)).toBe('');
    expect(tournamentTabBuyInLabel(null)).toBe('');
    expect(tournamentTabBuyInLabel(Number.NaN)).toBe('');
    expect(tournamentTabBuyInLabel(-5)).toBe('');
  });

  it('never exceeds the pill budget for any buy-in, so "51115/..." cannot recur', () => {
    const samples = [0, 1, 9, 55, 999, 1000, 1001, 9999, 51115, 123456, 999999, 1e6, 987654321];
    for (let p = 0; p <= 11; p++) samples.push(10 ** p - 1, 10 ** p, 10 ** p + 1);
    for (const n of samples) {
      const label = tournamentTabBuyInLabel(n);
      expect(label.length, `${n} -> "${label}"`).toBeLessThanOrEqual(
        TOURNAMENT_TAB_LABEL_MAX_GLYPHS
      );
      expect(label).not.toContain('/');
    }
    // The pill renders exactly that string, whole.
    const el = pill(tab({ gameCode: 'MTT', isTournament: true, tournamentBuyIn: 987654321 }));
    expect(subOf(el)).toBe('987.6M');
  });

  it('the sub-line still ellipsises rather than cutting a glyph, as a last guard', () => {
    const css = read('src/components/table/TableTabBar.css');
    const rule = sliceCssRule(css, '\n.table-tab-bar__tab-sub {\n  font-size: 0.75rem');
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/max-width:\s*100%/);
  });
});

describe('a cash tab is what it was', () => {
  it('prints its stakes between hands', () => {
    const el = pill(tab({ name: 'NLH 1/2', stakes: '1/2', gameCode: 'NLH', isTournament: false }));
    expect(nameOf(el)).toBe('NLH');
    expect(subOf(el)).toBe('1/2');
  });

  it('prints the live pot while a hand runs without the hero', () => {
    const el = pill(
      tab({ name: 'NLH 1/2', stakes: '1/2', gameCode: 'NLH', isTournament: false, pot: 12500 })
    );
    expect(subOf(el)).toBe('Pot 12,500');
  });

  it('a heads-up CASH table is not a tournament, and a stray buy-in changes nothing', () => {
    expect(isTournamentGameCode('HU')).toBe(false);
    expect(isTournamentGameCode('NLH')).toBe(false);
    expect(isTournamentGameCode('')).toBe(false);
    expect(isTournamentGameCode(undefined)).toBe(false);
    const el = pill(tab({ stakes: '5/10', gameCode: 'HU', tournamentBuyIn: 55 }));
    expect(subOf(el)).toBe('5/10');
  });
});

describe('the buy-in travels from the tournament row to the pill', () => {
  const multi = read('src/pages/MultiTablePage.tsx');

  it('the container hands the bar both facts and derives neither', () => {
    expect(multi).toMatch(/isTournament: t\.isTournament,/);
    expect(multi).toMatch(/tournamentBuyIn: t\.tournamentBuyIn,/);
  });

  it('a tab that does not know its price asks once, and never polls', () => {
    const effect = sliceStatement(multi, 'const need = tables');
    expect(effect).toContain('t.tournamentBuyIn === undefined');
    expect(effect).toContain('!buyInAskedRef.current.has(t.id)');
    const lookup = multi.slice(
      multi.indexOf('const buyInAskedRef = useRef'),
      multi.indexOf('// P1-2 FIX: hand each child a STABLE callback')
    );
    expect(lookup).toContain('readTournamentTabInfo(need)');
    expect(lookup).not.toMatch(/setInterval|setTimeout/);
  });

  it('a balance move keeps the price with the chair, on both move paths', () => {
    // The socket path (the tab re-point in updateTableInfo) ...
    expect(multi).toMatch(/tournamentBuyIn: current\.tournamentBuyIn,/);
    // ... and the seat-row path, which rebuilds the tab from the new table's row.
    const insertPath = multi.slice(
      multi.indexOf("event: 'INSERT',"),
      multi.indexOf('announceTournamentMove(oldTab.id, newId, name);')
    );
    const repointed = insertPath.slice(insertPath.indexOf('t.id === oldTab.id'));
    expect(repointed).toContain('arrivedByMoveAt: Date.now(),');
    expect(repointed).toContain('tournamentBuyIn: t.tournamentBuyIn,');
  });
});

describe('return banner tournament identity', () => {
  const multi = read('src/pages/MultiTablePage.tsx');
  it('reads event names and total entry prices in the same bounded batch', async () => {
    metadata.read
      .mockResolvedValueOnce({
        data: [
          { id: 'table-1', tournament_id: 'event' },
          { id: 'table-2', tournament_id: 'event' },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'event', name: 'Sunday 200 Deep Stack', buy_in_amount: 200, buy_in_fee: 20 }],
        error: null,
      });
    const result = await readTournamentTabInfo(['table-1', 'table-2', 'table-1']);
    expect(result.get('table-1')).toEqual({ name: 'Sunday 200 Deep Stack', buyIn: 220 });
    expect(result.get('table-2')).toEqual(result.get('table-1'));
    expect(metadata.read).toHaveBeenNthCalledWith(1, 'tables', 'id, tournament_id', 'id', [
      'table-1',
      'table-2',
    ]);
    expect(metadata.read).toHaveBeenNthCalledWith(
      2,
      'tournaments',
      'id, name, club_id, union_id, buy_in_amount, buy_in_fee',
      'id',
      ['event']
    );
    metadata.read.mockClear();
  });

  it('preserves unreadable results as failures, never invented event information', async () => {
    metadata.read.mockResolvedValueOnce({ data: null, error: new Error('Permission Denied') });
    await expect(readTournamentTabInfo(['table-1'])).rejects.toThrow('Permission Denied');
    metadata.read.mockClear();
  });

  it('uses tournament identity on the banner, including urgent turns and both move paths', () => {
    const banner = multi.slice(
      multi.indexOf('const renderTakeSeatBar'),
      multi.indexOf('const tableCrashFallback')
    );
    expect(banner).toContain('const tournament = tabIsTournament(target)');
    expect(banner).toContain('Your Turn · Tournament Running');
    expect(banner).toContain('formatGameTitle(target.tournamentName)');
    expect(banner).toContain('Buy-In ${buyIn}');
    expect(banner).toContain('Tournament Details Unavailable');
    expect(banner).toContain('formatGameTitle(target.name)');
    expect(multi).toContain('tournamentName: t.tournamentName,');
    expect(multi).toContain('tournamentName: current.tournamentName,');
  });
});
