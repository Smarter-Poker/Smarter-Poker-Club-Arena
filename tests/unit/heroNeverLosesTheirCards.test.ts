/**
 * THE HERO NEVER LOSES SIGHT OF THEIR OWN HAND.
 *
 * Dan 2026-08-26, verbatim: "I just sat down at a table, was dealt in, saw my
 * cards for a split second, they disappeared and didn't come back... hero can
 * NEVER EVER EVER lose access to seeing their hole cards."
 *
 * THREE FAULTS COMPOUNDED, and only the first is the "cause":
 *
 * 1. The engine-snapshot merge restored the hero's previously-delivered cards
 *    ONLY when the hero was `folded` or `all_in`:
 *
 *        const stillInThisHand = sp.status === 'folded' || sp.status === 'all_in';
 *
 *    A hero who is simply PLAYING has status 'active'. The engine scrubs the
 *    hero's own cards from every non-showdown snapshot on purpose, so the
 *    merge saw "no cards" on every snapshot AND every delta, skipped the
 *    restore, and wrote undefined over the hand the player was looking at.
 *    The first engine frame after the deal wiped it. That is the split second.
 *
 * 2. The recovery poll retired itself after ONE successful re-apply and only
 *    re-armed at HAND_STARTED — so the second wipe had nothing watching. That
 *    is what turned a flicker into "didn't come back".
 *
 * 3. `heroIsOutOfPlay` in SeatSlot hid the hero's row on a `sitting_out` /
 *    `away` status even when the hero was holding cards, and two paths can
 *    stamp those transiently (a resync reading a stale sitting-out ref, and
 *    the placeholder used on a frame where the roster omits the hero's seat).
 *
 * These are source-level assertions because reproducing them needs a live
 * engine, a websocket delta and a real deal — and because every one of the
 * three is a WIRING fact that types cannot see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Comments quote the deleted code at length, deliberately. Strip them, or the
   tombstone is mistaken for the thing it replaced. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
const read = (p: string) => strip(readFileSync(resolve(__dirname, '../..', p), 'utf8'));

const TABLE_PAGE = read('src/pages/TablePage.tsx');
const SEAT = read('src/components/table/SeatSlot.tsx');

describe('a snapshot carrying no hero cards means "no news"', () => {
  it('the restore is NOT gated on the hero having folded or gone all-in', () => {
    expect(
      TABLE_PAGE,
      'the phase gate is back: a live hero will be wiped on the next delta'
    ).not.toMatch(/stillInThisHand\s*=\s*sp\.status === 'folded'/);
  });

  it('the hand BOUNDARY is what expires a holding, not the hero status', () => {
    /* Item 9 (a stale holding must never be drawn over a hero with no hand)
       is still satisfied — by the hand number, which is the thing that
       actually changes between hands. */
    /* 2026-08-26: the boundary check was hoisted out of the hero branch (as
       cardHoldSameHand) so the same rule can also preserve OPPONENTS' revealed
       showdown hands across the post-hand hold. Same derivation, wider duty. */
    expect(TABLE_PAGE).toMatch(/const sameHand\s*=/);
    expect(TABLE_PAGE).toMatch(/const cardHoldNextHand = mapped\.handNumber \?\? 0;/);
    expect(TABLE_PAGE).toMatch(/const cardHoldPrevHand = prev\.handNumber \?\? 0;/);
    expect(TABLE_PAGE).toMatch(/cardHoldNextHand === cardHoldPrevHand/);
  });
});

describe('the recovery poll keeps watching while the hero is blind', () => {
  it('re-opens the watch whenever the hero is seated in a hand with no cards', () => {
    expect(TABLE_PAGE).toMatch(/heroIsBlind/);
    expect(TABLE_PAGE, 'nothing re-arms recovery when the cards go missing again').toMatch(
      /if \(heroIsBlind\) heroCardsRecoveredRef\.current = false;/
    );
  });

  it('does not retire on the flag alone', () => {
    /* `heroCardsRecoveredRef.current` used to be sufficient to clear the
       interval. It must now agree with what is actually on screen. */
    expect(TABLE_PAGE).toMatch(/heroCardsRecoveredRef\.current && !heroIsBlind/);
  });

  it('a sitting-out hero does not count as blind, so the poll can still rest', () => {
    // Otherwise the poll would run forever for a player who is not in a hand.
    expect(TABLE_PAGE).toMatch(/heroNow\.status !== 'sitting_out'/);
    expect(TABLE_PAGE).toMatch(/heroNow\.status !== 'away'/);
  });
});

describe('holding cards outranks the status line', () => {
  it('a hero with cards is never suppressed by sitting_out or away', () => {
    expect(SEAT).toMatch(/const heroHoldsCards\s*=/);
    expect(SEAT).toMatch(/!heroHoldsCards &&\s*\(player\.status === 'sitting_out'/);
  });

  it('the suppression still exists for a hero holding nothing', () => {
    // Item 9's actual requirement — do not delete the guard, just subordinate
    // it to the cards.
    expect(SEAT).toMatch(/heroIsOutOfPlay/);
  });
});

describe('the prior fixes in this area are still in place', () => {
  it('GAME_START still prefers a non-empty snapshot and preserves otherwise', () => {
    /* The 2026-08 bug: `sp.cards || existing` where `sp.cards` is `[]`, which
       is truthy, so the fallback could never fire. */
    expect(TABLE_PAGE).not.toContain('sp.cards || existing?.holeCards');
    /* Prettier wraps this ternary across four lines, so the assertion is
       whitespace-tolerant — a single-line regex here failed against correct
       code.

       2026-09-01: the preserve branch grew one condition in front of it. This
       merge runs on `requestResync()`, i.e. on the websocket sequence gap that
       is the very thing that loses HAND_STARTED, so it was the one path that
       could carry a previous hand's holding across a hand boundary. It now
       asks whether the board in the same payload disproves what it is about to
       carry. The property this test defends is unchanged and is still pinned:
       length decides, and when the snapshot carries nothing the hero's holding
       is PRESERVED rather than wiped. */
    expect(TABLE_PAGE).toMatch(
      /sp\.cards\?\.length\s*\?\s*sp\.cards\s*:\s*heroHoldIsExpired\(existing\?\.holeCards\)\s*\?\s*\[\]\s*:\s*existing\?\.holeCards/
    );
  });

  it('HAND_STARTED still clears the hero hand at the boundary', () => {
    // The one place cards SHOULD be emptied, and it re-arms the fetch.
    expect(TABLE_PAGE).toMatch(/holeCards: \[\], showCards: false/);
    expect(TABLE_PAGE).toMatch(/heroCardFetchRef\.current/);
  });
});
