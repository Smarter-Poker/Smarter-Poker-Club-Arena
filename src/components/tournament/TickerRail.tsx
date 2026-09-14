/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE RAIL - everything this component does is paint one strip
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Split out of TournamentStartingTicker on 2026-09-05, which was 951 lines
 * doing eight jobs: scope resolution, four fetches, message composition, chrome
 * measurement, CSS-variable publishing, dismissal persistence, toast scheduling
 * AND render. The suite covered the pure helpers well and rendered nothing, so
 * every defect this pass fixes - a flag painted cyan on cyan, a gradient that
 * had never rendered, a loop that showed empty rail, a documented hover pause
 * that did not exist - lived in the one part no test could see.
 *
 * This takes items and colours and returns pixels. No Supabase, no router, no
 * clock of its own. `tests/unit/TickerRail.test.tsx` mounts it and asserts the
 * things a human would have to squint at.
 */

import { useMemo, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import {
  announcementFor,
  CLOCK_TOKEN,
  FIELD_SEPARATOR,
  renderTickerItem,
  secondsLeft,
  type TickerItem,
} from './tickerMessages';
import {
  DEFAULT_ACCENT,
  flagBackground,
  railBackground,
  railGlow,
  readableInk,
  safeHex,
  TONE_ACCENT,
} from './tickerTheme';
import { useTickerMarquee } from './useTickerMarquee';
import { TickerClock } from './TickerClock';
import './TournamentStartingTicker.css';

/** Under this many seconds the clock itself goes accent and beats once a second. */
export const URGENT_SECONDS = 60;

export interface TickerRailAppearance {
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: string;
  speedSeconds: number;
}

export interface TickerRailProps {
  /** Already ranked, already filtered to one lane. The first owns the flag. */
  items: TickerItem[];
  now: number;
  /** Where the top chrome ends, from useTopChromeOffset. */
  top: number;
  appearance: TickerRailAppearance;
  onOpen: (item: TickerItem) => void;
  onDismiss: (item: TickerItem) => void;
  /** The container measures itself for `--mtt-ticker-h`. */
  containerRef?: (node: HTMLDivElement | null) => void;
  /** True while the strip is playing its exit. */
  leaving?: boolean;
}

/**
 * One item's fields as nodes, with the clock in its own element.
 *
 * The clock needs to be a separate node for two reasons that are both visible:
 * `tabular-nums` has to apply to the digits and not to the letterspaced copy
 * around them, and the last-minute urgency treatment is on the DIGITS. A
 * pulsing strip over a live hand is an irritation; a pulsing number is a clock.
 *
 * ── ONE FIELD, ONE FLEX ITEM (fixed 2026-09-13, from a photograph) ─────────
 *
 * The live rail read "Starts In0:19". The three pieces of a field - the text
 * before the clock, the clock, and the text after - used to be three SIBLING
 * spans, and `.mtt-ticker__item` is `inline-flex`, so each of them was a flex
 * item. A flex item's own trailing whitespace is trimmed at its line-box edge,
 * which ate the space the author wrote between "In" and the number, on every
 * countdown the bar has ever shown.
 *
 * A field is ONE flex item now and the clock is inline INSIDE it, so the
 * spacing is ordinary inline text again and the clock is still its own
 * stylable element. Nothing about the digits changed; the box around them did.
 */
function itemNodes(entry: TickerItem, urgent: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  entry.parts.forEach((part, index) => {
    if (index > 0) {
      out.push(
        <span key={`sep-${index}`} className="mtt-ticker__field-sep">
          {FIELD_SEPARATOR}
        </span>
      );
    }
    const at = part.toLowerCase().indexOf(CLOCK_TOKEN);
    out.push(
      <span key={`p-${index}`} className="mtt-ticker__field">
        {at === -1 || typeof entry.deadlineMs !== 'number' ? (
          part.replace(/\{clock\}/gi, '')
        ) : (
          <>
            {part.slice(0, at)}
            {/* Its own component, with its own second. The container used to
                advance a clock in state and re-render this entire strip sixty
                times a minute to change four characters. */}
            <TickerClock deadlineMs={entry.deadlineMs} urgent={urgent} />
            {part.slice(at + CLOCK_TOKEN.length)}
          </>
        )}
      </span>
    );
  });
  return out;
}

export function TickerRail({
  items,
  now,
  top,
  appearance,
  onOpen,
  onDismiss,
  containerRef,
  leaving = false,
}: TickerRailProps): ReactElement | null {
  const primary = items[0];

  /* The club's accent paints the routine case, so a club still recognises its
     own rail. The three exceptional tones override it, because "there is money
     on this table" must never look like "an event is starting" - which is what
     a single operator colour on every flag guaranteed. */
  const flagAccent = useMemo(() => {
    if (!primary) return safeHex(appearance.accentColor, DEFAULT_ACCENT);
    return primary.tone === 'time'
      ? safeHex(appearance.accentColor, DEFAULT_ACCENT)
      : TONE_ACCENT[primary.tone];
  }, [primary, appearance.accentColor]);

  const text = useMemo(
    () => items.map((entry) => renderTickerItem(entry, now)).join('  '),
    [items, now]
  );

  /* Measured against the message WITHOUT its clock. Keying on the rendered
     text would re-measure every second, and a fractional width change
     rewrites `animation-duration`, which restarts the animation - a visible
     stutter once per second on a strip whose whole job is to glide. */
  const contentKey = useMemo(() => items.map((entry) => entry.id).join('|'), [items]);
  const marquee = useTickerMarquee(appearance.speedSeconds, contentKey);

  if (!primary) return null;

  const left = secondsLeft(primary, now);
  const urgent = left !== null && left <= URGENT_SECONDS;
  const flagInk = readableInk(flagAccent);
  const copies = Array.from({ length: marquee.copies }, (_, i) => i);

  const style = {
    top,
    // Only the strip that actually touches y = 0 owes the notch inset. When it
    // sits below the global header the header has already paid it, and paying
    // twice turned a 34px strip into a ~90px band on notched iPhones.
    paddingTop: top > 0 ? 0 : undefined,
    background: railBackground(appearance.backgroundColor),
    color: appearance.textColor,
    /* THE MATERIAL IS NOT SET HERE (2026-09-13). The rail's bevel, cavity and
       lift are composed in the stylesheet from the estate's --realism-* tokens
       so a colour setting cannot overwrite them - an inline `box-shadow` beats
       a stylesheet one, which is how the designed gradient was lost for three
       weeks. The club's accent reaches the material as a single variable and
       the stylesheet decides where it lands. */
    '--ticker-glow': railGlow(flagAccent),
    fontFamily: appearance.fontFamily === 'System' ? 'system-ui' : appearance.fontFamily,
    '--ticker-text': appearance.textColor,
    '--ticker-accent': flagAccent,
    '--ticker-flag-bg': flagBackground(flagAccent),
    '--ticker-flag-ink': flagInk,
    '--ticker-duration': `${marquee.durationSeconds}s`,
    '--ticker-travel': `${marquee.travelPx}px`,
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`mtt-ticker${leaving ? ' mtt-ticker--leaving' : ''}`}
      data-tone={primary.tone}
      data-static={marquee.isStatic ? 'true' : 'false'}
      style={style}
    >
      {/*
        NOT a live region. The visible copy carries a clock that changes every
        second and it is `aria-hidden` for exactly that reason; this one node is
        what a screen reader hears, and it is written to the minute so it speaks
        about five times across a five-minute window instead of three hundred.
      */}
      <span className="mtt-ticker__sr" aria-live="polite" aria-atomic="true">
        {announcementFor(primary, now)}
      </span>

      {/* Both forms ship and the stylesheet picks one, because a phone cannot
          spare 185 of its 375 pixels for the least surprising word on the bar.
          The chip is aria-hidden either way - the spoken announcement above
          carries the flag in full. */}
      <span className="mtt-ticker__flag" aria-hidden="true">
        <span className="mtt-ticker__flag-full">{primary.flag}</span>
        <span className="mtt-ticker__flag-short">{primary.flagShort}</span>
      </span>

      <button
        className="mtt-ticker__track"
        onClick={() => onOpen(primary)}
        aria-label={announcementFor(primary, now)}
        title={text}
      >
        {/*
          The clipping region is INSIDE the button rather than being the button.
          The edge fade is a `mask-image`, and a mask applies to every
          descendant - with the mask on the button the "REGISTER" label at the
          right edge faded out along with the text it sits over. This also
          makes the measured width the right one: the marquee is sized by the
          space the message actually has, which excludes the label.
        */}
        <span className="mtt-ticker__viewport" ref={marquee.trackRef}>
          {/*
            Keyed on the item so a handover from a countdown to an overlay
            remounts the scroller and replays the fade-in, instead of the text
            simply being swapped underneath the reader mid-glide.
          */}
          <span className="mtt-ticker__scroll" key={primary.id} aria-hidden="true">
            {copies.map((copy) => (
              <span
                key={copy}
                className="mtt-ticker__msg"
                ref={copy === 0 ? marquee.copyRef : undefined}
              >
                {items.map((entry, index) => (
                  <span className="mtt-ticker__item" key={`${copy}-${entry.id}`}>
                    {index > 0 && <span className="mtt-ticker__pip" />}
                    {itemNodes(entry, urgent && index === 0)}
                  </span>
                ))}
              </span>
            ))}
          </span>
        </span>
        {/*
          A SIBLING OF THE VIEWPORT, NOT A LAYER OVER IT (fixed 2026-09-13).
          This was absolutely positioned at the right edge with a scrim behind
          it, and the message scrolled underneath: the live rail read
          "$100 Freeroll - 12:00 PM StartREGISTER In". A scrim cannot fix that,
          because the text is still there and still moving. As a flex sibling
          the viewport is simply narrower, so the two can never occupy the same
          pixels and the edge mask does the blending it was already there for.
        */}
        {/* AND ONLY WHEN THERE IS SOMEWHERE TO GO. A club's own message has
            neither a tournament nor a table, and the rail was offering
            "REGISTER" on it - a button promising a door that does not exist.
            Seen in the harness on the CLUB UPDATE line. */}
        {(primary.tournamentId || primary.tableId) && (
          <span className="mtt-ticker__cta" aria-hidden="true">
            {primary.tableId ? 'OPEN' : 'REGISTER'}
          </span>
        )}
      </button>

      <button
        className="mtt-ticker__close"
        onClick={() => onDismiss(primary)}
        aria-label={`Dismiss The Announcement For ${primary.subject}`}
      >
        ×
      </button>

      {/*
        The window, drawn rather than written. Two pixels of accent that empty
        across THIS item's own window - which used to be a hard-coded five
        minutes for everything, so a registration closing in 4:12 drew a nearly
        full bar and a start in 0:19 drew a stub that read as an artefact. An
        item with no window draws nothing at all.
      */}
      {typeof primary.deadlineMs === 'number' && left !== null && primary.windowMs ? (
        <span
          className="mtt-ticker__drain"
          aria-hidden="true"
          style={{
            width: `${Math.max(0, Math.min(100, (left / (primary.windowMs / 1000)) * 100))}%`,
          }}
        />
      ) : null}
    </div>
  );
}

export default TickerRail;
