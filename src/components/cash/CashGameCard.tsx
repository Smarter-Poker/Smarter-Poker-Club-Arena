/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CASH GAME CARD (Operation Table Stakes - the lobby's one card per GAME,
 *  OPORD 1.3 section 12 / OPORD 1.4 Gate 4). 2026-09-04.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan supplied three finished pieces of artwork - Classic (cyan), Action
 * (green), Madness (red) - with every value baked in. The value zones were
 * lifted out of the artwork (public/images/cash-cards/*.webp carry the frame,
 * the emblem, the template name, the row labels and the two buttons, and
 * NOTHING that changes) and this component paints the changing parts on top:
 *
 *   stakes line          "$1 / $2"
 *   variant line         "NO LIMIT HOLD'EM"
 *   status pill          RUNNING | WAITING | DORMANT
 *   mode pill            MUST MOVE | MANUAL  (R9)
 *   TYPE / STAKES / PLAYERS / TABLES values
 *   rules line           "6-9 HANDED - TRADITIONAL RULES - NO BOMB POTS - BUY-IN 40-200 BB"
 *   VIEW GAME / JOIN GAME hit areas (the button faces are in the artwork)
 *
 * Every zone is placed in PERCENT of the artwork's 784 x 1168 frame, so the
 * card scales from a 340px phone column to a desktop grid without a second
 * layout. Type is sized in container-query units for the same reason.
 *
 * The card knows nothing about the database: it renders the props it is
 * given. Feeding it from cash_games and its cluster's tables is the lobby's
 * job (Gate 4).
 */

import type { CSSProperties, ReactNode } from 'react';
import { mediaUrl } from '../../utils/mediaBase';
import type { CashTemplate } from '../../config/cashGames';
import './CashGameCard.css';

export type CashGameStatus = 'running' | 'waiting' | 'dormant';

export interface CashGameCardProps {
  template: CashTemplate;
  /** Already formatted for the player, e.g. "$1 / $2" or "0.05 / 0.10". */
  stakesLabel: string;
  /** e.g. "No Limit Hold'em", "Pot Limit Omaha 5". Rendered in capitals. */
  variantLabel: string;
  status: CashGameStatus;
  mustMove: boolean;
  players: number;
  tables: number;
  /** The one-line rules strip; use rulesLineFor() for the house wording. */
  rulesLine: string;
  onView?: () => void;
  onJoin?: () => void;
  joinDisabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Artwork frame in pixels; every zone below is expressed against it. */
const FRAME_W = 784;
const FRAME_H = 1168;

type Zone = readonly [x0: number, y0: number, x1: number, y1: number];

/**
 * The value zones, per template, in artwork pixels (measured 2026-09-04
 * against the supplied JPGs; the same numbers drove the lift-out). Changing
 * the artwork means re-measuring these - they are the contract between the
 * picture and the text.
 */
const ZONES: Record<
  CashTemplate,
  {
    stakes: Zone;
    variant: Zone;
    status: Zone;
    mode: Zone;
    rows: readonly [Zone, Zone, Zone, Zone];
    rules: Zone;
    view: Zone;
    join: Zone;
  }
> = {
  classic: {
    stakes: [212, 382, 572, 476],
    variant: [150, 485, 640, 532],
    status: [160, 568, 365, 612],
    mode: [425, 568, 660, 612],
    rows: [
      [430, 650, 660, 698],
      [430, 713, 660, 760],
      [430, 778, 660, 825],
      [430, 843, 660, 890],
    ],
    rules: [112, 921, 682, 949],
    view: [92, 972, 384, 1068],
    join: [402, 972, 692, 1068],
  },
  action: {
    stakes: [200, 420, 590, 486],
    variant: [180, 488, 600, 534],
    status: [185, 556, 362, 602],
    mode: [425, 556, 632, 602],
    rows: [
      [440, 640, 645, 680],
      [440, 698, 645, 738],
      [440, 758, 645, 798],
      [440, 816, 645, 854],
    ],
    rules: [108, 893, 682, 919],
    view: [98, 950, 368, 1046],
    join: [392, 950, 690, 1046],
  },
  madness: {
    stakes: [265, 384, 520, 453],
    variant: [200, 452, 590, 498],
    status: [192, 538, 368, 578],
    mode: [430, 538, 650, 578],
    rows: [
      [455, 620, 640, 660],
      [455, 686, 640, 726],
      [455, 750, 640, 790],
      [455, 813, 640, 853],
    ],
    rules: [114, 890, 672, 914],
    view: [112, 936, 380, 1032],
    join: [400, 936, 676, 1032],
  },
};

const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(3)}%`;

const zoneStyle = ([x0, y0, x1, y1]: Zone): CSSProperties => ({
  left: pct(x0, FRAME_W),
  top: pct(y0, FRAME_H),
  width: pct(x1 - x0, FRAME_W),
  height: pct(y1 - y0, FRAME_H),
});

const STATUS_TEXT: Record<CashGameStatus, string> = {
  running: 'RUNNING',
  waiting: 'WAITING',
  dormant: 'DORMANT',
};

const TEMPLATE_TEXT: Record<CashTemplate, string> = {
  classic: 'CLASSIC',
  action: 'ACTION',
  madness: 'MADNESS',
};

/** Long labels shrink so "$0.05 / $0.10" fits where "$1 / $2" was painted. */
const shrink = (text: string, comfortable: number): CSSProperties | undefined =>
  text.length > comfortable
    ? ({ '--cgc-fit': (comfortable / text.length).toFixed(3) } as CSSProperties)
    : undefined;

export default function CashGameCard({
  template,
  stakesLabel,
  variantLabel,
  status,
  mustMove,
  players,
  tables,
  rulesLine,
  onView,
  onJoin,
  joinDisabled = false,
  className,
  children,
}: CashGameCardProps) {
  const z = ZONES[template];
  const art = mediaUrl(`images/cash-cards/${template}.webp`);
  const modeText = mustMove ? 'MUST MOVE' : 'MANUAL';
  const rows: Array<[string, string]> = [
    ['type', TEMPLATE_TEXT[template]],
    ['stakes', stakesLabel.replace(/\s+/g, '')],
    ['players', players.toLocaleString()],
    ['tables', tables.toLocaleString()],
  ];

  return (
    <article
      className={`cgc cgc--${template} cgc--${status}${className ? ` ${className}` : ''}`}
      data-template={template}
      data-status={status}
      data-must-move={mustMove}
      aria-label={`${TEMPLATE_TEXT[template]} ${stakesLabel} ${variantLabel}`}
    >
      <img className="cgc__art" src={art} alt="" draggable={false} />

      <div
        className="cgc__zone cgc__stakes"
        style={{ ...zoneStyle(z.stakes), ...shrink(stakesLabel, 9) }}
      >
        {stakesLabel}
      </div>
      <div
        className="cgc__zone cgc__variant"
        style={{ ...zoneStyle(z.variant), ...shrink(variantLabel, 18) }}
      >
        {variantLabel.toUpperCase()}
      </div>
      <div className="cgc__zone cgc__status" style={zoneStyle(z.status)}>
        {STATUS_TEXT[status]}
      </div>
      <div className="cgc__zone cgc__mode" style={zoneStyle(z.mode)}>
        {modeText}
      </div>
      {rows.map(([key, value], i) => (
        <div
          key={key}
          className={`cgc__zone cgc__row cgc__row--${key}`}
          style={{ ...zoneStyle(z.rows[i]), ...shrink(value, 9) }}
        >
          {value}
        </div>
      ))}
      <div
        className="cgc__zone cgc__rules"
        style={{ ...zoneStyle(z.rules), ...shrink(rulesLine, 64) }}
      >
        {rulesLine.toUpperCase()}
      </div>

      <button
        type="button"
        className="cgc__hit cgc__hit--view"
        style={zoneStyle(z.view)}
        onClick={onView}
        aria-label="View Game"
      />
      <button
        type="button"
        className="cgc__hit cgc__hit--join"
        style={zoneStyle(z.join)}
        onClick={onJoin}
        disabled={joinDisabled}
        aria-label="Join Game"
      />
      {children}
    </article>
  );
}

/**
 * The rules strip, from a resolved ruleset snapshot, in the words the
 * artwork used: "6-9 HANDED - TRADITIONAL RULES - NO BOMB POTS - BUY-IN
 * 40-200 BB" / "6-MAX - 30% VPIP - 1 SB ANTE - BOMBS EVERY 15 MIN - DOUBLE
 * BOARD". The separator is a middle dot, never an em dash (CLAUDE.md 10.7).
 */
export function rulesLineFor(snapshot: {
  seats?: number;
  seat_choices?: number[];
  seats_locked?: boolean;
  min_buyin_bb?: number;
  max_buyin_bb?: number;
  regular_ante?: 'none' | 'sb' | 'bb';
  vpip_floor?: number;
  bombs?: { enabled?: boolean; trigger?: string | null; boards?: number | null };
}): string {
  const parts: string[] = [];
  const choices = snapshot.seat_choices ?? [];
  if (snapshot.seats_locked || choices.length <= 1) {
    parts.push(`${snapshot.seats ?? 6}-Max`);
  } else if (choices.length === 2) {
    const [a, b] = [...choices].sort((x, y) => x - y);
    parts.push(`${a}-${b} Handed`);
  } else {
    parts.push(`${snapshot.seats ?? 6}-Max`);
  }
  if ((snapshot.vpip_floor ?? 0) > 0) parts.push(`${snapshot.vpip_floor}% VPIP`);
  else parts.push('Traditional Rules');
  if (snapshot.regular_ante === 'sb') parts.push('1 SB Ante');
  else if (snapshot.regular_ante === 'bb') parts.push('1 BB Ante');
  if (snapshot.bombs?.enabled) {
    parts.push(
      snapshot.bombs.trigger === 'every_orbit' ? 'Bombs Every Orbit' : 'Bombs Every 15 Min'
    );
    if ((snapshot.bombs.boards ?? 0) >= 3) parts.push('Triple Board');
    else if ((snapshot.bombs.boards ?? 0) === 2) parts.push('Double Board');
  } else {
    parts.push('No Bomb Pots');
  }
  if (snapshot.min_buyin_bb && snapshot.max_buyin_bb && !snapshot.bombs?.enabled) {
    parts.push(`Buy-In ${snapshot.min_buyin_bb}-${snapshot.max_buyin_bb} BB`);
  }
  return parts.join(' · ');
}
