/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TITLE IS A COLUMN LIKE ANY OTHER, AND IT LEADS THE BOARD
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25 (verbatim): "TOURNAMENT TITLES HAVE BEEN REMOVED FROM THE
 * 'ALL TAB' AND FROM THE 'MTT TAB'. THAT SHOULD BE THE FIRST LINE DISPLAYED."
 *
 * Nothing had removed them. `.lobby-table` is `table-layout: fixed`, which
 * gives every column that STATES a width exactly that width and divides what
 * is LEFT among the ones that say `auto`. `.lt-col-name` was the only auto
 * column in the file, and the wells added earlier the same day pushed the
 * stated widths past the table's own width — so the remainder was zero and the
 * title collapsed to nothing, header and all, on precisely the two tabs that
 * carry the most columns. The cell holding the game's identity was the only
 * cell that could lose, because it was the only one asking for leftovers.
 *
 * What this pins:
 *   1. No column in a fixed-layout table asks for the remainder — every
 *      `lt-col-*` class the component renders states a width. This is the
 *      general rule; the title was only the first casualty of breaking it.
 *   2. `.lt-col-name` in particular states one, and it is not `auto`.
 *   3. The MTT board leads with the tournament name.
 *   4. The ALL board carries the name ahead of every fact about the game.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CSS = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.css'), 'utf8');
const TSX = readFileSync(resolve(__dirname, '../../src/components/lobby/LobbyTable.tsx'), 'utf8');
const PANEL = readFileSync(
  resolve(__dirname, '../../src/components/lobby/GameLobbyPanel.tsx'),
  'utf8'
);

/** The body of `columnsFor`, with block comments stripped so a column name
 *  mentioned in prose cannot be mistaken for a column in the set. */
function columnSet(label: string): string[] {
  const body = TSX.slice(TSX.indexOf('export function columnsFor'));
  const start = body.indexOf(`case '${label}':`);
  expect(start, `columnsFor has no ${label} case`).toBeGreaterThan(-1);
  const open = body.indexOf('return [', start);
  const close = body.indexOf('];', open);
  return body
    .slice(open + 'return ['.length, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      // `{ ...COL_VARIANT, label: 'Game Type' }` is still the variant column.
      const spread = s.match(/\.\.\.(COL_[A-Z]+)/);
      return spread ? spread[1] : s;
    })
    .filter((s) => s.startsWith('COL_'));
}

/** Every `lt-col-*` class the component puts on a cell. */
function renderedColumnClasses(): string[] {
  const seen = new Set<string>();
  for (const m of TSX.matchAll(/className:\s*'(lt-col-[a-z]+)'/g)) seen.add(m[1]);
  return [...seen];
}

/** The width the stylesheet states for a class at full desktop width, i.e.
 *  before any media query narrows or drops it. */
function baseWidthOf(cls: string): string | null {
  const firstMedia = CSS.indexOf('@media');
  const desktop = firstMedia === -1 ? CSS : CSS.slice(0, firstMedia);
  /* Every desktop rule whose selector names this class, not just the first:
     the title also carries a `.lobby-table td.lt-col-name { text-align }` rule
     that declares no width, and stopping at that one made a column that HAS a
     width look like one that does not. */
  const rules = [...desktop.matchAll(new RegExp(`\\.${cls}[\\s,{][^{}]*\\{([^}]*)\\}`, 'g'))];
  for (const r of rules) {
    const width = /(?:^|[;\s])width:\s*([^;]+);/.exec(r[1]);
    if (width) return width[1].trim();
  }
  return rules.length ? null : null;
}

/** Classes the stylesheet removes from the desktop board outright. A column
 *  that is `display: none` there is not in the fixed layout at all, so it
 *  neither needs a width nor can starve anything that has one. */
