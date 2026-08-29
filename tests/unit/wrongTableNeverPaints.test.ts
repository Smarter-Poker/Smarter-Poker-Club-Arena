/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE WRONG TABLE MUST NEVER REACH THE SCREEN (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "anytime you open a table, it shows the previous or different table for
 * a split second before changing to the correct table."
 *
 * Three causes, three pins. MultiTablePage derives `hidden` synchronously from
 * the URL but used to sync `tables`/`activeIndex` in a PASSIVE effect — so on
 * the commit where the URL became /table/B the container un-hid and painted
 * the previously active table for one frame. The sync must be a LAYOUT effect,
 * which runs before the browser paints. Second: a tab switch never updated the
 * URL, so the address bar named a table the player had left, and the next
 * route arrival painted it. Third: TablePage read `location.state.
 * initialTableState` without checking WHOSE table the payload described, so a
 * mount without its own navigation inherited another table's name, blinds and
 * seat count.
 *
 * These are source-contract pins (the repo's pattern for guards inside
 * components too heavy to render in a unit test — see the resolveThemeBucket
 * history in useUserThemeSettings). If one fails, read the comment beside the
 * code it points at before "fixing" the test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

describe('MultiTablePage route sync paints in the same frame as visibility', () => {
  const src = read('pages/MultiTablePage.tsx');

  it('syncs the route-derived tab state in a LAYOUT effect, not a passive one', () => {
    // The effect that begins `if (!routeTableId) return;` is the route->tabs
    // sync. It must run before paint or the previous table shows for a frame.
    const idx = src.indexOf('if (!routeTableId) return;');
    expect(idx).toBeGreaterThan(-1);
    const opener = src.lastIndexOf('use', idx);
    expect(src.slice(opener, opener + 'useLayoutEffect'.length)).toBe('useLayoutEffect');
  });

  it('imports useLayoutEffect from react', () => {
    expect(src).toMatch(/useLayoutEffect/);
    expect(src).toMatch(/from 'react'/);
  });

  it('keeps the URL on the table the player is looking at when switching tabs', () => {
    // Both the tab bar select and the swipe commit must navigate (replace) to
    // the target table, so URL and felt can never disagree about a real table.
    //
    // 2026-08-28: those URLs now also carry the tab's own name/stakes/code
    // (`${tableQuery(target)}`), because a bare /table/:id told a reload less
    // than the tab strip was already showing and a labelled tab came back as
    // "Table 1". The suffix is optional in this pattern rather than required:
    // what this test is about is that BOTH paths sync the URL with `replace`,
    // and it should not fail if a tab legitimately has nothing to add.
    const navSyncs = src.match(
      /navigate\(`\/table\/\$\{target\.id\}(?:\$\{tableQuery\(target\)\})?`, \{ replace: true \}\)/g
    );
    expect(navSyncs?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("TablePage refuses another table's initialTableState", () => {
  const src = read('pages/TablePage.tsx');

  it('applies location.state.initialTableState only when it names THIS table', () => {
    expect(src).toContain(
      'const init = rawInit && (!rawInit.tableId || rawInit.tableId === tableId) ? rawInit : undefined;'
    );
  });
});

describe('the producer stamps the table identity the guard compares against', () => {
  it('ClubHomePage includes tableId in the initialTableState payload', () => {
    const src = read('pages/ClubHomePage.tsx');
    const payloadStart = src.indexOf('initialTableState: entry');
    expect(payloadStart).toBeGreaterThan(-1);
    expect(sliceEnclosingBlock(src, 'initialTableState: entry')).toContain('tableId: entry.id');
  });
});
