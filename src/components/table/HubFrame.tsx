/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HubFrame — a World Hub page living inside a table slot
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: the "+" tab "is basically opening up a new browser tab
 * internally, it shouldn't be limited to just poker ... go to social, media,
 * or trivia or training or any other world hub page, I should still see my
 * action bar, I should still be able to swipe right or left."
 *
 * THE ONE SANCTIONED IFRAME. CLAUDE.md 1.3 forbids iframe code, and the rule
 * is right about what it was written against: embedding Club Arena INSIDE the
 * World Hub (the ClubArenaEmbed era) and the postMessage bridges that came
 * with it. Social, Media, Trivia and Training are Next.js pages in the World
 * Hub, a different application from this SPA, and the only way to show one
 * inside a slot while the strip and every running table stay mounted is a
 * same-origin frame. Dan approved exactly that on 2026-09-04. It uses NO
 * postMessage and NO reach back into the parent window: smarter.poker sends
 * `X-Frame-Options: SAMEORIGIN`, and same-origin means this component can read
 * the frame's location and listen on its document directly.
 *
 * WHAT THE FRAME DOES BESIDES SHOWING THE PAGE:
 *
 *  1. SWIPE. A touch that starts on the hub page lands in the frame's
 *     document, which the container's `onTouchStart` on the swipe track never
 *     sees. So the frame's document gets the same three handlers, through a
 *     ref the container keeps current, and a swipe over Social moves the strip
 *     exactly as a swipe over the felt does. Re-attached on every `load`,
 *     because a full navigation inside the frame is a new document.
 *
 *  2. KEYS. Same story for the keyboard: 1-6 and Tab switch tabs from the
 *     felt, and with focus inside the frame those keystrokes never reached
 *     the window. The frame document forwards them through the same kind of
 *     ref.
 *
 *  3. LOCATION. Next.js moves between pages with pushState, which no parent
 *     can hear, so the frame's location is polled (HUB_FRAME_POLL_MS). A change
 *     renames the pill and is remembered as `hubUrl`, so tile view and back
 *     reopens the page the player was on.
 *
 *  4. CLUB ARENA. A link inside the hub back to /hub/club-arena/... must NOT
 *     boot a second copy of this app inside the first (Dan's ruling). Anchor
 *     clicks are caught in the capture phase before the frame follows them;
 *     programmatic navigations the poll catches on the next tick, before the
 *     second app has finished loading. Either way the container converts the
 *     tab in place.
 *
 *  5. OFF-SITE. A link to another origin opens in a REAL browser tab. Stripe
 *     Checkout and OAuth providers send X-Frame-Options: DENY, so a frame that
 *     followed one would go blank at the exact moment the player is paying or
 *     signing in. (A programmatic redirect off-site is the hub page's own to
 *     break out of; this catches every anchor.)
 *
 *  6. QUIET IN THE BACKGROUND. When the tab goes inactive, every playing
 *     <video>/<audio> in the frame is paused - a Media page must not keep
 *     talking over a hand. It is not resumed on return; the player presses
 *     play, like any paused player.
 *
 *  7. IDLE UNLOAD. A frame left behind other tabs for HUB_FRAME_IDLE_SUSPEND_MS
 *     is unloaded to about:blank (its page remembered) and reloaded the moment
 *     its tab is opened again - each hub tab is a whole running app with its
 *     own realtime socket, and the felt needs that memory more than a page
 *     nobody has looked at for fifteen minutes does.
 *
 * `src` is read ONCE, at mount. The container updates `hubUrl` as the frame
 * moves, and feeding that back into the `src` attribute would reload the page
 * the player is already on, every 250ms. The idle unload/reload above sets
 * `iframe.src` imperatively for exactly that reason.
 */

import { useEffect, useRef, type RefObject } from 'react';
import {
  HUB_FRAME_IDLE_SUSPEND_MS,
  HUB_FRAME_POLL_MS,
  clubArenaPathFromHubUrl,
  isOffSite,
} from '../../utils/hubTab';

/** The container's swipe handlers, on the shape a native TouchEvent satisfies. */
export interface HubFrameSwipeHandlers {
  start: (e: TouchEvent) => void;
  move: (e: TouchEvent) => void;
  end: () => void;
}

export interface HubFrameProps {
  tabId: string;
  /** Initial World Hub path (`/hub/social`). Read at mount only. */
  src: string;
  /** Accessible name for the frame - the tab's title. */
  title: string;
  /** Is this tab the one on screen (and the container visible)? */
  active: boolean;
  swipe: RefObject<HubFrameSwipeHandlers>;
  /** The strip's keyboard handler (1-6, Tab, Alt+Arrows). Optional. */
  keys?: RefObject<((e: KeyboardEvent) => void) | null>;
  /** The frame is on a different World Hub page now (path + search). */
  onLocationChange: (tabId: string, path: string) => void;
  /** The frame is heading into Club Arena; `caPath` is relative to the SPA basename. */
  onClubArenaTarget: (tabId: string, caPath: string) => void;
  /** Test seam: how long an inactive frame waits before unloading. */
  idleSuspendMs?: number;
}

/** Pause everything playing in a document. Exported for the unit test. */
export function pauseMediaIn(doc: Document): number {
  let paused = 0;
  doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => {
    if (!el.paused) {
      try {
        el.pause();
        paused++;
      } catch {
        /* a detached or errored element; nothing to quiet */
      }
    }
  });
  return paused;
}

