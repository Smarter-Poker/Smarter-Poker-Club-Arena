import { useEffect, type RefObject } from 'react';

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
 * THE WAKE LOCK IS ALSO ONE PER DOCUMENT (2026-08-28).
 *
 * The header above states the rule — "if the answer involves a document-level
 * singleton, it belongs behind the refcount" — and the viewport tag obeys it.
 * The wake lock did not: every mounted table requested its own sentinel and
 * attached its own `visibilitychange` listener, so four tables meant four
 * sentinels for one screen and four simultaneous re-requests on every
 * visibility change. `useTabKeepAlive` refcounts its AudioContext and Worker
 * for exactly this reason; this is the same shape, and it was the one that
 * was missed.
 */
let wakeLockHolders = 0;
let wakeLockSentinel: WakeLockSentinel | null = null;
let wakeLockRequestInFlight: Promise<void> | null = null;

async function requestSharedWakeLock(): Promise<void> {
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
    const ours = name ? `${name} | Smarter Poker` : 'Table | Smarter Poker';
    const previous = document.title;
    document.title = ours;
    return () => {
      // Only hand back what we took, and only if we are still the last writer.
      if (document.title === ours) document.title = previous;
    };
  }, [tableId, displayName, isActive]);

  // ─── MOBILE VIEWPORT LOCK — Prevent accidental pinch-zoom during poker play ───
  useEffect(() => {
    const pokerViewport =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

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

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      tablePage.classList.remove('table-page--backgrounded');
    };
  }, [pageRootRef]);
}
