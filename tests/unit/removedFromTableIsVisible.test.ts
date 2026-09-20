/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BEING REMOVED FROM A TABLE HAS TO BE VISIBLE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, from live play 2026-08-29, AFTER the five-minute eviction itself was
 * confirmed working:
 *
 *   "IT DOESN'T GIVE YOU A 'REMOVED FROM TABLE' NOTIFICATION, AND THE
 *    'SITTING OUT BUTTON' NEVER LEAVES THE TABLE."
 *
 * Two separate recoveries were supposed to prevent this — the `seat_left`
 * websocket event and the ten-second `table_seats` read — and BOTH were the
 * same six lines, copied. Every one of those six could complete without causing
 * a single re-render:
 *
 *     setTableState(prev => prev.heroSeat === 0 ? prev : { ...prev, heroSeat: 0 })
 *
 * A sitting-out player is NOT in the current hand's player list, so
 * `syncedHeroSeat` is 0 and `tableState.heroSeat` is COMMONLY ALREADY 0 by the
 * time the eviction lands. That line then returns `prev`, React bails, and no
 * render happens. The other five lines were one ref mutation and three
 * `setState` calls that were already at their target value.
 *
 * So the whole recovery ran, changed nothing observable, and the footer went on
 * rendering `sittingOutIdsRef.current.has(userId)` — a REF read during render,
 * which nothing re-renders on — for the rest of the session. Nothing removed
 * the hero from `tableState.players` either, so their avatar and SITTING OUT
 * badge stayed on the felt over a seat they no longer held.
 *
 * Three things are pinned here, because all three had to be true and only the
 * first two were ever attempted:
 *
 *   1. ONE recovery, not two copies that drift.
 *   2. It commits a NEW state object every time, so the render cannot be
 *      skipped, and it EMPTIES THE SEAT rather than only zeroing the claim.
 *   3. The one-shot notice flag is set only once the toast has actually gone
 *      out — it used to be set first, so any drop burned the flag and silenced
 *      the other path too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const readRaw = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TABLE_PAGE = strip(readRaw('src/pages/TablePage.tsx'));

