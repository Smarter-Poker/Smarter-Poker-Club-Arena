import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import './ClubIdentityCard.css';

/* v3 moved the club and profile icons DOWN 32px so they sit level with the two
   ID lines they label (Dan, 2026-09-01). It is a new filename rather than a new
   copy of v2 because the old file is already in browser and CDN caches, and a
   card whose labels point one line too high is exactly the bug being fixed.

   v5 REMOVES THE SILVER LOGO FRAME FROM THE ARTWORK ITSELF (Dan 2026-09-03:
   "THERE IS A BLACK BARCKGROUND BENIND THE SHARK CLUB LOGO THAT NEEDS TO BE
   REMOVED"). The frame was painted into the PNG, and the previous attempt hid
   it behind a `#000` div - which is exactly what Dan is looking at. The card's
   ground is a textured quilt, not black, so covering a silver box with a flat
   black rectangle trades one wrong thing for another just as visible.

   The frame is gone from the pixels now, healed over with quilt sampled from
   the clean stretch of the same image, so the logo floats on the real texture
   and there is nothing left to mask. Same naming rule as v3: caches hold the
   old bytes, so a change of pixels is a change of filename. */
const CLUB_IDENTITY_SHELL = `${import.meta.env.BASE_URL}assets/club-buttons/club/club-identity-template-no-level-v5.png`;

export interface ClubIdentityCardProps {
  clubName: string;
  logoUrl?: string | null;
  logoFallback?: ReactNode;
  pokerAlias: string;
  clubId: string | number;
  playerId?: string | number | null;
  /** Dan 2026-09-01, binding: the club level renders BELOW the logo inside a
   *  blue box, never overlapping it. A new club shows Level 1 from day one.
   *  (#2509 removed the level after the old placement overlapped the logo;
   *  the order was to move it into a blue box, not to delete it.) */
  level?: number | null;
  playersPlaying?: number | null;
  onCopyClubId?: () => void;
  onCopyPlayerId?: () => void;
  onShare?: () => void;
  shareIcon: ReactNode;
  className?: string;
}

/**
 * THE CLUB NAME IS ONE LINE, FULL WIDTH, AND ALWAYS COMPLETE (Dan 2026-09-02).
 *
 * "the club name should be across the very top of the card, all the way left
 * to right ... So DEEP STACK SOCIETY IS ONE LINE ACROSS THE TOP."
 *
 * Two of Dan's rules meet here and they pull against each other: the name may
 * never wrap, and it may never be cut off ("CLUB NAME SHOULD ALWAYS BE FULLY
 * DISPLAYED NEVER A 'MIDWAY UN...' FONT NEEDS TO BE DYNAMIC IT ALWAYS DISPLAYS
 * THE FULL NAME", 2026-09-02). CSS cannot fit text to a line on its own -
 * `clamp()` picks a size from the CARD's width, never from how much text there
 * is - so the size is computed from the name's own length and handed to the
 * stylesheet as a custom property.
 *
 * The unit is `cqw`, like every other size on this card, so the answer is the
 * same proportion of the card at any width and the card still only shrinks.
 *
 * THIS IS ONLY THE FIRST PAINT. A character count is not a width, so the exact
 * size comes from `fittedNameSizeCqw` below, which measures the text the
 * browser actually laid out. This estimate exists so the name is already close
 * before that measurement lands and nothing visibly jumps; 0.68em per character
 * is a middling advance for uppercase at weight 850, and 82cqw is the band's
 * usable width.
 *
 * The floor is deliberately low: a name long enough to reach it should become
 * hard to read rather than become truncated, which is the trade Dan chose when
 * he said the full name always shows.
 */
/* The ceiling, trimmed from 7.4 after looking at the rendered card: on the
   squat 2.4/1 lobby card 7.4cqw put the caps against the painted top rail.
   "DEEP STACK SOCIETY" still fills about 78 of the band's 85cqw at 7.0. */
export const CLUB_NAME_MAX_CQW = 7;
export const CLUB_NAME_MIN_CQW = 1.9;

export function clubNameSizeCqw(name: string): number {
  const characters = Math.max(name.trim().length, 1);
  const fitted = 82 / (0.68 * characters);
  return Math.min(CLUB_NAME_MAX_CQW, Math.max(CLUB_NAME_MIN_CQW, Math.round(fitted * 100) / 100));
}

