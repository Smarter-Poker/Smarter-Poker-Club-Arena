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
} from '../src/lib/tournamentTabLabel';
import { isTournamentGameCode } from '../src/utils/gameCode';
import { FREE_BUY_LABEL } from '../src/utils/freeBuy';
import { sliceCssRule, sliceStatement } from './helpers/sourceWindow';

vi.mock('../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

afterEach(() => cleanup());

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
    const rule = sliceCssRule(css, '\n.table-tab-bar__tab-sub {\n  font-size: 0.575rem');
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
    expect(lookup).toContain('readTournamentBuyIns(need)');
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
