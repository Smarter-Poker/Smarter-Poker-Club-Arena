/**
 * THE FIRST TEST THAT HAS EVER RENDERED THIS BAR
 *
 * Before 2026-09-05 the ticker's suite covered the pure helpers well - the
 * anchor maths, the overlay gates, the registration predicate - and rendered
 * nothing. Every defect the audit found was in the render:
 *
 *   the flag was painted cyan on cyan, about 1.06:1
 *   the designed gradient was overridden by an inline flat fill and had never
 *     rendered once
 *   the strip was a polite live region wrapped around a 1Hz countdown
 *   the scrolling copy was announced twice
 *
 * None of those is subtle. All of them were invisible, because nothing mounted
 * the component. This file mounts it.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { sliceBetween, sliceCssRule } from '../helpers/sourceWindow';
import { TickerRail } from '../../src/components/tournament/TickerRail';
import {
  operatorItem,
  overlayItem,
  startingSoonItem,
  tableOpeningItem,
  type TickerItem,
} from '../../src/components/tournament/tickerMessages';
import { contrastRatio } from '../../src/utils/colorContrast';
import { TONE_ACCENT } from '../../src/components/tournament/tickerTheme';

const NOW = 1_800_000_000_000;

const APPEARANCE = {
  backgroundColor: '#0b1a33',
  textColor: '#f5fbff',
  // The house default, and the exact value that used to be painted on itself.
  accentColor: '#00d4ff',
  fontFamily: 'Rajdhani',
  speedSeconds: 24,
};

const soon = startingSoonItem({
  id: 't1',
  name: 'DSS Saturday nlh Daily',
  startsAt: NOW + 210_000,
  clubId: 'club-1',
  buyIn: 9,
  buyInFee: 2,
  registered: 24,
  isRegistered: false,
});

const overlay = overlayItem({
  id: 'o1',
  name: 'Sunday Slam',
  tier: 'live',
  overlay: 8400,
  guarantee: 20000,
  prizePool: 9000,
  entered: 90,
  entriesToClose: 42,
  startsAt: NOW - 600_000,
});

function mount(items: TickerItem[], over: Partial<React.ComponentProps<typeof TickerRail>> = {}) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <TickerRail
      items={items}
      now={NOW}
      top={44}
      appearance={APPEARANCE}
      onOpen={onOpen}
      onDismiss={onDismiss}
      {...over}
    />
  );
  const rail = utils.container.querySelector('.mtt-ticker') as HTMLElement;
  return { ...utils, rail, onOpen, onDismiss };
}

describe('the flag is legible, whatever colour the club picked', () => {
  it('is the regression: the accent no longer paints its own text', () => {
    const { rail } = mount([soon]);
    const fill = rail.style.getPropertyValue('--ticker-accent').trim();
    const ink = rail.style.getPropertyValue('--ticker-flag-ink').trim();
    expect(fill).toBe('#00d4ff');
    expect(ink).not.toBe(fill);
    expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('clears AA for every accent a club is able to save', () => {
    for (const accent of ['#00d4ff', '#f0b429', '#2d78d2', '#ffffff', '#000000', '#7a7a7a']) {
      const { rail, unmount } = mount([soon], {
        appearance: { ...APPEARANCE, accentColor: accent },
      });
      const fill = rail.style.getPropertyValue('--ticker-accent').trim();
      const ink = rail.style.getPropertyValue('--ticker-flag-ink').trim();
      expect(contrastRatio(ink, fill), `accent ${accent}`).toBeGreaterThanOrEqual(4.5);
      unmount();
    }
  });

  it('names the news on the chip', () => {
    const { rail } = mount([soon]);
    expect(rail.querySelector('.mtt-ticker__flag')?.textContent).toBe('STARTING SOON');
  });
});

describe('colour says what kind of news this is', () => {
  it("paints the routine case in the club's own accent", () => {
    const { rail } = mount([soon]);
    expect(rail.style.getPropertyValue('--ticker-accent').trim()).toBe('#00d4ff');
    expect(rail.dataset.tone).toBe('time');
  });

  it('is the fix: money never looks like the routine message', () => {
    /* An overlay is the strongest thing this room can say. Under one operator
       colour on every flag it looked exactly like "an event is starting". */
    const { rail } = mount([overlay]);
    expect(rail.dataset.tone).toBe('money');
    expect(rail.style.getPropertyValue('--ticker-accent').trim()).toBe(TONE_ACCENT.money);
    expect(rail.querySelector('.mtt-ticker__flag')?.textContent).toBe('OVERLAY');
  });
});

