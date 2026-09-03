/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE BET RAIL AND THE FOOTER — Dan's 2026-08-27 pair, pinned
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two complaints, both about the bottom of the table:
 *
 *   "the bet action slider is now missing from the action bar. There should be
 *    a slider located on the right, that slides up and down (NEVER SIDE TO
 *    SIDE) that moves the bets up in small increments."
 *
 *   "the action tab should be attached to the footer, that large dark padding
 *    should never be there (below raise button)."
 *
 * Where the behaviour is a rendered fact it is asserted by rendering. Where it
 * is a layout fact — a rotation, a gutter, a collapsed row — it is asserted
 * against the stylesheet source, the technique tests/unit/bottomBarReserve.ts
 * and tourneyUxSweep20260825 already use. happy-dom does not lay CSS out, so a
 * render can tell you the rail EXISTS but never that it is vertical; only the
 * stylesheet can say that, and the stylesheet is where both bugs lived.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ActionPanel from '../../src/components/table/ActionPanel';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** Strip comments so a rule QUOTED IN PROSE cannot satisfy a source assertion. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const ACTION_CSS = code(read('src/components/table/ActionPanel.css'));
const ACTION_TSX = code(read('src/components/table/ActionPanel.tsx'));
const TABLE_TSX = code(read('src/pages/TablePage.tsx'));

/** The declarations of the first rule with this exact selector. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {');
  if (at === -1) throw new Error(`no rule for "${selector}"`);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** The body of an at-rule, by brace matching (it contains nested rules). */
function atRule(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at === -1) throw new Error(`no at-rule "${head}"`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated at-rule "${head}"`);
}

/** Brace nesting depth at which a rule sits. 0 = top level, not inside an at-rule. */
function depthOf(css: string, needle: string): number {
  const at = css.indexOf(needle);
  if (at === -1) throw new Error(`no rule "${needle}"`);
  let depth = 0;
  for (let i = 0; i < at; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
  }
  return depth;
}

const px = (block: string, prop: string): number => {
  const m = block.match(new RegExp(`${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  if (!m) throw new Error(`no ${prop} in block`);
  return Number(m[1]);
};

// ─────────────────────────────────────────────────────────────────────────────

/** 1/2 no-limit, hero facing an open to 10 with 200 behind. */
const base = {
  canFold: true,
  canCheck: false,
  canCall: true,
  canRaise: true,
  canAllIn: true,
  currentBet: 10,
  callAmount: 10,
  minRaise: 12,
  maxRaise: 200,
  pot: 30,
  bigBlind: 2,
  isMyTurn: true,
};

const PHONE = 375;

function atWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w });
  window.dispatchEvent(new Event('resize'));
}

const openPanel = () => {
  const opener =
    screen.queryByLabelText('Open Bet Panel') ?? screen.getByLabelText('Open Raise Panel');
  fireEvent.click(opener);
};

const slider = () => screen.getByLabelText('Raise Amount') as HTMLInputElement;
const shownAmount = (): string =>
  screen.getByRole('button', { name: /^Edit Bet Amount/ }).textContent ?? '';

