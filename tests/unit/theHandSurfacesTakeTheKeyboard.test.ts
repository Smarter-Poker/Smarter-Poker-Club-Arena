/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PHASE 7 — the keyboard-only walk, the 375px felt, and the archive's trim
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Three things the plan asked for, and the defects each one was hiding.
 *
 * THE WALK. The replayer had `role="tablist"` and two `role="tab"` buttons and
 * none of what makes those roles true - both tabs tabbable, neither naming its
 * panel, neither panel naming its tab, arrow keys dead. The panel claimed
 * `aria-modal="true"` and let Tab walk straight out into the live table
 * underneath, with no focus in and none restored. The modal had focus in and
 * out but nothing keeping Tab inside.
 *
 * THE FELT. Measured on the live share page at 375x812 with an 8-handed PLO8
 * hand: four pairs of seats overlapping, including a card row 45px across a
 * neighbour's stack. The numbers are in HandReplay.css beside the fix.
 *
 * THE ARCHIVE. One `setTimeout` per loaded hand, each copying the whole
 * visibility map, re-armed on every keystroke.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

describe('the replayer is a real tablist', () => {
  const src = read('src/components/replay/HandReplay.tsx');

  it('has one tabbable tab, and each tab names its panel', () => {
    expect(src).toMatch(/tabIndex=\{tab === 'replay' \? 0 : -1\}/);
    expect(src).toMatch(/tabIndex=\{tab === 'rundown' \? 0 : -1\}/);
    expect(src).toMatch(/aria-controls="hr-panel-replay"/);
    expect(src).toMatch(/aria-controls="hr-panel-rundown"/);
    expect(src).toMatch(/aria-labelledby="hr-tab-replay"/);
    expect(src).toMatch(/aria-labelledby="hr-tab-rundown"/);
  });

  it('moves between tabs with the arrows, and takes focus with it', () => {
    const handler = src.slice(src.indexOf('const onTabsKeyDown'), src.indexOf('const onKeyDown'));
    expect(handler).toMatch(/ArrowRight/);
    expect(handler).toMatch(/ArrowLeft/);
    expect(handler).toMatch(/'Home'/);
    expect(handler).toMatch(/'End'/);
    /* Focus follows selection. Without it a roving tabindex strands focus on a
       tab that is no longer tabbable, and the next Tab leaves from nowhere. */
    expect(handler).toMatch(/\.current\?\.focus\(\)/);
    expect(src).toMatch(/onKeyDown=\{onTabsKeyDown\}/);
  });

  it('the focusable container says what its keys do, and only when they do it', () => {
    /* A `tabIndex={0}` div is a focus stop; an unnamed one announces nothing.
       Its handler returns immediately on the rundown tab, so the label and the
       role are conditional on the tab that actually has the keys. */
    expect(src).toMatch(/role=\{tab === 'replay' \? 'application' : undefined\}/);
    expect(src).toMatch(/Arrow Keys Step, Home And End Jump, Space Plays/);
  });
});

describe('a dialog keeps the keyboard', () => {
  for (const [file, label] of [
    ['src/components/table/HandHistoryPanel.tsx', 'the table panel'],
    ['src/components/table/HandDetailModal.tsx', 'the hand modal'],
  ] as const) {
    it(`${label} traps Tab, focuses in, and gives focus back`, () => {
      const src = read(file);
      expect(src, `${file} declares itself modal`).toMatch(/aria-modal="true"/);
      /* aria-modal is a promise to a screen reader; the browser still walks
         the whole document, so the trap has to be real. */
      expect(src, `${file} handles Tab`).toMatch(/e\.key !== 'Tab'/);
      expect(src, `${file} wraps at both ends`).toMatch(/e\.shiftKey \? last : first/);
      /* Focus outside the container is the common case, not an edge one: click
         any non-focusable part and activeElement becomes <body>. */
      expect(src, `${file} recovers focus from outside`).toMatch(
        /!panelRef\.current\.contains\(document\.activeElement\)/
      );
      expect(src, `${file} focuses in`).toMatch(/panelRef\.current\?\.focus\(\)/);
      expect(src, `${file} restores focus`).toMatch(/restoreFocusTo\.current\?\.focus\?\.\(\)/);
      expect(src, `${file} still closes on Escape`).toMatch(/'Escape'/);
    });
  }
});

describe('the felt fits a phone', () => {
  const css = read('src/components/replay/HandReplay.css');

  it('gives nine seats the vertical room the measurement asked for', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(narrow).toMatch(/aspect-ratio: 4 \/ 6\.4/);
    /* The bottom-centre seat is the one whose cards reached into the seat
       beside it, and no amount of shrinking cleared it. */
    expect(narrow).toMatch(/\.hr-seat\.is-hero \{[\s\S]*?margin-top: 36px/);
  });

  it('records what was measured, so the numbers can be re-checked', () => {
    /* A geometry fix with no measurement behind it is a guess that the next
       person cannot re-derive. */
    expect(css).toMatch(/375x812/);
    expect(css).toMatch(/27 x 32 px/);
  });
});

describe('the archive does not arm a timer per hand', () => {
  const src = read('src/pages/HandHistoryPage.tsx');

  it('staggers only the cards that are staggered', () => {
    expect(src).toMatch(/const STAGGER_CARDS = 12;/);
    expect(src).toMatch(/ids\.slice\(0, STAGGER_CARDS\)/);
    /* Everything past the window arrives in ONE update rather than one per
       hand, each copying the whole map. */
    expect(src).toMatch(/const next = \{ \.\.\.prev \};/);
    expect(src).toMatch(/for \(const id of rest\) next\[id\] = true;/);
  });

  it('lets the browser skip cards nobody is looking at, past a hundred', () => {
    expect(src).toMatch(/const DEFER_OFFSCREEN_AFTER = 100;/);
    expect(src).toMatch(/index >= DEFER_OFFSCREEN_AFTER && !expanded/);
    /* An EXPANDED card is the one being read and its height is nothing like
       the intrinsic guess, so it never defers. */
    const css = read('src/pages/HandHistoryPage.css');
    expect(css).toMatch(/content-visibility: auto/);
    expect(css).toMatch(/contain-intrinsic-size/);
  });
});
