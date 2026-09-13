/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HOUSE AD ROTATOR - three pictures, one at a time, never cut off
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-03: the lobby strip and the post-session modal show THREE
 * ROTATING IMAGES, and only images. Text-and-glyph cards are gone from both.
 * And: "IF A PAGE SHRINKS, THE IMAGE SHOULD SHRINK AS WELL, IT SHOULD NEVER
 * BE CUT OFF, OR DISTORTED BY PAGES CHANGING SIZE." That is a responsive
 * image with a fixed aspect ratio: the box is `width: 100%` with
 * `aspect-ratio` set per surface, and the picture sits inside it with
 * `object-fit: contain`. A 375px phone and a 1440px desktop show the same
 * creative, scaled, whole.
 *
 * Only creatives with a same-origin image are shown. An ad without one is
 * skipped, never rendered as text: a text card in a picture slot is exactly
 * the mixed surface this replaced. If nothing has a picture the rotator
 * renders NOTHING - an empty box trains the eye to ignore the region.
 *
 * ── TWO EVENTS, NOT ONE ─────────────────────────────────────────────────────
 * `impression` is logged when the creative is put in the DOM, as every surface
 * always has. `viewable` is logged only when at least half of it has been
 * inside the viewport for one continuous second (the MRC / IAB definition),
 * measured with an IntersectionObserver and paused while the tab is hidden.
 * Nobody pays for the first number. The second is what a sponsor buys.
 *
 * ── THE CLICK IS LOGGED ONLY WHERE ONE HAPPENED ────────────────────────────
 * The destination is substituted, then checked, then - and only then - the
 * click is recorded and the router is handed the CHECKED string. A creative
 * with no safe destination is not a button. Same law the strip and the card
 * carry; see AdService.isSafeAdTarget for the history.
 *
 * ── WHO IS SPEAKING ─────────────────────────────────────────────────────────
 * The house needs no label. A club or a sponsor does: the chip reads
 * "Club" / "Sponsored" so a player is never left guessing whose voice this
 * is. The resolver says which; this file only repeats it.
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  AdService,
  isExternalAdClick,
  isSafeAdImage,
  isSafeAdTarget,
} from '../../services/AdService';
import type { AdSlot, HouseAd } from '../../services/AdService';
import './HouseAdRotator.css';

/* The full-screen popup is fetched on the first tap, not before first paint.
   Every player downloads the rotator; only the ones who tap an advert need
   the popup, and a tap is a gesture with a beat of time in it. */
const AdInterstitial = lazy(() => import('./AdInterstitial'));

/** Per-surface creative shape. The number is the CSS aspect-ratio. */
export const AD_SURFACE_RATIO: Record<AdSlot, string> = {
  lobby_strip: '6 / 1',
  session_summary: '3 / 1',
  empty_state: '3 / 4',
  hub_promotions: '16 / 9',
  table_between_hands: '16 / 9',
};

/** MRC / IAB display viewability: half the pixels, one continuous second. */
const VIEWABLE_RATIO = 0.5;
const VIEWABLE_MS = 1000;
const MIN_INTERVAL_MS = 3000;

interface HouseAdRotatorProps {
  slot: AdSlot;
  /** Resolved club UUID when the surface has one; substituted into {clubId}. */
  clubId?: string | null;
  /** How many creatives to rotate through. Dan: three. */
  limit?: number;
  /** Rotation interval in ms; floored at 3s. */
  intervalMs?: number;
  /** Where a creative's checked destination should take the player. */
  onNavigate?: (path: string) => void;
  className?: string;
}

function substituteClub(url: string | null, clubId: string | null | undefined): string | null {
  if (!url) return null;
  return clubId ? url.replace(/{clubId}/g, clubId) : url;
}

