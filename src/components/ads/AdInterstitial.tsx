/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AD INTERSTITIAL - a tapped advert opens full screen, then goes where it says
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-13: "ANY TIME THEY ARE CLICKED THEY SHOULD BE OPEN AND DIRECTED
 * TO WHATEVER THE AD IS DISPLAYING AS A FULL SCREEN POP UP AS WELL."
 *
 * A tap on any advert, on any surface, opens THIS: the campaign's poster,
 * fluid and whole, over a dark scrim, with who is speaking, the headline, and
 * one button that takes the player where the advert points. Close, Escape or
 * the scrim puts them back exactly where they were - the lobby, the table,
 * the session summary - with nothing lost.
 *
 * ── WHY A POPUP OF THE ADVERT AND NOT OF THE DESTINATION ────────────────────
 * The obvious alternative, a full-screen frame showing the destination page,
 * is impossible on this platform without breaking a ruled law on every
 * surface: CLAUDE.md 1.3 permits exactly one iframe (HubFrame, table tabs
 * only), Dan's own ruling says Club Arena is never framed inside itself, and
 * a sponsor's site sends X-Frame-Options and would go blank. So the popup
 * shows the one thing every advert has - its picture - and the button does
 * the directing. That is the same shape as every mobile ad network's
 * interstitial, and it gives the campaign a second, larger impression that
 * a sponsor will actually pay for.
 *
 * ── WHAT IS COUNTED, AND WHEN ────────────────────────────────────────────────
 * Opening the popup counts nothing. The impression was already recorded when
 * the creative was seen, and a popup that is closed without going anywhere
 * is a `dismiss`, not a click - this codebase already fixed "a click that
 * went nowhere was still a click" once (2026-08-29) and is not shipping it
 * again. The click is logged only when the button takes the player
 * somewhere: here for an internal destination, and server-side by the
 * redirect for an external one, never both (see HouseAdRotator).
 *
 * ── RESPONSIVE, NEVER CROPPED ────────────────────────────────────────────────
 * The poster sits in a box that is as wide as the viewport allows and as tall
 * as its own shape needs, `object-fit: contain`. A 3:4 poster fills a phone;
 * on a desktop it stands in the middle at its natural proportion. A campaign
 * with no poster gets its surface creative, which is why the box reads the
 * picture's real proportion once it has loaded rather than assuming 3:4.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isSafeAdImage } from '../../services/AdService';
import type { HouseAd } from '../../services/AdService';
import './AdInterstitial.css';

interface AdInterstitialProps {
  ad: HouseAd;
  /** The checked destination; null when the advert has nowhere safe to go. */
  target: string | null;
  /** Leaves the site through the click redirect (a sponsor). */
  external: boolean;
  /** The player pressed the button. The caller logs and routes. */
  onProceed: () => void;
  /** Close, Escape, scrim. The caller logs the dismiss. */
  onClose: () => void;
}

export default function AdInterstitial({
  ad,
  target,
  external,
  onProceed,
  onClose,
}: AdInterstitialProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [ratio, setRatio] = useState<string>('3 / 4');
  const [broken, setBroken] = useState(false);

  const picture = isSafeAdImage(ad.posterUrl)
    ? ad.posterUrl
    : isSafeAdImage(ad.imageUrl)
      ? ad.imageUrl
      : null;
  const kind =
    ad.advertiserKind === 'sponsor'
      ? `Sponsored${ad.advertiserName ? ` By ${ad.advertiserName}` : ''}`
      : ad.advertiserKind === 'club'
        ? `From ${ad.advertiserName || 'Your Club'}`
        : null;
  const cta = ad.ctaLabel || 'Open';

  /* Escape closes; focus lands on Close so a keyboard user is never trapped
     behind the scrim; the page underneath stops scrolling while it is up. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
    }
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="ad-interstitial"
      role="dialog"
      aria-modal="true"
      aria-label={ad.headline || 'Promotion'}
      onClick={onClose}
      data-advertiser-kind={ad.advertiserKind}
    >
      <div className="ad-interstitial__sheet" onClick={(e) => e.stopPropagation()}>
        <button
          ref={closeRef}
          type="button"
          className="ad-interstitial__close"
          onClick={onClose}
          aria-label="Close"
        >
          {'✕'}
        </button>

        {kind ? <span className="ad-interstitial__kind">{kind}</span> : null}

        <div className="ad-interstitial__picture" style={{ aspectRatio: ratio }}>
          {picture && !broken ? (
            <img
              src={picture}
              alt={ad.headline || ad.adKey}
              decoding="async"
              draggable={false}
              onLoad={onLoad}
              onError={() => setBroken(true)}
            />
          ) : (
            /* No picture reachable: the popup still says what the advert is
               about and still offers the way there, rather than a black box. */
            <span className="ad-interstitial__headline-only">{ad.headline || ad.adKey}</span>
          )}
        </div>

        {ad.headline ? <p className="ad-interstitial__headline">{ad.headline}</p> : null}

        {target ? (
          <button
            type="button"
            className="ad-interstitial__cta"
            onClick={onProceed}
            aria-label={external ? `${cta} (Opens In A New Tab)` : cta}
          >
            {cta}
            {external ? (
              <span className="ad-interstitial__ext" aria-hidden="true">
                {'↗'}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
