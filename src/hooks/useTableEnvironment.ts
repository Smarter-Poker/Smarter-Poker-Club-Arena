import { arenaDisplayText } from '../lib/arenaDisplay/text';
import { useEffect, type RefObject } from 'react';
import { IS_NATIVE_BUILD, isNativePlatform } from '../lib/appBase';
import {
  PHONE_TABLE_LAYOUT_WIDTH_PX,
  PHONE_TABLE_MAX_DEVICE_WIDTH_PX,
} from '../components/table/tableGeometry';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERY EFFECT IN HERE IS DOCUMENT-WIDE, AND FOUR TABLES RUN IT AT ONCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MultiTablePage keeps up to four TablePage instances MOUNTED and laid out at
 * the same time — an inactive slot is only `pointer-events: none`, not
 * `display: none`. So every hook in this file runs up to four times over, and
 * three of the four effects below reach for something there is exactly one of:
 * the document title, the viewport meta tag, and `.table-page`.
 *
 * That is not a hypothetical. Two live defects were found here on 2026-08-27
 * while tracking down the felt resizing:
 *
 *   1. `useTableEnvironment(tableId)` was called TWICE, on consecutive lines in
 *      TablePage.tsx. The viewport effect stores the meta tag's ORIGINAL content
 *      so it can put it back on unmount; the second call ran after the first had
 *      already overwritten the tag, so it stored the POKER viewport as the
 *      "original" and restored that on the way out. Leaving a table could leave
 *      the entire app pinned at `maximum-scale=1, user-scalable=no` — no
 *      pinch-zoom anywhere, until a reload. The same shape happens with four
 *      tables even without the duplicate, which is what the refcount below is
 *      for.
 *
 *   2. The background-tab effect wrote its class onto
 *      `document.querySelector('.table-page')` — the FIRST such element in the
 *      document. With four tables open, all four instances fought over table
 *      one's root and tables two to four were never paused at all. It takes the
 *      caller's own root now.
 *
 * IF YOU ADD AN EFFECT HERE, ask what it does when four copies run it. If the
 * answer involves a document-level singleton, it belongs behind the refcount.
 *
 * What this hook does:
 * 1. Sets document title
 * 2. Locks mobile viewport (prevents pinch-zoom) — refcounted
 * 3. Acquires Wake Lock (prevents screen dimming)
 * 4. Adds background tab detection for CSS pausing — scoped to `pageRootRef`
 *
 * @param pageRootRef the caller's OWN `.table-page` element. Optional only so
 *        the hook stays usable outside TablePage; when it is omitted the
 *        background-tab pause simply does not apply, which is the safe failure
 *        (animations keep running) rather than pausing somebody else's table.
 */

/**
 * The viewport meta tag is one tag for the whole document, so the first table to
 * arrive owns it and the last one to leave gives it back. A per-instance
 * save/restore cannot be right when the instances overlap: whichever unmounts
 * last wins, and it is holding whatever the tag said when IT mounted.
 */
let viewportHolders = 0;
let viewportOriginal: string | null = null;
let viewportMetaCreated: HTMLMetaElement | null = null;

/**
 * A PHONE LAYS THE TABLE OUT AT THE DESKTOP'S WIDTH (Dan, 2026-10-25).
 *
 * Dan, with phone screenshots beside a 603px-wide desktop window: "MAKE THE
 * MOBILE LAYOUT AND CHIP POSITIONS THE SAME AS DESKTOP AND IPAD", "SEATING
 * LOCATIONS NEED TO BE THE SAME AS WELL. AND NOTICE ON DESKTOP THE SIZE OF THE
 * AVATARS, AND HOW THEY REACH THE TOP OF THE PAGE AND 'CUT OFF' THATS PERFECT,
 * MAXIMIZE ALL THE SPACE WITHOUT 'CROWDING THE SCREEN'", and "THIS IS HOW IT
 * SHOULD LOOK ON MOBILE".
 *
 * Below 481px the table had its own layout - a narrower felt, compact pods,
 * seats pulled into outer lanes, bets on the rail - and it had drifted from
 * desktop and iPad in every one of those. Rather than keep a second layout in
 * step with the first, a portrait phone now lays the table out at
 * PHONE_TABLE_LAYOUT_WIDTH_PX, exactly as that desktop window does, and the
 * browser scales the finished page down to the phone's width. Seat positions,
 * avatar sizes, the top-cap crop, the felt and the bet chips are therefore the
 * desktop's own, in the desktop's own proportions.
 *
 * Only while a table is the tab in front (`isActive`): a "+" tab showing a
 * World Hub page, the lobby and every other route keep the device's own width.
 * Landscape keeps it too, since the desktop window being matched is portrait.
 * Pinned by tests/a-phone-lays-the-table-out-like-desktop.law.test.ts.
 */
