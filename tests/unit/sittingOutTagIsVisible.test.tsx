/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OTHER PLAYERS CAN SEE THAT YOU ARE SITTING OUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "YOU ALSO NEED TO ADD A SITTING OUT TAG THAT OTHER USERS CAN
 * SEE AT THE TABLE WHEN A PLAYER IS SITTING OUT, OR IS FORCED TO SIT OUT FROM
 * CONNECTION ISSUES."
 *
 * There was no such tag. What existed was a CSS `::after` pseudo-element that
 * printed the word AWAY, scoped to BOTH `.seat--away` and `.seat--sitting_out`,
 * so the two states were indistinguishable — and, being a pseudo-element, it
 * was invisible to every test that might have noticed.
 *
 * Worse, the state behind it never arrived. `sittingOutIdsRef` in TablePage was
 * written in exactly two places (the mount-time seat read and the hero's own
 * tap) and the only `table_seats` subscription in the file unsubscribes itself
 * the moment play begins. So once a game was running, no client ever learned
 * that another player had sat out. The tag could not have shown even if it had
 * existed.
 *
 * Three things are pinned here: the badge renders and says what it means, AWAY
 * still means away, and the subscription that feeds it is ungated.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';
/* Structural windows, never byte counts — tests/helpers/sourceWindow.ts. */
import { sliceCssRule, sliceEnclosingBlock } from '../helpers/sourceWindow';

const seat = (over: Partial<SeatPlayer> = {}): SeatPlayer => ({
  id: 'v1',
  name: 'VILLAIN',
  stack: 1518,
  status: 'active',
  showCards: false,
  isHero: false,
  ...over,
});

const renderSeat = (over: Partial<SeatPlayer> = {}) =>
  render(
    <SeatSlot
      seatNumber={3}
      player={seat(over)}
      position={null}
      isActive={false}
      lastAction={null}
    />
  );

describe('the SITTING OUT tag', () => {
  it('renders on a sitting-out seat, in words', () => {
    const { container } = renderSeat({ status: 'sitting_out' });
    const badge = container.querySelector('.seat__sitout-badge');
    expect(badge, 'a sat-out seat must carry a visible tag').not.toBeNull();
    expect(badge!.textContent).toMatch(/SITTING OUT/i);
  });

  it('does not render on an active seat', () => {
    const { container } = renderSeat({ status: 'active' });
    expect(container.querySelector('.seat__sitout-badge')).toBeNull();
  });

  it('does not render on an away seat — AWAY still means away', () => {
    /* The two states were one word before this. Keeping them apart is the
       point: "stepped away" and "sat out" have different consequences (an away
       cash player is evicted after one SB and one BB; a sat-out one after five
       minutes or two orbits). */
    const { container } = renderSeat({ status: 'away' });
    expect(container.querySelector('.seat__sitout-badge')).toBeNull();
  });

  it('a disconnected seat says DISCONNECTED', () => {
    const { container } = renderSeat({ status: 'disconnected' });
    expect(container.querySelector('.seat__disconnect-label')?.textContent).toMatch(
      /DISCONNECTED/i
    );
  });

  it('the seat carries its status class either way', () => {
    const { container } = renderSeat({ status: 'sitting_out' });
    expect(container.querySelector('.seat--sitting_out')).not.toBeNull();
  });
});

describe('the CSS behind the tag', () => {
  const css = readFileSync(join(process.cwd(), 'src/components/table/SeatSlot.css'), 'utf8');

  it('the AWAY pseudo-element no longer covers sitting out', () => {
    /* This is the regression that made the two states one word. If the
       `::after` is ever re-scoped to `.seat--sitting_out`, a seat would print
       AWAY *and* the new badge on top of it. */
    expect(css).toMatch(/\.seat--away \.seat__info::after\s*\{/);
    expect(css).not.toMatch(/\.seat--sitting_out \.seat__info::after/);
  });

  it('the badge is declared exactly once', () => {
    /* ADDED 2026-08-29, and it is the assertion that matters most here.
       This file carried TWO `.seat__sitout-badge` rules at identical
       specificity, ~2600 lines apart. The LATER one won, and it dropped
       `max-width` and added `white-space: nowrap` — so on a 375px phone, where
       a seat is 58-66px wide, the badge overflowed onto its neighbours.

       The case below could not see any of that: `sliceCssRule` is
       `css.indexOf(selector)`, i.e. FIRST match, so it happily asserted against
       the rule the browser was ignoring and passed for as long as the bug
       shipped. A second declaration is the failure; assert on the count. */
    const declarations = css.match(/^\.seat__sitout-badge\s*\{/gm) || [];
    expect(
      declarations.length,
      'a second declaration silently overrides the first — that is how the mobile cap was lost'
    ).toBe(1);
  });

  it('the badge is styled and cannot swallow taps', () => {
    const block = sliceCssRule(css, '.seat__sitout-badge');
    // A seat is 58-66px wide on a 375px phone; the badge must not grow past it.
    expect(block).toMatch(/max-width:\s*100%/);
    // The HUD learned this the hard way: an overlay that takes pointer events
    // swallows taps aimed at the seat underneath it.
    expect(block).toMatch(/pointer-events:\s*none/);
  });
});

describe('the state that feeds the tag', () => {
  const tablePage = readFileSync(join(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');

  /* The whole effect body, bounded by its own braces rather than by a byte
     count — tests/helpers/sourceWindow.ts. `seat-sitout-` sits directly inside
     the useEffect arrow body, so one level out is that body. */
  const effect = sliceEnclosingBlock(tablePage, 'seat-sitout-');

  it('there is a table_seats subscription for the whole session', () => {
    /* The pre-existing `seat-first-roster` channel bails on `playHasBegun`, so
       it could never keep this current during a game. This one is separate. */
    expect(effect).toMatch(/table:\s*'table_seats'/);
    expect(effect).toMatch(/sittingOutIdsRef\.current\.(add|delete)/);
    // It must repaint, not merely record: a ref alone cannot re-render.
    expect(effect).toMatch(/setTableState/);
    // And it must clean up, or a table hop leaks a channel per visit.
    expect(effect).toMatch(/removeChannel\(channel\)/);
  });

  it('it is not gated on play having started', () => {
    /* This is the property that makes it different from the roster channel.
       If either name appears in this body, someone has re-introduced the gate
       that made the tag invisible during a game. */
    expect(effect).not.toMatch(/playHasBegun/);
    expect(effect).not.toMatch(/seatFirstBuyIn/);
  });

  it('a disconnected player is actually mapped to the disconnected status', () => {
    /* SeatSlot has rendered a DISCONNECTED label since FIX 186, but this
       mapping collapsed straight to 'active', so the branch was unreachable. */
    expect(tablePage).toMatch(/sp\.is_disconnected\s*\?\s*'disconnected'/);
  });
});
