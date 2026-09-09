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
  countdown,
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
  withAlpha,
} from './tickerTheme';
import { useTickerMarquee } from './useTickerMarquee';
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
 */
function itemNodes(entry: TickerItem, now: number, urgent: boolean): ReactNode[] {
  const clock = typeof entry.deadlineMs === 'number' ? countdown(entry.deadlineMs - now) : '';
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
    if (at === -1 || !clock) {
      out.push(<span key={`p-${index}`}>{part.replace(/\{clock\}/gi, clock)}</span>);
      return;
    }
    out.push(<span key={`p-${index}-a`}>{part.slice(0, at)}</span>);
    out.push(
      <span
        key={`p-${index}-clock`}
        className={`mtt-ticker__clock${urgent ? ' mtt-ticker__clock--urgent' : ''}`}
      >
        {clock}
      </span>
    );
    out.push(<span key={`p-${index}-b`}>{part.slice(at + CLOCK_TOKEN.length)}</span>);
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
    borderBottomColor: withAlpha(flagAccent, 0.26),
    boxShadow: railGlow(flagAccent),
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

      <span className="mtt-ticker__flag" aria-hidden="true">
        {primary.flag}
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
                    {itemNodes(entry, now, urgent && index === 0)}
                  </span>
                ))}
              </span>
            ))}
          </span>
        </span>
        <span className="mtt-ticker__cta" aria-hidden="true">
          {primary.tableId ? 'OPEN' : 'REGISTER'}
        </span>
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
        left to right across whatever the top item is counting down to, so the
        bar reads as live rather than looped without spending a single character
        on saying so.
      */}
      {typeof primary.deadlineMs === 'number' && left !== null && (
        <span
          className="mtt-ticker__drain"
          aria-hidden="true"
          style={{ width: `${Math.max(0, Math.min(100, (left / 300) * 100))}%` }}
        />
      )}
    </div>
  );
}

export default TickerRail;