/**
 * ...and then MEASURE, because a character count is not a width.
 *
 * Measured in Chromium at weight 850: "DEEP STACK SOCIETY" averages 0.62em per
 * character, "ACES" 0.70, and a name of all Ws 0.95. No single coefficient can
 * be both safe for the widest name and generous to the ordinary one - pick 0.95
 * and every real club name is shrunk by a third for a case that never happens;
 * pick 0.62 and the one club called "WWW..." runs off the card.
 *
 * So the estimate above is only the FIRST PAINT, chosen to be close enough that
 * nothing visibly jumps. This then measures the text it actually rendered and
 * scales to the exact fit. Text width is linear in font size, so one
 * measurement gives the answer outright - no loop, no binary search.
 *
 * Returns the same value it was given when there is nothing to measure, which
 * is what happens under happy-dom in the unit tests and in any environment
 * without layout: the length estimate stands rather than collapsing to zero.
 */
export function fittedNameSizeCqw(available: number, needed: number, from: number): number {
  if (!available || !needed || needed <= 0) return from;
  const scaled = (from * available) / needed;
  return Math.max(CLUB_NAME_MIN_CQW, Math.min(CLUB_NAME_MAX_CQW, Math.round(scaled * 100) / 100));
}

/**
 * "THE W IN PLAYING NOW IS CUT OFF" (Dan 2026-09-03).
 *
 * The count line carries the longest string on the card - "1,204 PLAYING NOW" -
 * in the narrowest bay, between the ID column and the copy frame, and it was
 * sized with a fixed `cqw`. A fixed size cannot fit a variable string: the bay
 * has been widened twice already for this exact complaint, and each time the
 * next longer count or the next slightly wider font clipped it again. Widening
 * is not available a third time either, because the right edge now stops at the
 * painted copy frame.
 *
 * So it is measured, like the club name above it. Same one-shot arithmetic:
 * text width is linear in font size, so `have / need` is the answer outright.
 * Below the floor the line would stop being readable, so it clamps there and
 * the bay's `overflow: hidden` still guards - but the floor is low enough that
 * no plausible count reaches it (at 2.05cqw, "1,204,000 PLAYING NOW" still
 * fits).
 */
export const PLAYING_MAX_CQW = 3.15;
/* 1.8, lowered from 2.05 when the bay narrowed on 2026-09-03 to put this line
   on the same left edge as the three above it. The floor is not a taste
   decision, it is the point past which the fit can no longer do its job: at the
   smallest real card (183px) the bay is about 50px, and the longest string this
   line can carry, "1,204,567 PLAYING NOW", needs about 78px at the ceiling - a
   ratio of 0.64, which is 2.02cqw. A floor of 2.05 sat just above that and
   clipped the W, which is the exact symptom Dan has now reported three times.
   Nothing realistic goes near it: a four-digit count on that same card settles
   around 2.5cqw. The floor exists so an absurd number degrades to small text
   rather than to CUT text. */
export const PLAYING_MIN_CQW = 1.8;

export function fittedPlayingSizeCqw(available: number, needed: number, from: number): number {
  if (!available || !needed || needed <= 0) return from;
  if (needed <= available) return from; // already fits - never grow past the ceiling
  const scaled = (from * available) / needed;
  return Math.max(PLAYING_MIN_CQW, Math.min(PLAYING_MAX_CQW, Math.floor(scaled * 100) / 100));
}

function IdentityLine({
  label,
  accessibleLabel,
  value,
  onCopy,
}: {
  label: string;
  accessibleLabel: string;
  value: string | number;
  onCopy?: () => void;
}) {
  const content = (
    <>
      <span>{label}:</span>
      <strong>{value}</strong>
    </>
  );

  return onCopy ? (
    <button
      type="button"
      className="club-identity__line"
      onClick={onCopy}
      title={`Copy ${accessibleLabel}`}
      aria-label={`Copy ${accessibleLabel} ${value}`}
    >
      {content}
    </button>
  ) : (
    <div className="club-identity__line">{content}</div>
  );
}

