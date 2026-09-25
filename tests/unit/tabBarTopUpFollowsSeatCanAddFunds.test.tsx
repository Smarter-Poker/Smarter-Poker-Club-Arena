/**
 * THE TAB BAR OFFERS TOP UP ONLY WHERE A TOP UP CAN HAPPEN (B12, 2026-09-19).
 *
 * The multi-table hamburger rendered "Top Up" and "Auto Top Up" for every
 * table tab. Both emit a bus action that the owning TablePage answers with the
 * shared `seatCanAddFunds` rule, and at a seat where that rule says no (a
 * Diamond tournament seat, reachable since #4938) the page broke out of the
 * switch in silence: two items, two taps, nothing. The tab bar cannot see the
 * arena, so the page now REPORTS the rule's answer beside everything else it
 * reports for its tab, and the menu drops both items on `false`.
 *
 * Absent keeps both, exactly as before: every chip tab that has not reported
 * yet, and every existing render of the bar, is byte-identical to today.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDefaultMenuSections } from '../../src/components/table/TableMenu';
import { TableTabBar, type TabInfo } from '../../src/components/table/TableTabBar';
import { sliceStatement } from '../helpers/sourceWindow';

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

const read = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const ids = (state?: Parameters<typeof createDefaultMenuSections>[1]) =>
  createDefaultMenuSections({}, state).flatMap((s) => s.actions.map((a) => a.id));

describe('createDefaultMenuSections', () => {
  it('drops Top Up and Auto Top Up, and nothing else, when funds cannot be added', () => {
    const before = ids({ autoTopUpBadge: 'ON' });
    const after = ids({ autoTopUpBadge: 'ON', canAddFunds: false });
    expect(before).toContain('rebuy');
    expect(before).toContain('auto-top-up');
    expect(after).not.toContain('rebuy');
    expect(after).not.toContain('auto-top-up');
    expect(after).toEqual(before.filter((id) => id !== 'rebuy' && id !== 'auto-top-up'));
  });

  it('keeps both when the seat can add funds, and when nothing has been reported', () => {
    expect(ids({ canAddFunds: true })).toEqual(ids());
    expect(ids(undefined)).toEqual(ids({}));
    expect(ids()).toContain('rebuy');
    expect(ids()).toContain('auto-top-up');
  });
});

describe('TableTabBar', () => {
  const tab = (over: Partial<TabInfo> = {}): TabInfo => ({
    id: 'table-1',
    name: 'NLH 1/2',
    stakes: '1/2',
    isMyTurn: false,
    seated: true,
    ...over,
  });
  const open = (tabs: TabInfo[]) => {
    render(
      <TableTabBar
        tabs={tabs}
        activeTabId={tabs[0].id}
        onTabSelect={() => {}}
        onAddTable={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Table Menu' }));
    return screen.getByRole('menu');
  };

  it('omits both items at a seat that reported it cannot add funds', () => {
    const menu = open([tab({ canAddFunds: false })]);
    expect(menu.textContent).toContain('Sit Out Next Hand');
    expect(menu.textContent).not.toContain('Top Up');
  });

  it('offers both at a chip seat, and at a tab that has not reported yet', () => {
    for (const over of [{ canAddFunds: true }, {}]) {
      const menu = open([tab(over)]);
      expect(menu.textContent).toContain('Top Up');
      expect(menu.textContent).toContain('Auto Top Up');
      fireEvent.click(screen.getByRole('button', { name: 'Table Menu' }));
      document.body.innerHTML = '';
    }
  });
});

describe('the answer travels from the table page to the menu, and is derived nowhere else', () => {
  const TABLE_PAGE = 'src/pages/TablePage.tsx';
  const MULTI = 'src/pages/MultiTablePage.tsx';
  const BAR = 'src/components/table/TableTabBar.tsx';

  it('the table page reports the shared rule beside its other tab facts', () => {
    const report = sliceStatement(read(TABLE_PAGE), 'onTableInfoUpdate({');
    expect(report).toMatch(
      /canAddFunds: seatCanAddFunds\(tableState\.arenaAsset, tableState\.isTournament\)/
    );
    expect(report, 'isTournament rides in the same report').toMatch(
      /isTournament: tableState\.isTournament/
    );
  });

  it('the multi-table page passes it through without deriving it', () => {
    const src = code(MULTI);
    expect(src).toMatch(/canAddFunds: t\.canAddFunds/);
    expect(src, 'this page cannot see the arena and must not guess').not.toMatch(
      /seatCanAddFunds|arenaAsset/
    );
  });

  it('the tab bar hands the active tab answer to the menu builder', () => {
    const src = code(BAR);
    expect(src).toMatch(/canAddFunds: tabs\.find\(\(t\) => t\.id === activeTabId\)\?\.canAddFunds/);
    expect(src, 'the bar does not guess either').not.toMatch(/seatCanAddFunds|arenaAsset/);
  });
});