export { PHONE_TABLE_LAYOUT_WIDTH_PX, PHONE_TABLE_MAX_DEVICE_WIDTH_PX };
let desktopLayoutHolders = 0;
const POKER_VIEWPORT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

function devicePortraitPhoneWidth(): number | null {
  if (typeof window === 'undefined' || typeof screen === 'undefined') return null;
  const short = Math.min(screen.width || 0, screen.height || 0);
  if (!(short > 0) || short > PHONE_TABLE_MAX_DEVICE_WIDTH_PX) return null;
  const type = (screen.orientation as ScreenOrientation | undefined)?.type;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  // window.orientation first: iOS keeps screen.width/height portrait in both
  // orientations, and it is the one reading every phone browser agrees on.
  const portrait =
    typeof legacy === 'number'
      ? Math.abs(legacy) !== 90
      : type
        ? type.startsWith('portrait')
        : (screen.height || 0) >= (screen.width || 0);
  return portrait ? short : null;
}

/** The viewport content the table wants right now. */
export function tableViewportContent(phoneWidth: number | null, desktopLayout: boolean): string {
  if (!desktopLayout || !phoneWidth) return POKER_VIEWPORT;
  const scale = Math.round((phoneWidth / PHONE_TABLE_LAYOUT_WIDTH_PX) * 10000) / 10000;
  return `width=${PHONE_TABLE_LAYOUT_WIDTH_PX}, initial-scale=${scale}, minimum-scale=${scale}, maximum-scale=${scale}, user-scalable=no, viewport-fit=cover`;
}

// WebKit can keep svh at the pre-meta physical layout height after the phone
// switches to its scaled desktop width. Capture that stable dimension before
// switching, then express it in the desktop layout's CSS pixels. Keep one
// capture for all mounted tables; browser chrome and hand state cannot resize it.
let phoneStableViewportHeight: number | null = null;
let phoneSmallHeightBeforeScale: number | null = null;
let phoneStableUnitsFollowLayout: boolean | null = null;
function readSmallViewportHeight(): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;width:0;height:100svh';
  document.documentElement.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}