export default function HouseAdRotator({
  slot,
  clubId = null,
  limit = 3,
  intervalMs = 7000,
  onNavigate,
  className,
}: HouseAdRotatorProps) {
  const [ads, setAds] = useState<HouseAd[]>([]);
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  /* The full-screen popup. While it is up the rotation holds, so the advert
     the player opened is the one still on the strip when they close it. */
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const openRef = useRef(false);
  openRef.current = open;

  // ── Load: ask for more than we show, keep only the ones with a picture ────
  useEffect(() => {
    let cancelled = false;
    AdService.resolve(slot, clubId, Math.min(10, Math.max(limit * 2, limit))).then((rows) => {
      if (cancelled) return;
      const withImage = rows.filter((a) => isSafeAdImage(a.imageUrl)).slice(0, limit);
      setAds(withImage);
      setIndex(0);
    });
    return () => {
      cancelled = true;
    };
  }, [slot, clubId, limit]);

  // ── Reduced motion: the crossfade collapses, the rotation does not ─────────
  // Animation law (CLAUDE.md 10.6): reduced-motion collapses motion but never
  // meaning. Holding one creative forever would hide the other two, so the
  // rotation still advances; only the fade is dropped (CSS reads the flag).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReducedMotion(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // ── Rotate ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (ads.length < 2) return;
    timerRef.current = setInterval(
      () => {
        // A hidden tab does not rotate: nobody is looking, and advancing the
        // index there would log viewables for creatives no eye ever met.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        // Nor does a strip whose advert is open full screen.
        if (openRef.current) return;
        setIndex((i) => (i + 1) % ads.length);
      },
      Math.max(MIN_INTERVAL_MS, intervalMs)
    );
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [ads.length, intervalMs]);

  const ad = ads.length > 0 ? ads[Math.min(index, ads.length - 1)] : null;
  const adId = ad?.adId;

  // ── Impression: rendered ───────────────────────────────────────────────────
  useEffect(() => {
    if (!adId) return;
    AdService.logImpression({ adId }, slot, clubId);
  }, [adId, slot, clubId]);

  // ── Viewable: seen. 50% in view for 1000ms, timer paused while hidden ─────
  useEffect(() => {
    const el = rootRef.current;
    if (!adId || !el || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inView = false;
    let done = false;

    const arm = () => {
      if (done || timer || !inView) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        timer = null;
        if (done || !inView) return;
        done = true;
        AdService.logViewable({ adId }, slot, clubId);
      }, VIEWABLE_MS);
    };
    const disarm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        inView = Boolean(e && e.isIntersecting && e.intersectionRatio >= VIEWABLE_RATIO);
        if (inView) arm();
        else disarm();
      },
      { threshold: [VIEWABLE_RATIO] }
    );
    io.observe(el);

    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') arm();
      else disarm();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      io.disconnect();
      disarm();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [adId, slot, clubId]);

  // ── A broken picture leaves the rotation rather than showing a hole ───────
  const dropBroken = useCallback((brokenId: string) => {
    setAds((prev) => {
      const next = prev.filter((a) => a.adId !== brokenId);
      setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
      return next;
    });
  }, []);

  if (!ad) return null;

  /* Substituted, then checked, so the check sees the string the router gets. */
  const target = (() => {
    const url = substituteClub(ad.targetUrl, clubId);
    return isSafeAdTarget(url) ? url : null;
  })();

  /* A sponsor's destination leaves the site, and the router cannot take us
     there: this app is mounted under a basename, so navigate('/c/x') would
     resolve to /hub/club-arena/c/x. It needs a document navigation. That also
     means an external click is activatable WITHOUT an onNavigate handler -
     leaving does not need the router at all. */
  const external = isExternalAdClick(target);
  const activatable = Boolean(target) && (external || Boolean(onNavigate));

  /* A TAP OPENS THE ADVERT FULL SCREEN (Dan 2026-09-13). Nothing is logged
     here: the impression was counted when the creative was seen, and whether
     this becomes a click or a dismiss is decided inside the popup. */
  const activate = () => {
    if (!activatable) return;
    setOpen(true);
  };

  /* The popup's button. This is the only place an internal click is logged,
     and it is logged BEFORE the route changes for the same reason it always
     was: losing the event to the unmount is how a working click path ends up
     looking like nobody ever clicked. */
  const proceed = () => {
    if (!target || !activatable) return;
    setOpen(false);
    if (external) {
      /* NOT logged here. The redirect at the other end of this path records
         the click server-side, in the same call that resolves the address.
         Logging in both places would show a sponsor twice the clicks they
         were given. A NEW TAB, not this one: the player keeps their lobby or
         table, and a sponsor's site is not this app's to navigate into.
         noopener so the new page cannot reach back into this one. */
      window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    AdService.logClick({ adId: ad.adId }, slot, clubId);
    onNavigate?.(target);
  };

  /* Closed without going anywhere is a dismiss - the honest name for a
     click that went nowhere, which is a bug this codebase already fixed
     once on 2026-08-29. */
  const dismiss = () => {
    setOpen(false);
    AdService.logDismiss({ adId: ad.adId }, slot, clubId);
  };

  const ratio = AD_SURFACE_RATIO[slot];
  const label = ad.headline || ad.adKey;
  const kindLabel =
    ad.advertiserKind === 'club' ? 'Club' : ad.advertiserKind === 'sponsor' ? 'Sponsored' : null;

  const picture = (
    <img
      key={ad.adId}
      className="ad-rotator__image"
      src={ad.imageUrl as string}
      alt={label}
      loading="eager"
      decoding="async"
      draggable={false}
      onError={() => dropBroken(ad.adId)}
    />
  );

  const rootClass = [
    'ad-rotator',
    `ad-rotator--${slot.replace(/_/g, '-')}`,
    reducedMotion ? 'ad-rotator--still' : '',
    className || '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={{ aspectRatio: ratio }}
      data-advertiser-kind={ad.advertiserKind}
      data-ad-key={ad.adKey}
    >
      {activatable ? (
        <button
          type="button"
          className="ad-rotator__frame ad-rotator__frame--button"
          onClick={activate}
          aria-label={`${kindLabel ? `${kindLabel}: ` : ''}${label}`}
        >
          {picture}
        </button>
      ) : (
        <div className="ad-rotator__frame ad-rotator__frame--static">{picture}</div>
      )}
      {kindLabel ? (
        <span className="ad-rotator__kind" aria-hidden="true">
          {kindLabel}
        </span>
      ) : null}
      {open ? (
        <Suspense fallback={null}>
          <AdInterstitial
            ad={ad}
            target={target}
            external={external}
            onProceed={proceed}
            onClose={dismiss}
          />
        </Suspense>
      ) : null}
      {ads.length > 1 ? (
        <div className="ad-rotator__dots" role="tablist" aria-label="Promotions">
          {ads.map((a, i) => (
            <button
              key={a.adId}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Show ${a.headline || a.adKey}`}
              className={`ad-rotator__dot${i === index ? ' ad-rotator__dot--on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setIndex(i);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
