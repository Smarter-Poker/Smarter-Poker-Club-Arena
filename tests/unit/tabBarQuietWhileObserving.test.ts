/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * A TAB YOU ARE ONLY WATCHING DOES NOT MOVE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-26: "THE ACTION BAR ON TOP OF THE PLAYING PAGE SHOULD NOT EVER
 * FLASH OR CHANGE ANYTHING WHEN YOUR ON A TABLE OBSERVING. IT SHOULD JUST SAY
 * THE GAME AND THE STAKES."
 *
 * Nearly everything on the pill is HERO state -- your cards, your turn, your
 * clock, your last action -- and a spectator has none of it, so those parts
 * were already still. `pot` is the exception: it belongs to the TABLE, so
 * watching a game you are not in made the sub-line flip between "Pot 14" and
 * the stakes on every street of every hand.
 *
 * THE DANGEROUS DIRECTION IS THE OTHER ONE. Suppressing a SEATED player's turn
 * indicator or five-second flash means they sit there missing a decision the
 * tab exists to warn them about, and that costs real chips. So the observer
 * path is gated on the ABSENCE of every signal of involvement, not on the
 * presence of one flag that might not have landed yet. Both directions are
 * pinned below.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../src/components/table/TableTabBar.tsx'), 'utf8');

/** The per-tab render body. */
const TAB = SRC.slice(SRC.indexOf('const isActive = tab.id === activeTabId;'));
const CSS_TAB_BAR = readFileSync(
  resolve(__dirname, '../../src/components/table/TableTabBar.css'),
  'utf8'
);

describe('what makes a tab count as observed', () => {
  it('requires every signal of involvement to be absent', () => {
    const decl = TAB.slice(
      TAB.indexOf('const observing ='),
      TAB.indexOf('// Urgency is a property')
    );
    // A seat is the primary signal...
    expect(decl).toMatch(/tab\.seated !== true/);
    // ...but never the only one, because it can lag behind reality.
    expect(decl).toMatch(/!tab\.isMyTurn/);
    expect(decl).toMatch(/!heroHasCards/);
    expect(decl).toMatch(/!tab\.decisionKind/);
    expect(decl).toMatch(/tab\.timeBankSecondsLeft === undefined/);
    // All of them, together. An OR here would silence a seated player.
    expect(decl).not.toMatch(/\|\|/);
  });

  it('carries the seat through from the page that knows it', () => {
    const PAGE = readFileSync(resolve(__dirname, '../../src/pages/MultiTablePage.tsx'), 'utf8');
    expect(PAGE).toMatch(/seated: t\.seated/);
    expect(SRC).toMatch(/seated\?: boolean;/);
  });
});

describe('an observed tab shows the game and the stakes, and nothing that moves', () => {
  it('does not show the live pot (the one table-level value on the pill)', () => {
    expect(TAB).toMatch(
      /const potToShow =\s*\n?\s*!observing && tab\.pot !== undefined && tab\.pot > 0 \? tab\.pot : null/
    );
    // and the sub-line falls through to the stakes
    expect(TAB).toMatch(/potToShow !== null \? \(/);
    expect(TAB).toMatch(
      /tab\.stakes && <span className="table-tab-bar__tab-sub">\{tab\.stakes\}<\/span>/
    );
  });

  it('does not flash an action chip or a win/loss pulse', () => {
    expect(TAB).toMatch(/const flash = observing \? undefined : actionFlash\[tab\.id\]/);
    expect(TAB).toMatch(/const result = observing \? undefined : resultFlash\[tab\.id\]/);
  });

  it('does not run the five-second flash or the timer bar', () => {
    expect(TAB).toMatch(/const anySecondsLeft = observing\s*\n?\s*\? undefined/);
    expect(TAB).toMatch(/const isMyTurn = !observing && tab\.isMyTurn/);
    expect(TAB).toMatch(/\{isMyTurn && tab\.turnProgress !== undefined && \(/);
  });

  /* The turn dot this beat used to pin (`{!isActive && isMyTurn && (`) was
     DELETED on 2026-08-28 — Dan: the pill shows the cards and the timer bar and
     nothing else. Asserting its absence is what keeps it deleted; observing is
     no longer a special case for it, because there is no case. */
  it('has no countdown badge left to silence', () => {
    /* Matched on the RENDERED className, not on any mention of the string: the
       comment that records why the badge was deleted names the class, and an
       assertion that forbids the name outright would forbid explaining itself. */
    expect(TAB, 'the turn badge must not be rendered').not.toMatch(
      /className=["'{`][^"'}`]*table-tab-bar__turn-dot/
    );
    expect(CSS_TAB_BAR, 'the badge CSS must go with the markup').not.toMatch(
      /^\.table-tab-bar__turn-dot\s*\{/m
    );
  });

  it('does not take the decision, time bank, folded or mini-card branches', () => {
    expect(TAB).toMatch(/const decisionLabel =\s*\n?\s*!observing && tab\.decisionKind/);
    expect(TAB).toMatch(/const timeBankLeft = observing \? undefined : tab\.timeBankSecondsLeft/);
    expect(TAB).toMatch(/const hasCards = !observing && heroHasCards/);
    expect(TAB).toMatch(/!observing && tab\.folded && 'table-tab-bar__tab--folded'/);
  });

  it('drops every state modifier class an observed tab could otherwise wear', () => {
    for (const cls of [
      "'table-tab-bar__tab--decision'",
      "'table-tab-bar__tab--folded'",
      "'table-tab-bar__tab--turn'",
    ]) {
      const line = TAB.split('\n').find((l) => l.includes(cls) && l.includes('&&'));
      expect(line, `${cls} must be gated`).toBeTruthy();
      expect(line).toMatch(/!observing|isMyTurn/);
    }
  });
});

describe('a SEATED player loses nothing', () => {
  it('every suppression is written as `!observing && <the original condition>`', () => {
    /* The point of the shape: with `observing === false` each expression
       reduces to exactly what it was before this change, so a seated player's
       pill behaves identically. A rewrite that changed the seated path too
       would show up here as a missing original condition. */
    expect(TAB).toMatch(/!observing && tab\.pot !== undefined && tab\.pot > 0/);
    expect(TAB).toMatch(/!observing && tab\.decisionKind/);
    expect(TAB).toMatch(/!observing && heroHasCards/);
    expect(TAB).toMatch(/!observing && tab\.isMyTurn/);
  });

  it('urgency still follows the clock rather than which tab is focused', () => {
    // The 2026-08-21 rule: a background table's bar still goes red.
    expect(TAB).toMatch(
      /const isUrgent =\s*\n?\s*isMyTurn && tab\.timeRemaining !== undefined && tab\.timeRemaining < 10/
    );
  });
});