describe('the rail has a middle again', () => {
  it('is the regression: the background is a gradient, not a flat hex', () => {
    /* The stylesheet declared one from the first commit and lost to an inline
       single value on every render. */
    const { rail } = mount([soon]);
    expect(rail.style.background).toContain('linear-gradient');
    expect(rail.style.background).toContain('#0b1a33');
  });

  it('starts below whatever top chrome the route has', () => {
    const { rail } = mount([soon], { top: 56 });
    expect(rail.style.top).toBe('56px');
    // Only the strip that touches y = 0 pays the notch inset.
    expect(rail.style.paddingTop).toBe('0px');
  });
});

describe('a screen reader hears the news once, not sixty times a minute', () => {
  it('is the regression: the strip itself is not a live region', () => {
    const { rail } = mount([soon]);
    expect(rail.getAttribute('aria-live')).toBeNull();
    expect(rail.getAttribute('role')).toBeNull();
  });

  it('has exactly one live region, and it is the quiet one', () => {
    const { rail } = mount([soon]);
    const live = rail.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveClass('mtt-ticker__sr');
    expect(live[0].getAttribute('aria-live')).toBe('polite');
  });

  it('speaks to the minute, so the text does not change every second', () => {
    const { rail } = mount([soon]);
    const spoken = rail.querySelector('.mtt-ticker__sr')?.textContent || '';
    expect(spoken).toContain('3 Minutes');
    expect(spoken).not.toMatch(/\d:\d\d/);
    expect(spoken).toContain('Press To Register');
  });

  it('hides the scrolling copy from the reader entirely', () => {
    const { rail } = mount([soon]);
    expect(rail.querySelector('.mtt-ticker__scroll')?.getAttribute('aria-hidden')).toBe('true');
    expect(rail.querySelector('.mtt-ticker__flag')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('still names the button, so it can be operated', () => {
    mount([soon]);
    expect(screen.getByRole('button', { name: /Starting Soon/i })).toBeTruthy();
  });
});

describe('the controls do what they say', () => {
  it('opens the event that owns the bar', () => {
    const { rail, onOpen } = mount([soon]);
    fireEvent.click(rail.querySelector('.mtt-ticker__track') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(soon);
  });

  it('dismisses the event that owns the bar', () => {
    const { rail, onDismiss } = mount([soon]);
    fireEvent.click(rail.querySelector('.mtt-ticker__close') as HTMLElement);
    expect(onDismiss).toHaveBeenCalledWith(soon);
  });

  it('offers to open a table rather than to register for one', () => {
    const table = tableOpeningItem('tbl1', 'Table 4', 'plo4', NOW);
    const { rail } = mount([table]);
    expect(rail.querySelector('.mtt-ticker__cta')?.textContent).toBe('OPEN');
  });

  it('says what pressing it does, which nothing on the old bar did', () => {
    const { rail } = mount([soon]);
    expect(rail.querySelector('.mtt-ticker__cta')?.textContent).toBe('REGISTER');
  });
});

describe('the separator cannot be typed by an operator', () => {
  it('draws a pip between announcements instead of writing a bullet', () => {
    /* A club typed a bullet into a tournament name - "DSS Saturday $11 NLH
       Daily - 11 AM CT" arrived with one - and the bar used the same character
       to separate whole announcements, so a reader could not tell where one
       ended. */
    const second = startingSoonItem({
      id: 't2',
      name: 'Nightly Turbo',
      startsAt: NOW + 60_000,
      clubId: 'club-1',
      buyIn: 4,
      buyInFee: 1,
      registered: 8,
      isRegistered: false,
    });
    const { rail } = mount([soon, second]);
    const copy = rail.querySelector('.mtt-ticker__msg') as HTMLElement;
    expect(copy.querySelectorAll('.mtt-ticker__pip')).toHaveLength(1);
    expect(copy.textContent).not.toContain('•');
  });
});

describe('the clock is its own element', () => {
  it('so tabular figures and the last-minute treatment can reach the digits', () => {
    const { rail } = mount([soon]);
    const clock = rail.querySelector('.mtt-ticker__clock');
    expect(clock?.textContent).toBe('3:30');
  });

  it('goes urgent under a minute, and only the digits do', () => {
    const closing = startingSoonItem({
      id: 't3',
      name: 'Turbo',
      startsAt: NOW + 40_000,
      clubId: 'club-1',
      buyIn: 4,
      buyInFee: 1,
      registered: 8,
      isRegistered: false,
    });
    const { rail } = mount([closing]);
    expect(rail.querySelector('.mtt-ticker__clock--urgent')).toBeTruthy();
    expect(rail.classList.contains('mtt-ticker--urgent')).toBe(false);
  });

  it('has no clock at all on a message that is not counting down', () => {
    const { rail } = mount([operatorItem('custom_messages', 0, 'Freeroll At 8')]);
    expect(rail.querySelector('.mtt-ticker__clock')).toBeNull();
    expect(rail.querySelector('.mtt-ticker__drain')).toBeNull();
  });
});

describe('nothing to say, nothing rendered', () => {
  it('renders null on an empty lane', () => {
    const { container } = render(
      <TickerRail
        items={[]}
        now={NOW}
        top={0}
        appearance={APPEARANCE}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

const CSS = readFileSync(
  resolve(__dirname, '../../src/components/tournament/TournamentStartingTicker.css'),
  'utf8'
);

describe('the stylesheet keeps the promises the render depends on', () => {
  it('travels one measured copy, never a percentage of the scroller', () => {
    /* `translateX(-50%)` is the dead-rail bug. It is a fraction of a container
       whose width changes with the number of copies, so it stopped being one
       copy the moment the copy count became variable. */
    // A keyframes block holds nested rules, so it is bounded by the block that
    // follows it rather than by the first closing brace.
    const frames = sliceBetween(CSS, '@keyframes mttScroll {', '@keyframes mttArrive');
    expect(frames).toContain('var(--ticker-travel');
    expect(frames).not.toContain('-50%');
  });

  it('paints the flag from the derived pair, never from a literal accent', () => {
    const flag = sliceCssRule(CSS, '.mtt-ticker__flag');
    expect(flag).toContain('var(--ticker-flag-bg');
    expect(flag).toContain('var(--ticker-flag-ink');
  });

  it('declares no background on the strip, because the render builds it', () => {
    /* The rule used to carry a three-stop gradient that an inline single hex
       beat on every render. Leaving it here would be a second source of truth
       that never wins. */
    const rail = sliceCssRule(CSS, '.mtt-ticker {');
    expect(rail).not.toContain('background:');
  });

  it('masks the viewport rather than the button, so the label survives', () => {
    /* A mask applies to every descendant. On the button it faded out the
       "REGISTER" label sitting at the right edge along with the message. */
    expect(sliceCssRule(CSS, '.mtt-ticker__viewport')).toContain('mask-image');
    expect(sliceCssRule(CSS, '.mtt-ticker__track {')).not.toContain('mask-image');
  });

  it('pauses for a keyboard, and has no hover twin to pause for a pointer', () => {
    /* no-hover-effects.law.test.ts is binding and this strip is not exempt.
       Readability is delivered by holding still when the message fits and by
       a pace normalised per pixel - see the header of the stylesheet. */
    expect(CSS).toContain('.mtt-ticker__track:focus-within .mtt-ticker__scroll');
    expect(CSS).not.toContain(':hover');
  });

  it('gives every number on the rail tabular figures', () => {
    expect(sliceCssRule(CSS, '.mtt-ticker {')).toContain('font-variant-numeric: tabular-nums');
  });
});