describe('one recovery, shared by both paths', () => {
  it('exists as a single function', () => {
    expect(TABLE_PAGE).toMatch(/const applySeatRemoved = useCallback\(/);
  });

  it('the websocket path and the poll path both call it', () => {
    /* They were two copies of six lines and had ALREADY drifted: the poll's
       copy carried no per-reason wording, so a five-minute eviction that
       arrived by poll rather than by socket said only the generic sentence. */
    /* Counted as CALLS — `applySeatRemoved = useCallback(` and the dependency
       entry `applySeatRemoved]` deliberately do not match this pattern, so the
       number is the two recoveries and nothing else. */
    const calls = (TABLE_PAGE.match(/applySeatRemoved\(/g) || []).length;
    expect(calls, 'the websocket path and the poll path').toBe(2);
    // …and each is in the right place.
    /* Both now carry an `announce` decision: clearing the seat is always right,
       SAYING the player "was removed" is only right when they did not ask to
       leave (2026-09-05). */
    expect(TABLE_PAGE).toMatch(/applySeatRemoved\(reason,/);
    expect(TABLE_PAGE).toMatch(/applySeatRemoved\(evictionReasonRef\.current,/);
  });

  /*
   * CLEARING THE SEAT AND SAYING SO ARE TWO DIFFERENT JOBS (Dan 2026-09-05).
   *
   * The websocket path used to be gated `if (reason && ...)`, on the reasoning
   * that "a voluntary leave carries no reason, so this only ever speaks for
   * removals the player did not ask for". True of the leaver's own device,
   * which had already navigated away. False of their SECOND device, which held
   * the same seat and never heard anything: Dan left a cash game on desktop and
   * his phone went on showing the last dealt hand, then a "0.00 / SITTING OUT"
   * hero and "Seat Reserved, You'll Be Dealt In Next Hand" over a seat he had
   * already left.
   *
   * So the seat now clears for ANY seat_left addressed to this user, and
   * `reason` decides only whether there is anything to TELL them.
   */
  it('clears the seat for a voluntary leave too, and says nothing about it', () => {
    const start = TABLE_PAGE.indexOf('const d = evt.data as { user_id?: string; reason?: string }');
    expect(start, 'the seat_left handler has moved or gone').toBeGreaterThan(-1);
    const handler = TABLE_PAGE.slice(start, TABLE_PAGE.indexOf('applySeatRemoved(reason,') + 120);
    // The recovery must NOT be conditional on a reason being present.
    expect(handler).not.toMatch(/if \(reason && userId/);
    expect(handler).toMatch(/if \(userId && String\(d\?\.user_id\) === String\(userId\)\)/);
    // A voluntary leave clears the seat silently; a removal still explains itself.
    expect(handler).toMatch(/announce: Boolean\(reason\)/);
  });

  it('neither path still inlines the old six lines', () => {
    /* The exact line that made the recovery invisible. If it comes back
       anywhere, the bug comes back with it. */
    expect(TABLE_PAGE).not.toMatch(
      /setTableState\(\(prev\) => \(prev\.heroSeat === 0 \? prev : \{ \.\.\.prev, heroSeat: 0 \}\)\)/
    );
  });
});

describe('the recovery cannot be a no-op', () => {
  const fn = sliceEnclosingBlock(TABLE_PAGE, 'const applySeatRemoved = useCallback');

  it('always commits a new state object', () => {
    /* No `prev.heroSeat === 0 ? prev` bail. `heroSeat` being already 0 is the
       COMMON case here, not the rare one — a sat-out player is not in the
       hand — and returning `prev` for it is what made this invisible. */
    expect(fn).toMatch(/return \{ \.\.\.prev, heroSeat: 0, players \}/);
    expect(fn).not.toMatch(/prev\.heroSeat === 0 \? prev/);
  });

  it('empties the seat, not just the claim', () => {
    /* Nothing used to remove the hero from `tableState.players`, so their
       avatar and SITTING OUT badge stayed on the felt over a seat they no
       longer held — which is the half of Dan's report about the tag. */
    expect(fn).toMatch(/prev\.players\.map\(/);
    expect(fn).toMatch(/p\.id === heroId \? null : p/);
  });

  it('clears the state the footer actually reads', () => {
    expect(fn).toMatch(/setHeroSitsOutPerRow\(false\)/);
  });
});

describe('the notice is not lost by its own one-shot flag', () => {
  const fn = sliceEnclosingBlock(TABLE_PAGE, 'const applySeatRemoved = useCallback');

  it('sets the flag only after the toast is dispatched', () => {
    /* It used to be `bootNoticeShownRef.current = true` FIRST and the toast
       second, through `?.info?.()`. Any drop — a toast provider not yet
       mounted, a race on teardown — burned the one-shot and silenced the OTHER
       path too, permanently, for the rest of the session. */
    const flagAt = fn.indexOf('bootNoticeShownRef.current = true');
    const guardAt = fn.indexOf("typeof say === 'function'");
    expect(guardAt, 'the toast is checked before the flag is burned').toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(flagAt);
  });

  it('names the real reason when one is known', () => {
    /* The sentences moved to components/table/seatExitCopy on 2026-09-19 so a
       Diamond seat is told about its Diamonds; the page still asks the one
       table, keyed by the seat's asset, on both boot paths. */
    expect(TABLE_PAGE).toMatch(/bootExplanation\(reason, seatAsset\)/);
    const SEAT_EXIT_COPY = strip(readRaw('src/components/table/seatExitCopy.ts'));
    expect(SEAT_EXIT_COPY).toMatch(/sit_out_timeout:/);
    // …and the poll can still be specific when the socket told us why.
    expect(TABLE_PAGE).toMatch(/evictionReasonRef/);
  });
});

describe('the footer reads state, never a ref, at render time', () => {
  it('the sitting-out bar is gated on heroSitsOutPerRow', () => {
    /* A ref mutation schedules nothing. When the recovery deleted the hero from
       `sittingOutIdsRef` the footer had no reason to re-render, and every other
       line of that recovery was a setState already at its target value — so the
       bar kept saying "You Are Sitting Out", with an I'm Back button, over a
       seat the player no longer held. */
    const at = TABLE_PAGE.indexOf('data-state="sitting-out"');
    expect(at, 'the sitting-out footer has moved or gone').toBeGreaterThan(-1);
    const before = TABLE_PAGE.slice(TABLE_PAGE.lastIndexOf(') : ', at), at);
    expect(before).toMatch(/heroSitsOutPerRow/);
    expect(before).not.toMatch(/sittingOutIdsRef\.current\.has/);
  });
});