function refreshStableTableViewport() {
  if (
    !desktopLayoutHolders ||
    !devicePortraitPhoneWidth() ||
    phoneStableViewportHeight === null ||
    phoneSmallHeightBeforeScale === null ||
    Math.abs(document.documentElement.clientWidth - PHONE_TABLE_LAYOUT_WIDTH_PX) > 2
  )
    return;
  const height = readSmallViewportHeight();
  if (!(height > 0)) return;
  // Identify the browser's unit behavior after the meta resize, rather than
  // assuming every browser shares WebKit's stale-scale behavior.
  if (phoneStableUnitsFollowLayout === null) {
    if (Math.abs(height - phoneStableViewportHeight) < 1) phoneStableUnitsFollowLayout = true;
    else if (Math.abs(height - phoneSmallHeightBeforeScale) < 1)
      phoneStableUnitsFollowLayout = false;
    else return;
  }
  const visual = window.visualViewport;
  const physicalWidth = visual ? visual.width * visual.scale : devicePortraitPhoneWidth();
  if (!(physicalWidth && physicalWidth > 0)) return;
  const next = Math.round(
    phoneStableUnitsFollowLayout ? height : (height * PHONE_TABLE_LAYOUT_WIDTH_PX) / physicalWidth
  );
  if (Math.abs(next - phoneStableViewportHeight) < 0.5) return;
  phoneStableViewportHeight = next;
  document.documentElement.style.setProperty(STABLE_TABLE_VIEWPORT_HEIGHT, `${next}px`);
}
const STABLE_TABLE_VIEWPORT_HEIGHT = '--sp-table-stable-viewport-h';
function writeTableViewport() {
  if (typeof document === 'undefined') return;
  if (viewportHolders === 0) {
    phoneStableViewportHeight = null;
    phoneSmallHeightBeforeScale = null;
    phoneStableUnitsFollowLayout = null;
    document.documentElement.style.removeProperty(STABLE_TABLE_VIEWPORT_HEIGHT);
    return;
  }
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const phoneWidth = devicePortraitPhoneWidth();
  if (phoneWidth && desktopLayoutHolders > 0) {
    if (phoneStableViewportHeight === null) {
      const width = document.documentElement.clientWidth;
      const height = readSmallViewportHeight();
      phoneSmallHeightBeforeScale = height;
      if (width > 0 && height > 0)
        phoneStableViewportHeight =
          Math.round(((height * PHONE_TABLE_LAYOUT_WIDTH_PX) / width) * 1000) / 1000;
    }
    if (phoneStableViewportHeight !== null)
      document.documentElement.style.setProperty(
        STABLE_TABLE_VIEWPORT_HEIGHT,
        `${phoneStableViewportHeight}px`
      );
  } else {
    document.documentElement.style.removeProperty(STABLE_TABLE_VIEWPORT_HEIGHT);
  }
  const next = tableViewportContent(phoneWidth, desktopLayoutHolders > 0);
  if (meta.getAttribute('content') !== next) {
    meta.setAttribute('content', next);
    requestAnimationFrame(refreshStableTableViewport);
  }
}

/**
 * THE WAKE LOCK IS ALSO ONE PER DOCUMENT (2026-08-28).
 *
 * The header above states the rule — "if the answer involves a document-level
 * singleton, it belongs behind the refcount" — and the viewport tag obeys it.
 * The wake lock did not: every mounted table requested its own sentinel and
 * attached its own `visibilitychange` listener, so four tables meant four
 * sentinels for one screen and four simultaneous re-requests on every
 * visibility change. This is a document resource, so its ownership must
 * follow the viewport holder count rather than each individual table.
 */
let wakeLockHolders = 0;
let wakeLockSentinel: WakeLockSentinel | null = null;
let wakeLockRequestInFlight: Promise<void> | null = null;

async function requestSharedWakeLock(): Promise<void> {
  // THE APP (2026-09-08): WKWebView never got navigator.wakeLock, so on iOS
  // the felt slept mid-hand. The plugin holds the OS idle timer instead.
  // Same holder count, same last-table-out release.
  if (IS_NATIVE_BUILD && isNativePlatform()) {
    if (wakeLockHolders === 0) return;
    void import('../lib/native/keepAwake')
      .then(({ nativeKeepAwake }) => nativeKeepAwake(true))
      .catch(() => {});
    return;
  }
  if (!('wakeLock' in navigator)) return;
  if (wakeLockHolders === 0) return; // released while we were waiting
  if (wakeLockSentinel && !wakeLockSentinel.released) return;
  // Collapse concurrent requests (four tables reacting to one
  // visibilitychange) into a single in-flight request.
  if (wakeLockRequestInFlight) return wakeLockRequestInFlight;
  wakeLockRequestInFlight = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      // Nobody left holding it by the time it arrived: release immediately
      // rather than leaking a sentinel nothing will ever release.
      if (wakeLockHolders === 0) {
        await sentinel.release().catch(() => {});
      } else {
        wakeLockSentinel = sentinel;
      }
    } catch {
      // Not supported, or denied (a hidden tab always denies) — ignore.
    } finally {
      wakeLockRequestInFlight = null;
    }
  })();
  return wakeLockRequestInFlight;
}

function onWakeLockVisibilityChange(): void {
  // A hidden tab drops the lock; take it back when the player returns.
  if (document.visibilityState === 'visible') void requestSharedWakeLock();
}

