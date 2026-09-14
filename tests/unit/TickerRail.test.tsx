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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/* ── THE CLOCK READS THE WALL CLOCK NOW (2026-09-14) ───────────────────────
   TickerClock owns its own second, so it seeds itself from `Date.now()` and
   not from the `now` prop the rail is handed. In a browser those are the same
   clock. In a test they are only the same clock if we say so - and when they
   disagree the countdown renders the distance to an epoch in the year 2027,
   which is how this was caught.

   DATE ONLY. `setInterval` stays real: none of these tests advance time, and a
   faked scheduler here would also swallow React's, which is a different bug to
   debug on a different day. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it('names the news on the chip, in both lengths', () => {
    /* Both forms ship and the stylesheet shows one. On a 375px viewport the
       full flag took 185 pixels - half the screen - to say the least
       surprising thing on the bar. */
    const { rail } = mount([soon]);
    expect(rail.querySelector('.mtt-ticker__flag-full')?.textContent).toBe('STARTING SOON');
    expect(rail.querySelector('.mtt-ticker__flag-short')?.textContent).toBe('SOON');
  });

  it('hides one of the two flag forms at every width', () => {
    expect(sliceCssRule(CSS, '.mtt-ticker__flag-short')).toContain('display: none');
    expect(CSS).toContain('.mtt-ticker__flag-full');
    expect(CSS).toMatch(/max-width: 560px/);
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
    expect(rail.querySelector('.mtt-ticker__flag-full')?.textContent).toBe('OVERLAY');
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
    /* Braced anchor: `.mtt-ticker__flag::after` (the gloss) is declared above
       the rule itself, and an unbraced needle matches the pseudo-element. */
    const flag = sliceCssRule(CSS, '.mtt-ticker__flag {');
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

describe('the photograph of 2026-09-13', () => {
  /* Dan sent a picture of the live rail. It read, verbatim:
       "Starts In0:19"                          - a space had been eaten
       "$100 Freeroll - 12:00 PM StartREGISTER" - the label sat on the message
       "Buy-In Free Buy"                        - a field name on a label
     All three had shipped, all three were invisible to a suite that asserted
     text content, and all three are pinned below by the STRUCTURE that caused
     them rather than by the string they produced. */

  it('keeps the clock INSIDE its field, which is what saves the space', () => {
    /* THE CAUSE. The three pieces of a field used to be sibling spans, and
       `.mtt-ticker__item` is inline-flex, so each was a flex item and its own
       trailing whitespace was trimmed at the line-box edge. `textContent`
       cannot see that - it concatenates either way - so the assertion has to
       be about the boxes, not the text. */
    const { rail } = mount([soon]);
    const clock = rail.querySelector('.mtt-ticker__clock') as HTMLElement;
    expect(clock).toBeTruthy();
    expect(clock.parentElement).toHaveClass('mtt-ticker__field');
    // And the space the author wrote is still in the field's own text.
    expect(clock.parentElement?.textContent).toMatch(/Starts In 3:30$/);
  });

  it('declares a field as inline, so its contents are not flex items', () => {
    expect(sliceCssRule(CSS, '.mtt-ticker__field')).toContain('display: inline');
    // The item above it stays a flex row - that is what lays the pips out.
    expect(sliceCssRule(CSS, '.mtt-ticker__item')).toContain('inline-flex');
  });

  it('seats the call to action beside the message, never over it', () => {
    /* A scrim cannot fix an overlap: the text is still there and still
       moving. As a flex sibling the viewport is simply narrower. */
    const { rail } = mount([soon]);
    const cta = rail.querySelector('.mtt-ticker__cta') as HTMLElement;
    const viewport = rail.querySelector('.mtt-ticker__viewport') as HTMLElement;
    expect(cta.parentElement).toBe(viewport.parentElement);
    const rule = sliceCssRule(CSS, '.mtt-ticker__cta');
    expect(rule).not.toContain('position: absolute');
    expect(rule).toContain('flex: 0 0 auto');
  });
});

describe('#SMARTERCASINOREALISM - the rail is a made object', () => {
  /* docs/laws.d/realism-is-one-vocabulary is binding: the palette and the
     three light effects are declared once on :root in club-engine.css, and a
     surface that wants material reaches for --realism-* rather than inventing
     another palette. Every var carries a literal fallback, which that law
     requires too. */

  it('is built from the three light effects, not from private shadows', () => {
    const rule = sliceCssRule(CSS, '.mtt-ticker {');
    expect(rule).toContain('--realism-bevel');
    expect(rule).toContain('--realism-cavity');
    expect(rule).toContain('--realism-lift');
  });

  it('has an edge of gunmetal rather than an outline of cyan', () => {
    expect(sliceCssRule(CSS, '.mtt-ticker {')).toContain('--realism-gunmetal');
  });

  it('carries a specular line, the way a milled button does', () => {
    const spec = sliceCssRule(CSS, '.mtt-ticker::after');
    expect(spec).toContain('height: 1px');
    expect(spec).toContain('linear-gradient');
  });

  it("keeps the club's colour on the face and the material off it", () => {
    /* Material is light, not hue. The operator still owns the gradient; the
       accent reaches the material as one variable and the stylesheet decides
       where it lands. An inline box-shadow would beat the stylesheet, which is
       exactly how the designed gradient was lost for three weeks. */
    const RAIL = readFileSync(
      resolve(__dirname, '../../src/components/tournament/TickerRail.tsx'),
      'utf8'
    );
    expect(RAIL).toContain("'--ticker-glow'");
    expect(RAIL).not.toMatch(/boxShadow:/);
    expect(RAIL).toContain('railBackground(appearance.backgroundColor)');
    expect(sliceCssRule(CSS, '.mtt-ticker__flag {')).toContain('--ticker-flag-bg');
  });

  it('gives every realism token a literal fallback', () => {
    const used = [...CSS.matchAll(/var\(--realism-[a-z-]+[^)]*\)/g)].map((m) => m[0]);
    expect(used.length).toBeGreaterThan(8);
    for (const v of used) {
      expect(v, `${v} has no fallback`).toContain(',');
    }
  });

  it('still adds no hover rule, because that law outranks this one', () => {
    expect(CSS).not.toContain(':hover');
  });
});

describe('what the harness showed, on a screen', () => {
  it('offers no button when there is nowhere to go', () => {
    /* The CLUB UPDATE line was offering "REGISTER" on an operator's own
       message - a promise of a door that does not exist. */
    const { rail } = mount([operatorItem('custom_messages', 0, 'Freeroll At 8 PM')]);
    expect(rail.querySelector('.mtt-ticker__cta')).toBeNull();
  });

  it('still offers one when there is', () => {
    expect(mount([soon]).rail.querySelector('.mtt-ticker__cta')?.textContent).toBe('REGISTER');
    const table = tableOpeningItem('tbl1', 'Table 4', 'plo4', NOW);
    expect(mount([table]).rail.querySelector('.mtt-ticker__cta')?.textContent).toBe('OPEN');
  });

  it('drains across the item own window, not a hard-coded five minutes', () => {
    /* A registration closing in 4:12 drew a nearly-full bar and a start in
       0:19 drew a stub, because everything was scaled to 300 seconds. */
    const soonRail = mount([soon]).rail;
    const drain = soonRail.querySelector('.mtt-ticker__drain') as HTMLElement;
    // 210s left of a 300s window.
    expect(Math.round(parseFloat(drain.style.width))).toBe(70);
  });

  it('draws no drain for an announcement that is not counting anything', () => {
    const { rail } = mount([operatorItem('maintenance', 0, 'Back At 3 AM')]);
    expect(rail.querySelector('.mtt-ticker__drain')).toBeNull();
  });

  it('marks the end of a copy so a wrapped loop does not read as one sentence', () => {
    /* On a phone the second copy followed the first with only padding between
       them: "…, All Members Welcome      Freeroll At 8 PM". */
    expect(sliceCssRule(CSS, '.mtt-ticker__msg::after')).toContain('content:');
    expect(CSS).toContain(".mtt-ticker[data-static='true'] .mtt-ticker__msg::after");
  });
});

describe('the Phase 1 audit', () => {
  it('leaves no copy-pip under reduced motion, where there is no second copy', () => {
    /* The pip separates two copies of a looping lane. Reduced motion hides the
       second copy and truncates the first, so the pip would sit after an
       ellipsis as a mark with nothing on the other side of it. */
    const RM = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(RM).toContain('.mtt-ticker__msg::after');
    expect(RM.slice(RM.indexOf('.mtt-ticker__msg::after'))).toMatch(/display: none/);
  });

  it('never abbreviates a POTENTIAL overlay into a claim of certainty', () => {
    const potential = overlayItem({
      id: 'o2',
      name: 'Midweek Major',
      tier: 'potential',
      overlay: 3000,
      guarantee: 10000,
      prizePool: 4000,
      entered: 20,
      entriesToClose: 15,
      startsAt: NOW + 600_000,
    });
    expect(potential.flag).toBe('POTENTIAL OVERLAY');
    expect(potential.flagShort).not.toBe('OVERLAY');
  });

  it('gives every announcement a short flag, for the phone', () => {
    const all = [
      soon,
      overlay,
      tableOpeningItem('tbl1', 'Table 4', 'plo4', NOW),
      operatorItem('maintenance', 0, 'Back At 3 AM'),
      operatorItem('custom_messages', 0, 'Welcome'),
    ];
    for (const entry of all) {
      expect(entry.flagShort, entry.flag).toBeTruthy();
      expect(entry.flagShort.length, entry.flag).toBeLessThanOrEqual(entry.flag.length);
    }
  });
});