function hiddenOnDesktop(): string[] {
  /* Match the block by the breakpoint the DESKTOP table starts at, and take
     only up to the first line-start `}`.

     This used to look for `min-width: 641px` and broke on 2026-08-25 when the
     card layout was extended to 900px: the card block gained a NESTED
     `@media (min-width: 641px)` for the two-up tablet grid, which matched
     first, and because a nested block closes on an INDENTED brace the capture
     ran to the end of the whole card block and swallowed every column class in
     it. A guard that silently starts exempting everything is worse than no
     guard, so this anchors on the one number that means "the table is a table
     again". */
  const block = /@media \(min-width:\s*901px\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
  if (!block) return [];
  return [...block[1].matchAll(/\.(lt-col-[a-z]+)/g)].map((m) => m[1]);
}

describe('the lobby board states a width for every column it draws', () => {
  it('is a fixed-layout table, which is why a missing width costs a whole column', () => {
    expect(CSS).toMatch(/\.lobby-table\s*\{[^}]*table-layout:\s*fixed/);
  });

  it('leaves no column asking for the remainder', () => {
    const exempt = hiddenOnDesktop();
    const missing = renderedColumnClasses().filter((cls) => {
      if (exempt.includes(cls)) return false;
      const w = baseWidthOf(cls);
      return w === null || w === 'auto';
    });
    expect(
      missing,
      `these columns state no width and collapse when the board is full: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('exempts only the action column, which the desktop board does not draw', () => {
    // The action buttons are a phone-card affordance; the desktop board sends
    // the player to the game panel instead. If this list ever grows, a real
    // column has gone missing from the desktop board and the exemption above
    // would hide it - so the list itself is pinned.
    expect(hiddenOnDesktop()).toEqual(['lt-col-actions']);
  });

  it('gives the title a width of its own', () => {
    const w = baseWidthOf('lt-col-name');
    expect(w).not.toBeNull();
    expect(w).not.toBe('auto');
    expect(w).toMatch(/^\d+px$/);
  });
});

describe('the title leads the board', () => {
  it('is the first column on the MTT tab', () => {
    expect(columnSet('MTT')[0]).toBe('COL_TNAME');
  });

  it('sits ahead of every fact about the game on the ALL tab', () => {
    const all = columnSet('ALL');
    expect(all).toContain('COL_NAME');
    // The favourite star is a control, not a fact, so it may lead.
    const facts = all.filter((c) => c !== 'COL_FAV' && c !== 'COL_NAME');
    expect(all.indexOf('COL_NAME')).toBeLessThan(Math.min(...facts.map((c) => all.indexOf(c))));
  });

  it('still names the cash boards too', () => {
    for (const tab of ['HOLDEM', 'SPIN', 'SNG']) {
      expect(columnSet(tab), `${tab} lost its name column`).toContain('COL_NAME');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Dan, 2026-08-25 (verbatim): "TITLES AND ALL GAME DESCRIPTIONS ON ALL PAGES
 * MUST BE LEFT JUSTIFIED ON ALL PAGES. ONLY THE TOP CATEGORY ROW SHOULD BE
 * CENTERED HERE. 2, REMOVE THE MAX PAYOUT ON ANY PAGE BESIDES SPINS. ITS ONLY
 * FOR THAT CATEGORY. FOR RULES, REMOVE IT FROM THE 'MAIN SCREEN' BUT MAKE SURE
 * ALL RULES AND TAGS ARE ON THE LOBBY SCREEN WHEN YOU CLICK THE GAME."
 */
describe('the title reads from a left edge, the heading above it does not', () => {
  it('left-aligns the name cell', () => {
    expect(CSS).toMatch(/\.lobby-table td\.lt-col-name \{[^}]*text-align: left/);
  });

  it('does not carry a justify-content that cannot apply', () => {
    /* `.lt-name { justify-content: flex-start }` was pinned here and then
       measured: every .lt-name the component renders also carries --mtt,
       --cash or --seatfirst, all of which set `flex-direction: column`, and
       flex-start is already the default on the column axis. It changed
       nothing. The two rules below are what actually deliver the left edge,
       so those are what this file pins. */
    const rule = /(?:^|\n)\.lt-name \{([^}]*)\}/.exec(CSS);
    if (rule) expect(rule[1]).not.toContain('justify-content');
  });

  it('stacks line 1 and line 2 of a title on the same left edge', () => {
    const rule = /\.lt-name--mtt,\s*\.lt-name--cash,\s*\.lt-name--seatfirst \{([^}]*)\}/.exec(CSS);
    expect(rule, 'the stacked-title rule was not found').toBeTruthy();
    expect(rule![1]).toContain('align-items: flex-start');
    expect(rule![1]).not.toContain('align-items: center');
  });

  it('leaves the column headings centred', () => {
    const head = /\.lobby-table thead th \{([^}]*)\}/.exec(CSS);
    expect(head, 'thead th rule not found').toBeTruthy();
    expect(head![1]).toContain('text-align: center');
  });
});

describe('Max Payout belongs to Spins and to nothing else', () => {
  it('appears on the Spin board', () => {
    expect(columnSet('SPIN')).toContain('COL_PAYOUT');
  });

  it('appears on no other board', () => {
    for (const tab of ['ALL', 'MTT', 'SNG', 'HOLDEM', 'OMAHA', 'LIMIT', 'MIXED']) {
      expect(columnSet(tab), `${tab} is offering Max Payout`).not.toContain('COL_PAYOUT');
    }
  });
});

describe('rules left the board and none of them were lost', () => {
  it('is on no column set', () => {
    for (const tab of ['ALL', 'MTT', 'SPIN', 'SNG', 'HOLDEM', 'OMAHA', 'LIMIT', 'MIXED']) {
      expect(columnSet(tab), `${tab} still draws a Rules column`).not.toContain('COL_RULES');
    }
  });

  it('took its cell and its stylesheet with it', () => {
    expect(TSX).not.toContain('COL_RULES');
    // The tombstone comment naming it is fine; the component and its use are not.
    expect(TSX).not.toContain('function RulesCell');
    expect(TSX).not.toContain('<RulesCell');
    expect(CSS).not.toContain('lt-col-rules');
    expect(CSS).not.toContain('.lt-rule');
  });

  it('is still computed for every row, because the panel reads it', () => {
    // entry.rules is what cashRuleMedallions / tournamentMedallions produce.
    expect(TSX + PANEL).toContain('entry.rules');
  });

  it('renders every rule, with its explanation, in the game panel', () => {
    // Two render sites: one for cash and seat-first games, one for tournaments.
    const sites = [...PANEL.matchAll(/entry\.rules\.map\(\(r\) => \(/g)];
    expect(sites.length, 'the panel renders no rule list').toBeGreaterThanOrEqual(2);
    // Label AND the sentence that explains it - the thing an abbreviation on a
    // phone could never give, since a phone has no hover.
    expect(PANEL).toContain('{r.label}');
    expect(PANEL).toContain('{r.tip}');
  });

  it('gates the list on nothing but having rules to show', () => {
    expect(PANEL).toContain('entry.rules.length > 0');
  });
});
