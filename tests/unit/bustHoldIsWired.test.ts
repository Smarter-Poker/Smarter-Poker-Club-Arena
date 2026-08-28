/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE BUST HOLD MUST BE WIRED, NOT MERELY WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE INCIDENT (2026-08-26, third audit).
 *
 * `goToLobbyWithResultRef` had FOUR readers and ZERO writers. Every read is
 * `goToLobbyWithResultRef.current?.(...)`, so every one silently did nothing:
 *
 *   releaseBustHold        replaying a deferred elimination   -> no-op
 *   exitIfBusted           the hold's last-resort exit        -> no-op
 *   the roster fallback    status === 'eliminated'            -> no-op
 *   the rebuy decline      manual exit                        -> no-op
 *
 * A busted player got `heroSeat = 0` and NOTHING else — no SESSION_ENDED, no
 * TABLE_LEFT, no CLOSE_TABLE_TAB, no result card, no navigation. They sat at a
 * dead felt for the rest of the session. That is precisely the failure the bust
 * hold was written to prevent, and it shipped inside the fix for it.
 *
 * WHY NOTHING CAUGHT IT. Every spec guarding the hold asserts that the READ
 * appears in the source:
 *
 *   expect(src).toMatch(/goToLobbyWithResultRef\.current\?\.\(pending\.position/)
 *
 * A ref that is never assigned satisfies that forever. The feature was 100%
 * dead and not one assertion moved.
 *
 * WHAT THIS FILE DOES INSTEAD. TablePage is ~15,000 lines and cannot be
 * rendered in jsdom, so this is still a source-level check — but it checks the
 * property that was actually broken (is the wiring complete?) rather than the
 * property that was trivially true (does the call site exist?).
 *
 * THE RULE IT ENFORCES: every optional-call ref in this file must have at least
 * one ASSIGNMENT. Generalised deliberately — the same shape of bug can appear in
 * any of them, and a rule that only knew about this one ref would not have
 * caught this one either, because nobody thought to look.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceStatement } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** Comments quote the very things these tests ban. Never match against them. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const TABLE_PAGE = 'src/pages/TablePage.tsx';

describe('every callable ref in TablePage is actually assigned', () => {
  const src = code(read(TABLE_PAGE));

  /**
   * Refs invoked as `xRef.current?.(...)` — i.e. refs whose whole purpose is to
   * be called. A missing assignment on one of these is invisible at runtime
   * (optional chaining swallows it) and invisible to TypeScript (the type
   * permits null), which is exactly why it needs a test.
   */
  const calledRefs = new Set(
    Array.from(src.matchAll(/\b(\w+Ref)\.current\?\.\(/g)).map((m) => m[1])
  );

  it('finds the refs it is supposed to be checking', () => {
    // A matcher that silently matches nothing passes vacuously forever.
    expect(calledRefs.size, 'the pattern must find callable refs').toBeGreaterThan(0);
    expect(calledRefs.has('goToLobbyWithResultRef'), 'the ref from the incident').toBe(true);
  });

  for (const ref of [
    'goToLobbyWithResultRef',
    'exitIfBustedRef',
    'beginBustHoldRef',
    'releaseBustHoldRef',
  ]) {
    it(`${ref} has at least one assignment`, () => {
      expect(calledRefs.has(ref), `${ref} must still be called somewhere`).toBe(true);
      const assigned = new RegExp(`${ref}\\.current\\s*=`).test(src);
      expect(
        assigned,
        `${ref} is CALLED but never ASSIGNED — every call site is \`?.()\` so it ` +
          `fails silently. This is the 2026-08-26 incident verbatim.`
      ).toBe(true);
    });
  }

  it('no callable ref anywhere in the file is left unassigned', () => {
    const orphans = [...calledRefs].filter((ref) => !new RegExp(`${ref}\\.current\\s*=`).test(src));
    expect(
      orphans,
      `these refs are invoked with \`?.()\` but never assigned, so every call is a ` +
        `silent no-op: ${orphans.join(', ')}`
    ).toEqual([]);
  });
});

describe('the bust hold reaches a real exit', () => {
  const src = code(read(TABLE_PAGE));

  it('the exit function is published to the ref the hold reads', () => {
    /* `goToLobbyWithResult` must stay declared inside the realtime subscription
       — it closes over `table` and `exitStarted` — so the ref is the only
       bridge to the component body. Assert the bridge exists. */
    expect(src).toMatch(/const goToLobbyWithResult = \(/);
    expect(src).toMatch(/goToLobbyWithResultRef\.current = goToLobbyWithResult;/);
  });

  it('and is cleared when that subscription tears down', () => {
    // A hold released after teardown must not navigate a page that has moved on.
    expect(src).toMatch(/goToLobbyWithResultRef\.current = null;/);
  });

  it('the exit does the four things a manual leave does', () => {
    /* The comment at goToLobbyWithResult records that an earlier version
       published the card and navigated and nothing else, leaving the finished
       table in the player's tab bar with their status still "playing at". */
    const body = sliceStatement(src, 'const goToLobbyWithResult = (');
    expect(body).toMatch(/SESSION_ENDED/);
    expect(body).toMatch(/clearPlayingAt/);
    expect(body).toMatch(/TABLE_LEFT/);
    expect(body).toMatch(/CLOSE_TABLE_TAB/);
  });

  it('a confirmed rebuy cannot be ejected by the stack race', () => {
    /* `processRebuy` resolving is the SERVER acknowledging the purchase; the new
       stack arrives afterwards over the engine feed. Guarding `exitIfBusted` on
       `stack > 0` alone is a race against local state that has not caught up,
       and the loser of that race is a player who has just paid. */
    expect(src).toMatch(/rebuyJustSucceededRef\.current = true;/);
    expect(src).toMatch(/if \(rebuyJustSucceededRef\.current\) return;/);
    // ...and it must be cleared, or a LATER bust could never exit.
    expect(src).toMatch(/rebuyJustSucceededRef\.current = false;/);
  });

  it('the modal backstop installs a real timer, not just a constant', () => {
    /* The old spec asserted only that the string `releaseBustHoldRef.current?.()`
       appeared somewhere in a 15,000-line file, which the rebuy re-arm satisfied
       just as happily as the backstop. */
    expect(src).toMatch(/const BUST_HOLD_MODAL_MS = /);
    expect(src).toMatch(/hold\.deadline = setTimeout\([\s\S]{0,600}BUST_HOLD_MODAL_MS/);
  });
});
