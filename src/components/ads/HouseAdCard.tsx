/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HOUSE AD CARD — one quiet promotion, for the surfaces that are not a strip
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 1 wired `lobby_strip`. Phase 2 wired `hub_promotions` on the World Hub.
 * Two slots stayed declared and pointed at nothing: `empty_state` and
 * `session_summary`. Both are single moments rather than a rotating rail, so
 * neither wants the strip; they want one card, said once.
 *
 * ── WHERE THESE TWO SLOTS ARE ALLOWED TO APPEAR ────────────────────────────
 * `empty_state` renders ONLY where the lobby has genuinely nothing to show and
 * the player has nothing to do about it. The other three empty views all carry
 * a remedy ("Show All Games"), and an advert beside a fix competes with the
 * fix. Dead space is the whole justification for the slot; a filtered-out list
 * is not dead space, it is a list one tap away.
 *
 * `session_summary` sits under the Session Complete card, above its actions.
 *
 * ── WHAT THIS COMPONENT DOES NOT DO ────────────────────────────────────────
 * It does not decide who sees what. Every audience, club, flight-date and
 * frequency rule lives in `fn_resolve_ads`, because the day a paying
 * advertiser arrives, an impression a browser decided to serve itself is a
 * billing dispute. This renders what it is handed and reports what happened.
 *
 * It does not filter on the result of the session either. Showing "Diamonds
 * Buy Chips Instantly" to somebody who just lost is a real question, but it is
 * a TARGETING question, so it belongs in the resolver and it is Dan's call,
 * not this component's.
 *
 * ── RENDERS NOTHING WHEN THERE IS NOTHING TO SAY ───────────────────────────
 * Same law as the lobby strip. An empty promotional box is worse than no box.
 */

import { useEffect, useState } from 'react';
import {
  AdService,
  isSafeAdImage,
  isSafeAdTarget,
  type AdSlot,
  type HouseAd,
} from '../../services/AdService';
import './HouseAdCard.css';

interface HouseAdCardProps {
  /** Which declared surface this is. Mirrors the CHECK on ad_placement.slot. */
  slot: AdSlot;
  /** Club in context, when there is one. The resolver expands {clubId} with it. */
  clubId?: string | null;
  /** Where a tap should go. Without it the card is not activatable and says so
   *  by not pretending: no pointer, no focus ring, no dead tap. */
  onNavigate?: (path: string) => void;
}

export default function HouseAdCard({ slot, clubId = null, onNavigate }: HouseAdCardProps) {
  const [ad, setAd] = useState<HouseAd | null>(null);
  /* An image that 404s must not leave a broken-image icon sitting in the card.
     Falling back to the glyph is the same graceful degradation the rest of this
     component uses: render something honest, never an error. */
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // One card, so one ad. The resolver already orders by weight.
      const resolved = await AdService.resolve(slot, clubId, 1);
      if (cancelled) return;
      setAd(resolved[0] ?? null);
      setImageFailed(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [slot, clubId]);

  /* Impression logging is de-duplicated per page load inside AdService, not per
     render. This card does not rotate, but the empty view re-renders every time
     a filter changes, and counting those would divide the campaign's
     click-through rate by a number that means nothing. */
  useEffect(() => {
    if (!ad) return;
    AdService.logImpression({ adId: ad.adId }, slot, clubId);
  }, [ad, slot, clubId]);

  if (!ad) return null;

  /* isSafeAdTarget, not Boolean(): `target_url` is unvalidated admin-entered
     text, and this made the whole card a link to wherever it pointed. An
     unsafe target now renders as a plain, non-activatable card. */
  const activatable = isSafeAdTarget(ad.targetUrl) && Boolean(onNavigate);

  /* The click is recorded BEFORE navigating. The alternative is losing the
     event to the unmount, which is how a working click path ends up looking
     like nobody ever clicked. */
  const activate = () => {
    if (!activatable) return;
    AdService.logClick({ adId: ad.adId }, slot, clubId);
    onNavigate?.(ad.targetUrl as string);
  };

  const showImage = isSafeAdImage(ad.imageUrl) && !imageFailed;

  const inner = (
    <>
      {showImage ? (
        <img
          className="house-ad__image"
          src={ad.imageUrl as string}
          alt=""
          /* Decorative: the headline beside it carries the meaning, and a
             screen reader reading a filename helps nobody. */
          aria-hidden="true"
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : ad.glyph ? (
        <span className="house-ad__glyph" aria-hidden="true">
          {ad.glyph}
        </span>
      ) : null}
      <span className="house-ad__body">
        <span className="house-ad__headline">{ad.headline}</span>
        {ad.body ? <span className="house-ad__text">{ad.body}</span> : null}
      </span>
      {activatable && ad.ctaLabel ? <span className="house-ad__cta">{ad.ctaLabel}</span> : null}
    </>
  );

  /* A button only when there is somewhere to go. Without that check the card
     was still focusable and still showed a pointer while doing nothing - the
     same defect the lobby strip had and fixed. */
  if (!activatable) {
    return (
      <div className={`house-ad house-ad--${slot.replace(/_/g, '-')} house-ad--static`}>
        <span className="house-ad__tag">SMARTER POKER</span>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`house-ad house-ad--${slot.replace(/_/g, '-')}`}
      onClick={activate}
      aria-label={`Smarter Poker: ${ad.headline}${ad.body ? `. ${ad.body}` : ''}`}
    >
      <span className="house-ad__tag">SMARTER POKER</span>
      {inner}
    </button>
  );
}