afterEach(() => {
  cleanup();
  document.body.classList.remove('ca-raising');
  atWidth(1024);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  1. THE RAIL IS THE ONLY SIZING CONTROL, AT EVERY WIDTH
// ═══════════════════════════════════════════════════════════════════════════════

describe('the bet slider is a vertical rail on a phone, and nothing else', () => {
  /**
   * The rail used to be gated behind `windowWidth >= 1024`, so a phone got the
   * HORIZONTAL slider — the one whose drag is the same gesture as the
   * table-switch swipe. The gate is gone and so is the horizontal control: a
   * fallback that can still be reached by a prop is a fallback that will
   * eventually be reached.
   */
  it('renders the vertical rail at 375px', () => {
    atWidth(PHONE);
    const { container } = render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    expect(container.querySelector('.raise-slider-vertical__rail')).toBeTruthy();
    expect(container.querySelector('.raise-slider-vertical__ticks')).toBeTruthy();
  });

  it('renders NO horizontal slider at 375px', () => {
    atWidth(PHONE);
    const { container } = render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    expect(container.querySelector('.raise-slider-wrap')).toBeNull();
    // Exactly one range control on the panel — not a rail plus a leftover strip.
    expect(container.querySelectorAll('input[type="range"]').length).toBe(1);
  });

  it('cannot be switched back to horizontal by the deprecated prop', () => {
    // `verticalSlider` is accepted and ignored. Passing false used to produce
    // the side-to-side control; it must now change nothing at all.
    atWidth(PHONE);
    const { container } = render(
      <ActionPanel {...base} verticalSlider={false} onAction={vi.fn()} />
    );
    openPanel();
    expect(container.querySelector('.raise-slider-vertical__rail')).toBeTruthy();
    expect(container.querySelector('.raise-slider-wrap')).toBeNull();
  });

  it('has no horizontal branch left in the component to reach', () => {
    expect(ACTION_TSX).not.toContain('raise-slider-wrap');
    expect(ACTION_TSX).not.toContain('raise-slider-tick"');
  });

  it('carries the whole slider a11y contract, so arrow keys and AT still work', () => {
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    const el = slider();
    expect(el.getAttribute('type')).toBe('range');
    expect(el.getAttribute('aria-valuemin')).toBe('12');
    expect(el.getAttribute('aria-valuemax')).toBe('200');
    expect(el.getAttribute('aria-valuenow')).toBe('12');
    expect(el.getAttribute('aria-valuetext')).toMatch(/^Raise /);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. IT CANNOT BE DRIVEN SIDEWAYS
// ═══════════════════════════════════════════════════════════════════════════════

describe('the rail travels up and down only', () => {
  const rail = rule(ACTION_CSS, '.raise-slider-vertical__rail .raise-slider');

  it('is turned on its side by a transform, so a sideways drag moves nothing', () => {
    // The browser maps the pointer through the inverse transform: screen-X
    // becomes the input's local Y, which a range input ignores. This is the
    // mechanism, so this is what gets pinned.
    expect(rail).toMatch(/rotate\(-90deg\)/);
  });

  it('takes the whole gesture, so a bet drag can never swipe the table away', () => {
    expect(rail).toMatch(/touch-action:\s*none/);
  });

  it('sizes itself from the MEASURED rail length, not a hard-coded track', () => {
    // Pre-rotation width is what you see as height. A constant here is how the
    // thumb stopped short of the all-in cap on a tall panel.
    expect(rail).toMatch(/width:\s*var\(--raise-rail-length/);
    expect(ACTION_TSX).toContain('--raise-rail-length');
  });

  it('does not guess which engine it is on before turning the rail', () => {
    /**
     * The rotation used to sit inside
     *   @supports (-webkit-appearance: none) and (not (-moz-appearance: none))
     * with `orient="vertical"` covering the excluded engine. That is a guess
     * about a vendor-prefixed ALIAS — precisely the thing an engine adds for
     * web compatibility without announcing it — and an engine that answers
     * "yes" to both halves gets neither branch: a horizontal range input
     * crushed into a 28px column, side to side, on a phone.
     */
    // No feature query may ask which appearance prefix this engine speaks …
    expect(ACTION_CSS).not.toMatch(/@supports[^{]*appearance/);
    // … and the rail's geometry must sit at the top level of the stylesheet,
    // not inside any at-rule that could decline to apply it.
    expect(depthOf(ACTION_CSS, '.raise-slider-vertical__rail .raise-slider {')).toBe(0);
    // One geometry everywhere means no native-vertical opt-in either.
    expect(ACTION_TSX).not.toContain('orient');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. "MOVES THE BETS UP IN SMALL INCREMENTS" — the step is the chip unit
// ═══════════════════════════════════════════════════════════════════════════════

describe('one notch of the rail is the smallest change the table can make', () => {
  it('steps by one dollar on a 1/2 cash table, not by one big blind', () => {
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    expect(slider().step).toBe('1');
  });

  it('steps by the chip grid at sub-dollar stakes, where a dollar is too coarse', () => {
    atWidth(PHONE);
    render(
      <ActionPanel
        {...base}
        bigBlind={0.5}
        smallBlind={0.25}
        currentBet={0.5}
        callAmount={0.5}
        minRaise={3}
        maxRaise={63.25}
        allInTo={63.25}
        onAction={vi.fn()}
      />
    );
    openPanel();
    expect(slider().step).toBe('0.25');
  });

  it('scales with chip depth in a tournament', () => {
    atWidth(PHONE);
    render(
      <ActionPanel
        {...base}
        isTournament
        bigBlind={3000}
        smallBlind={1500}
        currentBet={3000}
        callAmount={3000}
        minRaise={6000}
        maxRaise={90000}
        allInTo={90000}
        onAction={vi.fn()}
      />
    );
    openPanel();
    expect(slider().step).toBe('1500');
  });

  it('a single notch really does move one step, with no big-blind snap', () => {
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    // The browser can only emit min + n*step, so this IS one notch.
    fireEvent.change(slider(), { target: { value: '13' } });
    expect(shownAmount()).toBe('13');
    fireEvent.change(slider(), { target: { value: '14' } });
    expect(shownAmount()).toBe('14');
  });

  it('the +/- nudges walk the same unit the drag does', () => {
    // If these ever disagree, one of the two controls cannot reach amounts the
    // other can, which is the 2026-08-23 defect in its original form.
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    expect(screen.getByLabelText('Increase By 1')).toBeTruthy();
    expect(screen.getByLabelText('Decrease By 1')).toBeTruthy();
  });

  it('still reaches the all-in when the ceiling is off the step grid', () => {
    const onAction = vi.fn();
    atWidth(PHONE);
    render(<ActionPanel {...base} maxRaise={187.5} allInTo={187.5} onAction={onAction} />);
    openPanel();
    // 187.50 is not 12 + n*1, so the top the browser can emit is 187.
    fireEvent.change(slider(), { target: { value: '187' } });
    fireEvent.click(screen.getByRole('button', { name: /^All In For [\d.,]/ }));
    expect(onAction).toHaveBeenCalledWith('allin', 187.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. NO DEAD HEIGHT UNDER THE CONFIRM ROW
// ═══════════════════════════════════════════════════════════════════════════════

describe('the sizing panel is attached to the footer', () => {
  /**
   * Dan 2026-08-27: "the action tab should be attached to the footer, that
   * large dark padding should never be there (below raise button)."
   *
   * Three things stacked under the confirm button and each one was invisible
   * on its own: a `visibility: hidden` button row still holding its full 46px,
   * this layout's own 10px bottom margin, and the home-indicator inset. About
   * 90px of flat black on a notched phone.
   */
  it('collapses the stood-down button row instead of merely hiding it', () => {
    const row = rule(ACTION_CSS, '.action-panel--raise .action-row');
    expect(row).toMatch(/display:\s*none/);
    // `visibility: hidden` is the regression: it hides the pixels and keeps
    // every one of them.
    expect(row).not.toMatch(/visibility/);
  });

  it('leaves no gap where the row used to be', () => {
    const layout = rule(ACTION_CSS, '.action-panel--raise .raise-layout');
    const margin = layout.match(/margin:\s*([^;]+);/);
    expect(margin).toBeTruthy();
    // `0 auto`, not `0 auto 10px` — a gap above a row that is no longer there.
    expect(margin![1].trim()).toBe('0 auto');
  });

  it('allows the home-indicator strip and not one pixel more, at every width', () => {
    // The base rule and both phone breakpoints restate this, because a
    // `padding` shorthand inside a media query silently puts the old gap back.
    const flush = ACTION_CSS.match(/padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\);/g);
    expect(flush?.length ?? 0).toBeGreaterThanOrEqual(3);
    // Nothing may add fixed padding on top of the inset on this bar.
    expect(ACTION_CSS).not.toMatch(/padding-bottom:\s*calc\(\s*\d+px\s*\+\s*env\(safe-area/);
  });

  it('keeps the stood-down buttons in the DOM, so nothing reading it breaks', () => {
    // `display: none` hides a box; it does not unmount a component. The
    // aria-expanded contract and every DOM-shaped test still hold.
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    expect(screen.getByLabelText('Fold')).toBeTruthy();
    expect(screen.getByLabelText(/^Call /)).toBeTruthy();
    expect(screen.getByLabelText('Close Raise Panel').getAttribute('aria-expanded')).toBe('true');
  });

  it('gives the player Back as the way out of the overlay', () => {
    // The row is not tappable while the overlay is up (it has been
    // `pointer-events: none` since 2026-08-26 and is now `display: none`), so
    // this button is the exit and has to work.
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    openPanel();
    fireEvent.click(screen.getByLabelText('Back'));
    expect(screen.queryByLabelText('Raise Amount')).toBeNull();
    expect(screen.getByLabelText('Open Raise Panel').getAttribute('aria-expanded')).toBe('false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. THE FELT CANNOT REFLOW WHILE A BET IS BEING SIZED
// ═══════════════════════════════════════════════════════════════════════════════

describe('the bottom reserve cannot move under a player mid-drag', () => {
  /**
   * The 2026-08-26 rule refused `display: none` on the grounds that
   * "--sp-action-h is MEASURED from this panel's real height", so collapsing
   * the row would shrink the reserve and resize the table under the thumb.
   *
   * It was not measured from the panel — the ref was on `.action-panel-wrapper`
   * and the panel is `position: fixed`, out of that wrapper's flow.
   *
   * 2026-08-27: nothing is measured at all now. The wrapper's height was still
   * reaching the felt by a different door — it collapses to 1px whenever the
   * hero has no action, which rescaled the whole table twice a hand (Dan: "the
   * screen is moving in and out constantly"). The reserve is a declared
   * constant, so the guarantee this section is about no longer rests on an
   * argument about which element a ref happens to be attached to.
   */
  it('takes no measurement of the bottom chrome at all', () => {
    expect(TABLE_TSX).not.toContain('actionPanelRef');
    expect(TABLE_TSX).not.toContain("setProperty('--sp-action-h'");
  });

  it('keeps the panel out of the wrapper flow', () => {
    expect(rule(ACTION_CSS, '.action-panel')).toMatch(/position:\s*fixed/);
  });

  it('pins the wrapper height outright for as long as the overlay is open', () => {
    // Belt and braces: this makes the no-reflow guarantee structural rather
    // than a fact about today's markup. `height`, not `max-height` — the point
    // is that it can move neither way.
    // 2026-08-28: was `body.ca-raising .table-page .action-panel-wrapper`. The
    // flag is per-TABLE now, not per-document — see the scoping test below.
    const pinned = rule(ACTION_CSS, '.table-page.ca-raising .action-panel-wrapper');
    expect(pinned).toMatch(/height:\s*calc\(\s*var\(--sp-bottom-row-h/);
    expect(pinned).toMatch(/env\(safe-area-inset-bottom/);
    expect(pinned).not.toMatch(/max-height/);
  });

  it('arms that pin for exactly the life of the overlay', () => {
    // A pin nothing sets is a comment. The class is what turns it on. Mounted
    // with no `.table-page` above it, the panel falls back to <body> — which is
    // what keeps this component testable in isolation.
    atWidth(PHONE);
    render(<ActionPanel {...base} onAction={vi.fn()} />);
    expect(document.body.classList.contains('ca-raising')).toBe(false);
    openPanel();
    expect(document.body.classList.contains('ca-raising')).toBe(true);
    fireEvent.click(screen.getByLabelText('Back'));
    expect(document.body.classList.contains('ca-raising')).toBe(false);
  });

  it('flags THIS table, not the document, when a table root is above it', () => {
    /* Dan multi-tables. MultiTablePage keeps up to four TablePages mounted, and
       until 2026-08-28 this flag went on `document.body`: in tile view one
       panel's slider blanked the timebank pill, previous-hand card and chat
       button on all four tables, and one panel closing stripped the class from
       under a panel that was still open — putting those widgets straight back
       over the slider handle, which is the exact defect the flag prevents.

       So: the class must land on the panel's OWN `.table-page` ancestor, and
       <body> must stay clean. */
    atWidth(PHONE);
    const host = document.createElement('div');
    host.className = 'table-page';
    document.body.appendChild(host);
    try {
      render(<ActionPanel {...base} onAction={vi.fn()} />, { container: host });
      openPanel();
      expect(host.classList.contains('ca-raising')).toBe(true);
      expect(document.body.classList.contains('ca-raising')).toBe(false);
      fireEvent.click(screen.getByLabelText('Back'));
      expect(host.classList.contains('ca-raising')).toBe(false);
    } finally {
      host.remove();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. THE PHONE GUTTER — the thumb has to stay on the screen
// ═══════════════════════════════════════════════════════════════════════════════

describe('the rail fits the 375px gutter it is given', () => {
  const MOBILE = atRule(ACTION_CSS, '@media (max-width: 1023px)');

  const gutter = Number(
    rule(MOBILE, '.action-panel--raise-vertical')
      .match(/padding-right:\s*calc\((\d+)px\s*\+\s*(\d+)px\)/)!
      .slice(1, 3)
      .reduce((a, b) => String(Number(a) + Number(b)))
  );
  const column = rule(MOBILE, '.raise-slider-vertical');
  const offset = Math.abs(px(column, 'right'));
  const railWidth = px(rule(MOBILE, '.raise-slider-vertical__rail'), 'width');
  const thumb = px(
    rule(MOBILE, '.raise-slider-vertical__rail .raise-slider::-webkit-slider-thumb'),
    'width'
  );

  /* Measured leftwards from the viewport's right edge. `justify-content:
     flex-end` puts the rail at the column's right edge, so:
        centre = gutter - offset + railWidth / 2   (distance in from the edge) */
  const centre = gutter - offset + railWidth / 2;

  it('reserves that gutter with enough weight to survive the breakpoints', () => {
    /**
     * `.action-panel--raise-vertical` alone is 0,1,0 — the same weight as
     * `.action-panel`, whose `padding: 5px 10px` SHORTHAND in the <=640px and
     * <=380px blocks sits later in this file. Equal weight, later source: the
     * shorthand won, and the gutter this rule reserves was being thrown away
     * on every phone. The rail is positioned into that gutter, so it landed on
     * top of the preset row and the confirm button — the overlap Dan reported
     * on 2026-08-25, reappearing through the back door.
     *
     * Both copies must be compound. This is the third rule in this stylesheet
     * to be caught by the same trap.
     */
    for (const scope of [ACTION_CSS, MOBILE]) {
      // It must exist …
      expect(scope).toContain('.action-panel.action-panel--raise-vertical {');
      // … and never appear as a bare single class, which is the losing form.
      expect(scope).not.toMatch(/(^|[\s,{};])\.action-panel--raise-vertical\s*\{/m);
    }
  });

  it('docks the rail on the right, outside the content column', () => {
    expect(column).toMatch(/justify-content:\s*flex-end/);
    // Negative `right` = outside .raise-layout, i.e. in the reserved gutter.
    expect(px(column, 'right')).toBeLessThan(0);
  });

  it('never lets the thumb hang off the edge of the screen', () => {
    // The old numbers (gutter 64, offset 60, rail 30, thumb 48) put the thumb's
    // right edge 5px PAST the viewport, so a fifth of the grab target could not
    // be touched at all.
    expect(centre - thumb / 2).toBeGreaterThan(0);
  });

  it('never lets the thumb reach back over the action buttons', () => {
    // Dan 2026-08-25: "the slider needs to be moved over to the right and not
    // overlap the rest of the action buttons."
    expect(centre + thumb / 2).toBeLessThanOrEqual(gutter);
  });

  it('keeps the tick labels legible, and out of the content column', () => {
    const label = rule(MOBILE, '.raise-slider-vertical__tick-label');
    // Labels sit to the LEFT of the rail line: a right-hand label is the one
    // thing here that could clip at the viewport edge.
    expect(label).toMatch(/right:\s*calc\(100% \+ \d+px\)/);
    // 8px is below the size a four-figure chip count is readable at on a
    // phone, and these labels name what the thumb is about to bet.
    expect(px(label, 'font-size')).toBeGreaterThanOrEqual(9);
    // Rough label width at 9px for the longest string ("ALL IN"), plus its
    // 4px offset from a 10px tick, must still clear the content column.
    expect(centre + 5 + 4 + 34).toBeLessThanOrEqual(gutter + 12);
  });

  it('shrinks the thumb rather than the touch target below usable', () => {
    // 36px is still half again the 24px a thumb needs to be grabbable under a
    // shot clock; the 48px desktop disc is most of a phone gutter on its own.
    expect(thumb).toBeGreaterThanOrEqual(32);
    expect(thumb).toBeLessThan(48);
  });
});
