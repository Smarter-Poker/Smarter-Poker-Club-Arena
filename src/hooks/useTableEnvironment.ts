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
   * NOT restored on unmount, deliberately: MultiTablePage's "YOUR TURN" badge
   * effect owns the restore, and it captures `document.title` at the moment it
   * badges precisely so it hands back the CURRENT title rather than a
   * mount-time one (see the AUDIT 2026-08-25 note there). A restore here would
   * fight it.
   */
  useEffect(() => {
    if (!isActive) return;
    const name = displayName && displayName !== 'Loading...' ? displayName : tableId;
    document.title = name ? `${name} | Smarter Poker` : 'Table | Smarter Poker';
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
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          if (wakeLock) await wakeLock.release().catch(() => {});
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Wake Lock not supported or denied — ignore
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      wakeLock?.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

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