function acquireWakeLock(): () => void {
  wakeLockHolders += 1;
  if (wakeLockHolders === 1) {
    document.addEventListener('visibilitychange', onWakeLockVisibilityChange);
  }
  void requestSharedWakeLock();
  return () => {
    wakeLockHolders = Math.max(0, wakeLockHolders - 1);
    // LAST TABLE OUT releases. Closing one of four tables must not let the
    // screen dim on the three still dealing.
    if (wakeLockHolders > 0) return;
    document.removeEventListener('visibilitychange', onWakeLockVisibilityChange);
    if (IS_NATIVE_BUILD && isNativePlatform()) {
      void import('../lib/native/keepAwake')
        .then(({ nativeKeepAwake }) => nativeKeepAwake(false))
        .catch(() => {});
    }
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    sentinel?.release().catch(() => {});
  };
}

export function useTableEnvironment(
  tableId: string | undefined,
  pageRootRef?: RefObject<HTMLElement | null>,
  /**
   * Is this the table in front, and what is it called? Only the active table
   * names the browser tab — see the title effect. `isActive` defaults to true
   * so a single-table caller (or a test) behaves exactly as before.
   */
  opts?: { isActive?: boolean; displayName?: string }
) {
  const isActive = opts?.isActive ?? true;
  const displayName = opts?.displayName;
  /* ─── PAGE TITLE — the ACTIVE table names the tab, and it uses its NAME ────
   *
   * Two defects here until 2026-08-28, both from the same cause as the rest of
   * this file: `document.title` is one string and four TablePages were writing
   * it.
   *
   *   1. WHICHEVER TABLE MOUNTED LAST WON. The tab was named after a table the
   *      player might not even be looking at, and it never followed them as
   *      they switched tabs, because a mounted instance's effect does not
   *      re-run when a sibling becomes active. Gated on `isActive` now, so the
   *      one table in front is the one that names the tab — and exactly one
   *      instance writes at a time.
   *   2. IT PRINTED A RAW UUID. `${tableId} | Smarter Poker` put
   *      "f2c86e7a-e7c9-4d3c-b496-cd09ab33215d | Smarter Poker" in the browser
   *      tab and in every bookmark anybody made of a table. `displayName` is
   *      the table's real name ("NLH 0.25/0.50"), which is what a tab strip is
   *      for. It falls back to the id only while the name is still loading, so
   *      the tab is never blank.
   *
   * ── 3. AND IT WAS NEVER PUT BACK (Dan 2026-08-29, seen live) ──────────────
   *
   * This used to say the restore was deliberate, because "MultiTablePage's
   * YOUR TURN badge effect owns the restore". THAT PREMISE IS FALSE, and the
   * consequence is visible: leave a table for the club lobby and the browser
   * tab still reads "NLH Micro .10/.20 | Smarter Poker". Observed on
   * production 2026-08-29 with the URL already at /clubs/club-jaqk.
   *
   * The badge effect restores only a title IT badged (`if (!badged) ... else
   * if (badged)`), and it only badges while the tab is HIDDEN and a real turn
   * is live. In the ordinary case — no badge ever applied — nothing restores
   * anything, and Club Arena's lobby routes set no title of their own, so the
   * dead table's name follows the player around the app and into any bookmark
   * they make.
   *
   * Restored here, with the same discipline the badge effect uses and the
   * reason it cannot fight it: we capture the title we are about to replace,
   * and on the way out we put it back ONLY IF the title is still the exact
   * string we wrote. If the badge effect (or another table, or a route that
   * sets its own title) has changed it since, ours is stale and we leave it
   * alone. Two owners, neither able to clobber the other.
   */
  useEffect(() => {
    if (!isActive) return;
    const name = displayName && displayName !== 'Loading...' ? displayName : tableId;
    const ours = name ? `${arenaDisplayText(name)} | Smarter Poker` : 'Table | Smarter Poker';
    const previous = document.title;
    document.title = ours;
    return () => {
      // Only hand back what we took, and only if we are still the last writer.
      if (document.title === ours) document.title = previous;
    };
  }, [tableId, displayName, isActive]);

  // ─── MOBILE VIEWPORT LOCK — Prevent accidental pinch-zoom during poker play ───
  useEffect(() => {
    const pokerViewport = POKER_VIEWPORT;

    // FIRST TABLE IN takes the tag and remembers what it said. Later tables do
    // not re-read it, because by then it says what the first table wrote — that
    // is the whole bug (see the note at the top of this file).
    if (viewportHolders === 0) {
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta) {
        viewportOriginal = meta.getAttribute('content') || '';
        meta.setAttribute('content', pokerViewport);
      } else {
        viewportOriginal = null;
        viewportMetaCreated = document.createElement('meta');
        viewportMetaCreated.name = 'viewport';
        viewportMetaCreated.content = pokerViewport;
        document.head.appendChild(viewportMetaCreated);
      }
      // Non-blocking; fails silently on desktop and on anything without the API.
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })
          ?.lock?.('portrait')
          .catch(() => {});
      } catch {
        // Orientation lock not supported — ignore
      }
    }
    viewportHolders += 1;

    return () => {
      viewportHolders -= 1;
      // LAST TABLE OUT gives it back. While any table is still open the lock
      // stays on, which is what the player expects: closing one of four tables
      // must not re-enable pinch-zoom on the three still dealing.
      if (viewportHolders > 0) return;

      if (viewportMetaCreated) {
        viewportMetaCreated.remove();
        viewportMetaCreated = null;
      } else {
        const restoreMeta = document.querySelector('meta[name="viewport"]');
        if (restoreMeta) {
          restoreMeta.setAttribute(
            'content',
            viewportOriginal || 'width=device-width, initial-scale=1'
          );
        }
      }
      viewportOriginal = null;
      try {
        screen.orientation?.unlock?.();
      } catch {
        // Ignore
      }
    };
  }, []);

  // ─── PHONE TABLE LAYOUT — the table in front lays out at desktop width ───
  // Declared after the lock above so the tag already belongs to the tables
  // when it is first written; refcounted for the same four-tables reason.
  useEffect(() => {
    if (!isActive) return;
    desktopLayoutHolders += 1;
    writeTableViewport();
    const rewrite = () => writeTableViewport();
    window.addEventListener('resize', refreshStableTableViewport);
    window.addEventListener('orientationchange', rewrite);
    screen.orientation?.addEventListener?.('change', rewrite);
    return () => {
      desktopLayoutHolders -= 1;
      window.removeEventListener('resize', refreshStableTableViewport);
      window.removeEventListener('orientationchange', rewrite);
      screen.orientation?.removeEventListener?.('change', rewrite);
      writeTableViewport();
    };
  }, [isActive]);

  // ─── SCREEN WAKE LOCK — Prevent screen dimming during active poker play ───
  // Refcounted for the document (see the note beside `wakeLockHolders`):
  // one sentinel and one visibilitychange listener no matter how many tables
  // are open, released only when the last one closes.
  useEffect(() => acquireWakeLock(), []);

  // ─── BACKGROUND TAB DETECTION — Pause animations when tab is hidden ───
  useEffect(() => {
    /* THE CALLER'S OWN ROOT, never `document.querySelector('.table-page')`.
       That query returns the FIRST such element in the document, and with four
       tables mounted at once all four instances wrote to table one while tables
       two to four kept every animation running in a hidden tab — the opposite
       of what this effect is for.

       Reading it inside the effect rather than closing over it at render time
       is deliberate: refs are populated after the render that creates them, so
       the effect is the first moment there is anything to read. */
    const tablePage = pageRootRef?.current;
    if (!tablePage) return;

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        tablePage.classList.add('table-page--backgrounded');
      } else {
        tablePage.classList.remove('table-page--backgrounded');
      }
    };

    // A table can mount after the document was already backgrounded.
    // Do not wait for a second visibility event to pause its animations.
    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      tablePage.classList.remove('table-page--backgrounded');
    };
  }, [pageRootRef]);
}
