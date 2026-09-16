import type { CSSProperties, ReactNode } from 'react';
import type { ArenaGameCardData } from './arenaGameCardTypes';
import { premiumStatusBadge } from './premiumStatus';
import { useFitText } from './useFitText';
import './LayeredCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAYERED CARD PRIMITIVES — the approved bitmap is the hardware
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every layered card (NLH spade, PLO four-bay, Spins, Heads-Up) is the same
 * machine: one approved master photographed into a text-free `chassis`, a
 * pixel coordinate map measured on that master, live DOM text printed into
 * those coordinates, and transparent semantic buttons laid over the painted
 * ones. The helpers here are what NlhPremiumCard grew by hand; the three
 * cards that followed it share them instead of copying them.
 *
 * Coordinates are always in the master's own pixel space and converted to
 * percentages at render, so a card fits any phone width without a single
 * measurement changing.
 */

export interface LayeredCanvas {
  width: number;
  height: number;
}

export interface LayeredZone {
  x: number;
  y: number;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
}

export function layeredZoneStyle(canvas: LayeredCanvas, zone: LayeredZone): CSSProperties {
  return {
    left: `${(zone.x / canvas.width) * 100}%`,
    top: `${(zone.y / canvas.height) * 100}%`,
    width: `${(zone.width / canvas.width) * 100}%`,
    height: `${(zone.height / canvas.height) * 100}%`,
    textAlign: zone.align,
    justifyItems: zone.align === 'left' ? 'start' : zone.align === 'right' ? 'end' : 'center',
  };
}

export function LayeredChassis({ src, className }: { src: string; className?: string }) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className={`agc-layered__chassis${className ? ` ${className}` : ''}`}
      src={src}
      draggable={false}
    />
  );
}

export function LayeredArt({
  canvas,
  zone,
  src,
}: {
  canvas: LayeredCanvas;
  zone: LayeredZone;
  src: string;
}) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className="agc-layered__layer"
      src={src}
      style={layeredZoneStyle(canvas, zone)}
      draggable={false}
    />
  );
}

export function LayeredZoneBox({
  canvas,
  zone,
  name,
  className,
  children,
  title,
}: {
  canvas: LayeredCanvas;
  zone: LayeredZone;
  name: string;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div
      className={`agc-layered__zone${className ? ` ${className}` : ''}`}
      data-zone={name}
      style={layeredZoneStyle(canvas, zone)}
      title={title}
    >
      {children}
    </div>
  );
}

/**
 * Single-line text that shrinks to its zone. `scaleX` must match any
 * transform the stylesheet applies to `.agc-layered__text` for this class.
 */
export function LayeredFitText({
  as: Component = 'strong',
  text,
  className,
  scaleX = 1,
  minRatio,
}: {
  as?: 'strong' | 'span' | 'h3' | 'p';
  text: string;
  className?: string;
  scaleX?: number;
  minRatio?: number;
}) {
  const ref = useFitText<HTMLElement>(text, scaleX, minRatio);
  return (
    <Component
      ref={ref as never}
      className={`agc-layered__text${className ? ` ${className}` : ''}`}
      title={text}
    >
      {text}
    </Component>
  );
}

/**
 * A buy-in RANGE printed as two centred lines, minimum over maximum, with no
 * dash. Dan 2026-09-03: "REMOVE ALL THE - FOR THE BUY IN CARDS. HAVE IT JUST
 * MINIMUM ON TOP 40 AND BELOW IT THE MAX 200. THE - IS THROWING EVERYTHING
 * OFF ... IF THE NUMBER ON TOP IS LESS DIGITS THEN THE NUMBER ON THE BOTTOM,
 * THE NUMBER ON THE TOP SHOULD BE CENTERED ON TOP OF THE BOTTOM NUMBER."
 * A single figure (no range) prints on one line as before.
 */
export function splitBuyInRange(value: string): [string, string] | null {
  const parts = value.split(/\s*[-\u2013\u2014]\s*/).filter(Boolean);
  return parts.length === 2 ? [parts[0], parts[1]] : null;
}

export function LayeredBuyIn({
  value,
  className,
  lineClassName,
}: {
  value: string;
  className?: string;
  lineClassName?: string;
}) {
  const range = splitBuyInRange(value);
  if (!range) return <LayeredFitText text={value} className={className} />;
  return (
    <span className="agc-layered__stack">
      <LayeredFitText
        as="span"
        text={range[0]}
        className={`${className || ''} ${lineClassName || ''}`.trim()}
      />
      <LayeredFitText
        as="span"
        text={range[1]}
        className={`${className || ''} ${lineClassName || ''}`.trim()}
      />
    </span>
  );
}

/** Lit DOM-text status pill: Empty / Full / Waitlist N / Filling / … */
export function LayeredStatus({
  canvas,
  zone,
  data,
}: {
  canvas: LayeredCanvas;
  zone: LayeredZone;
  data: Pick<ArenaGameCardData, 'status' | 'statusLabel'>;
}) {
  const badge = premiumStatusBadge(data);
  return (
    <div
      className={`agc-layered__zone agc-layered__status agc-layered__status--${badge.tone}`}
      data-zone="status"
      data-status={data.status}
      style={layeredZoneStyle(canvas, { ...zone, align: 'center' })}
    >
      <span className="agc-layered__status-glow" aria-hidden="true" />
      <LayeredFitText as="span" text={badge.label} className="agc-layered__status-text" />
    </div>
  );
}

/** Transparent semantic button over a painted one. */
export function LayeredHitbox({
  canvas,
  zone,
  name,
  label,
  disabled,
  onClick,
}: {
  canvas: LayeredCanvas;
  zone: LayeredZone;
  name: 'primaryAction' | 'secondaryAction';
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="agc-layered__hitbox"
      data-zone={name}
      aria-label={label}
      disabled={disabled}
      style={layeredZoneStyle(canvas, zone)}
      onClick={onClick}
    />
  );
}

/**
 * A painted button whose LABEL is live. The chassis carries the button face
 * (its chrome, fill and glow); the word on it is DOM so a full table can say
 * Join Waitlist and a seated player can see Return To Game without a bitmap
 * per state. The hit target is the same element, so there is exactly one
 * focusable control per action.
 */
export function LayeredActionButton({
  canvas,
  zone,
  name,
  label,
  tone = 'blue',
  disabled,
  busy,
  onClick,
  className,
}: {
  canvas: LayeredCanvas;
  zone: LayeredZone;
  name: 'primaryAction' | 'secondaryAction';
  label: string;
  tone?: 'blue' | 'green' | 'gold' | 'red' | 'neutral' | 'silver';
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`agc-layered__hitbox agc-layered__action agc-layered__action--${tone}${className ? ` ${className}` : ''}`}
      data-zone={name}
      disabled={disabled || busy}
      style={layeredZoneStyle(canvas, { ...zone, align: 'center' })}
      onClick={onClick}
    >
      <LayeredFitText
        as="span"
        text={busy ? 'Working...' : label}
        className="agc-layered__action-text"
      />
    </button>
  );
}