export function ClubIdentityCard({
  clubName,
  logoUrl,
  logoFallback,
  pokerAlias,
  clubId,
  playerId,
  level,
  playersPlaying,
  onCopyClubId,
  onCopyPlayerId,
  onShare,
  shareIcon,
  className = '',
}: ClubIdentityCardProps) {
  const nameRef = useRef<HTMLHeadingElement>(null);
  const nameTextRef = useRef<HTMLSpanElement>(null);
  const playingRef = useRef<HTMLSpanElement>(null);
  const playingTextRef = useRef<HTMLSpanElement>(null);

  /* Fit the club name to its band, once per name and again whenever the card
     is resized. `useLayoutEffect` so the corrected size is in place before the
     browser paints and the name never appears at the wrong size first.

     No loop is possible: the h2's width comes from its `left`/`right`
     percentages, so shrinking the text inside it cannot change the box being
     measured, and the observer only fires when the CARD resizes. */
  useLayoutEffect(() => {
    const band = nameRef.current;
    const text = nameTextRef.current;
    if (!band || !text) return;

    const fit = () => {
      band.style.setProperty('--club-name-size', `${CLUB_NAME_MAX_CQW}cqw`);
      const size = fittedNameSizeCqw(
        band.clientWidth,
        text.getBoundingClientRect().width,
        CLUB_NAME_MAX_CQW
      );
      band.style.setProperty('--club-name-size', `${size}cqw`);
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(band);
    return () => observer.disconnect();
  }, [clubName]);

  /* The same treatment for the count line — see fittedPlayingSizeCqw. It
     re-runs on the COUNT, not only on resize: "484" and "1,204" are different
     widths, and the number changes under the player while they watch. */
  useLayoutEffect(() => {
    const band = playingRef.current;
    const text = playingTextRef.current;
    if (!band || !text) return;

    const fit = () => {
      band.style.setProperty('--playing-size', `${PLAYING_MAX_CQW}cqw`);
      const size = fittedPlayingSizeCqw(
        band.clientWidth,
        text.getBoundingClientRect().width,
        PLAYING_MAX_CQW
      );
      band.style.setProperty('--playing-size', `${size}cqw`);
    };

    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(band);
    return () => observer.disconnect();
  }, [playersPlaying]);

  return (
    <section
      className={`club-identity ${className}`.trim()}
      aria-label={`${clubName} Club Identity`}
    >
      <picture className="club-identity__shell" aria-hidden="true">
        <img src={CLUB_IDENTITY_SHELL} alt="" />
      </picture>

      {/* ── ROW 1: THE CLUB NAME, EDGE TO EDGE (Dan 2026-09-02) ──────────────
          "the club name should be across the very top of the card, all the way
          left to right, with the logo under it."

          It used to share a two-row grid with the alias, in the right-hand
          column beside the logo, which is why a long name wrapped into the
          alias and collided with it. It is its own band now: full width, one
          line, sized to the name so it is never cut off. */}
      <h2
        ref={nameRef}
        className="club-identity__name"
        title={clubName}
        style={{ '--club-name-size': `${clubNameSizeCqw(clubName)}cqw` } as CSSProperties}
      >
        <span ref={nameTextRef}>{clubName}</span>
      </h2>

      {/* The silver frame Dan asked to remove on 2026-09-02 ("REMOVE THE SILVER
          BOX THAT IS BEHIND THE LOGO'S ON ALL THE CLUB CARDS") is no longer in
          the artwork, so the black `__logo-mask` div that used to cover it is
          gone with it. See the note on CLUB_IDENTITY_SHELL. */}
      <div className="club-identity__logo">
        {logoUrl ? <img src={logoUrl} alt={`${clubName} Logo`} loading="lazy" /> : logoFallback}
      </div>

      {level != null && (
        <span className="club-identity__level">
          <span>Level {level}</span>
        </span>
      )}

      {/* ── ROW 2 of the right column: the player's own name ────────────────
          "UNDER THAT SHOULD BE DAN BEKAVAC, NEXT LINE CLUB ID, NEXT LINE
          PLAYER ID". The alias leads the four-line stack that runs beside the
          logo; the two ID lines below it stay where they are, because the club
          and profile icons that label them are painted into the shell. */}
      <p className="club-identity__alias" title={pokerAlias}>
        {pokerAlias}
      </p>

      {/* Its own bay, pinned to the artwork icons that label these two lines.
          They used to be rows three and four of the details grid, which meant
          their vertical position was a by-product of the club name's row
          height and drifted away from the icons on every narrower card. */}
      <div className="club-identity__ids">
        <IdentityLine label="ID" accessibleLabel="Club ID" value={clubId} onCopy={onCopyClubId} />
        <IdentityLine
          label="ID"
          accessibleLabel="Player ID"
          value={playerId ?? '-'}
          onCopy={onCopyPlayerId}
        />
      </div>

      <div className="club-identity__footer">
        <span className="club-identity__playing" ref={playingRef} aria-live="polite">
          {/* The measurable half: exactly as wide as the count plus the label,
              so the effect above can compare it against the bay it sits in. */}
          <span className="club-identity__playing-fit" ref={playingTextRef}>
            <strong>{playersPlaying == null ? '-' : playersPlaying.toLocaleString()}</strong>
            <span>Playing Now</span>
          </span>
        </span>
        <button
          type="button"
          className="club-identity__share"
          onClick={onShare}
          aria-label="Copy Referral Link"
          title="Copy Referral Link"
        >
          {shareIcon}
        </button>
      </div>
    </section>
  );
}