export function HubFrame({
  tabId,
  src,
  title,
  active,
  swipe,
  keys,
  onLocationChange,
  onClubArenaTarget,
  idleSuspendMs = HUB_FRAME_IDLE_SUSPEND_MS,
}: HubFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const initialSrc = useRef(src).current;
  /* Latest callbacks, so the one-time effect below never calls a stale one. */
  const cbRef = useRef({ onLocationChange, onClubArenaTarget });
  cbRef.current = { onLocationChange, onClubArenaTarget };
  /* The last same-origin page the frame was on: what an idle unload restores. */
  const lastPathRef = useRef(src);
  const suspendedRef = useRef(false);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let lastHref = '';
    let detachDoc: (() => void) | null = null;
    let converted = false;

    const readLocation = (): URL | null => {
      try {
        const href = iframe.contentWindow?.location.href;
        if (!href || href === 'about:blank') return null;
        return new URL(href);
      } catch {
        /* Cross-origin: the player followed a link off smarter.poker. Nothing
           to read, nothing to do - the tab keeps its last known name. */
        return null;
      }
    };

    const headedIntoClubArena = (caPath: string) => {
      if (converted) return;
      converted = true;
      cbRef.current.onClubArenaTarget(tabId, caPath);
    };

    const attach = () => {
      detachDoc?.();
      detachDoc = null;
      let doc: Document | null = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        doc = null;
      }
      if (!doc) return;

      const onStart = (e: TouchEvent) => swipe.current?.start(e);
      const onMove = (e: TouchEvent) => swipe.current?.move(e);
      const onEnd = () => swipe.current?.end();
      const onKey = (e: KeyboardEvent) => keys?.current?.(e);
      const onClick = (e: MouseEvent) => {
        const target = e.target as Element | null;
        const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        let url: URL;
        try {
          url = new URL(anchor.getAttribute('href') ?? '', doc!.baseURI);
        } catch {
          return;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        if (isOffSite(url, window.location.origin)) {
          // Off-site: a real browser tab, never the frame (see 5 above).
          e.preventDefault();
          e.stopPropagation();
          window.open(url.href, '_blank', 'noopener,noreferrer');
          return;
        }
        const caPath = clubArenaPathFromHubUrl(url.pathname + url.search);
        if (caPath === null) return;
        e.preventDefault();
        e.stopPropagation();
        headedIntoClubArena(caPath);
      };

      doc.addEventListener('touchstart', onStart, { passive: true });
      doc.addEventListener('touchmove', onMove, { passive: true });
      doc.addEventListener('touchend', onEnd, { passive: true });
      doc.addEventListener('touchcancel', onEnd, { passive: true });
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('click', onClick, true);
      detachDoc = () => {
        doc!.removeEventListener('touchstart', onStart);
        doc!.removeEventListener('touchmove', onMove);
        doc!.removeEventListener('touchend', onEnd);
        doc!.removeEventListener('touchcancel', onEnd);
        doc!.removeEventListener('keydown', onKey);
        doc!.removeEventListener('click', onClick, true);
      };
    };

    const check = () => {
      const url = readLocation();
      if (!url || url.href === lastHref) return;
      lastHref = url.href;
      const pathAndSearch = url.pathname + url.search;
      const caPath = clubArenaPathFromHubUrl(pathAndSearch);
      if (caPath !== null) {
        headedIntoClubArena(caPath);
        return;
      }
      lastPathRef.current = pathAndSearch;
      cbRef.current.onLocationChange(tabId, pathAndSearch);
    };

    const onLoad = () => {
      attach();
      check();
    };

    iframe.addEventListener('load', onLoad);
    /* The document may already be there (bfcache, a synchronous about:blank
       that is then replaced): attach now as well as on load. */
    attach();
    const timer = window.setInterval(check, HUB_FRAME_POLL_MS);

    return () => {
      window.clearInterval(timer);
      iframe.removeEventListener('load', onLoad);
      detachDoc?.();
    };
    // Mount-once by design: see the header comment on `src`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 6 + 7: what happens to a frame the player is not looking at. */
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    if (active) {
      if (suspendedRef.current) {
        suspendedRef.current = false;
        iframe.src = lastPathRef.current;
      }
      return;
    }

    try {
      const doc = iframe.contentDocument;
      if (doc) pauseMediaIn(doc);
    } catch {
      /* cross-origin frame: nothing we can quiet */
    }

    const timer = window.setTimeout(() => {
      if (suspendedRef.current) return;
      suspendedRef.current = true;
      iframe.src = 'about:blank';
    }, idleSuspendMs);
    return () => window.clearTimeout(timer);
  }, [active, idleSuspendMs]);

  return (
    <iframe
      ref={ref}
      className="multi-table-page__hub-frame"
      src={initialSrc}
      title={title}
      data-hub-active={active ? 'true' : 'false'}
      /* Same-origin, no sandbox: the World Hub is our own app and needs its
         storage, its scripts and its forms exactly as it has them standalone.
         Sandboxing would also make it a foreign origin and take away the
         location read and the document listeners this component exists for. */
      allow="autoplay; fullscreen; clipboard-write; microphone; camera"
      referrerPolicy="same-origin"
    />
  );
}

export default HubFrame;
