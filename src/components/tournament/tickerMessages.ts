/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WHAT THE RAIL SAYS, AND WHICH THING SAYS IT FIRST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Eight sources feed one 34px strip. Until this pass the question "which of
 * them owns the bar" was a five-branch if/else ladder written inline in the
 * render, and the answer was fixed at compile time:
 *
 *     overlay -> starting soon -> operational -> service -> custom
 *
 * Two things were wrong with it. A club owner could not put an urgent SERVICE
 * NOTICE above "New PLO Table Open", which is the whole reason the maintenance
 * source exists. And nothing ever EXPIRED: a custom message ran until somebody
 * remembered to delete it, and an operational message rebuilt itself on the
 * next poll after a player had closed it.
 *
 * So the ladder becomes data. Every announcement is a TickerItem carrying its
 * own severity and its own expiry, they are ranked, and the highest one owns
 * the bar.
 *
 * ── THE ONE ORDERING CHANGE, STATED (audit 2026-09-05) ──────────────────────
 *
 * SERVICE NOTICE and CLUB UPDATE now outrank the three low-value operational
 * sources - guarantees, results and table openings - so a club that has
 * something to say can be heard over "New PLO Table Open". Everything else
 * keeps the order it had: an overlay still takes the bar from a countdown, a
 * countdown still takes it from anything operational, and REGISTRATION CLOSING
 * stays above the operator's own messages, because that message only ever
 * appears inside a five-minute window and a door that is shutting now cannot
 * wait behind a notice about tonight.
 *
 * ── LANES ───────────────────────────────────────────────────────────────────
 *
 * One bar. If two events land in the same window the marquee carries both
 * rather than stacking strips over the felt - but only when they are the same
 * KIND of thing. The top-ranked item's LANE owns the bar and every item in that
 * lane rides with it, which is the behaviour the old ladder had and the reason
 * it grouped the four operational sources together.
 *
 * ── THE CLOCK IS A PLACEHOLDER, NOT A NUMBER ────────────────────────────────
 *
 * "Registration Closes In 4:12" used to be baked into a string at POLL time and
 * only the starting-soon line was recomposed by the one-second tick. For up to
 * thirty seconds the bar showed a number that was simply wrong, on the one
 * message whose entire value is the number. Items now carry `deadlineMs` and
 * the literal token `{clock}`, and the clock is substituted at RENDER. Every
 * countdown on the bar is live, from every source.
 *
 * Pure on purpose. No React, no DOM, no Supabase, no clock of its own - `now`
 * is always a parameter. Same shape as overlayAnnouncements and topChrome.
 */

import { formatGameTitle } from '../../utils/formatGameTitle';
import { formatPopupText } from '../../utils/popupStyle';
import { formatBuyInShort } from '../../utils/buyIn';
import { overlayMessage, type OverlayAnnouncement } from '../../utils/overlayAnnouncements';
import type { TickerTone } from './tickerTheme';

export type TickerKind =
  | 'overlays'
  | 'starting_soon'
  | 'registration_closing'
  | 'guarantees'
  | 'table_openings'
  | 'winner_results'
  | 'maintenance'
  | 'custom_messages';

/** Which items are allowed to share the bar with each other. */
export type TickerLane = 'alert' | 'countdown' | 'service' | 'custom' | 'operational';

export interface TickerItem {
  /** Stable across polls: this is what a dismissal is remembered against. */
  id: string;
  kind: TickerKind;
  lane: TickerLane;
  tone: TickerTone;
  /** The chip at the left edge. Already upper case. */
  flag: string;
  /** Higher wins the bar. */
  severity: number;
  /** Title Cased fields. One may contain the literal token `{clock}`. */
  parts: string[];
  /** Absolute epoch ms the `{clock}` token counts down to. */
  deadlineMs?: number;
  /** Absolute epoch ms after which the item is dropped, poll or no poll. */
  expiresAt?: number;
  /** Where clicking the bar goes. */
  tournamentId?: string;
  tableId?: string;
  /**
   * What this announcement is ABOUT, in plain words - a tournament name, a
   * table name, or the operator's own line.
   *
   * Two things need it and neither can use the rendered copy. The dismiss
   * button has to be labelled "Dismiss The Announcement For Sunday Slam"
   * rather than for "STARTING SOON": the first render test written for this
   * bar found two buttons answering to the same name, because the close
   * control was labelled with the FLAG. And the five-minute toast has to name
   * the event without holding on to the row it came from.
   */
  subject: string;
  /** Whether the viewer has already paid to enter. Drives the toasts only. */
  registeredByViewer?: boolean;
}

/** Between the fields of one announcement. */
export const FIELD_SEPARATOR = ' · ';

/**
 * The token a live countdown replaces.
 *
 * Lower case here and matched case-insensitively at render, because
 * `formatPopupText` capitalises the first letter of every word and would
 * otherwise turn `{clock}` into `{Clock}` on the way in.
 */
export const CLOCK_TOKEN = '{clock}';
const CLOCK_PATTERN = /\{clock\}/gi;

/**
 * The ranking. Written as one table so the order is readable in one screen
 * instead of being spread across five nested ternaries in a JSX block.
 */
const SEVERITY: Record<TickerKind, number> = {
  overlays: 100,
  starting_soon: 80,
  registration_closing: 72,
  maintenance: 68,
  custom_messages: 60,
  guarantees: 48,
  winner_results: 40,
  table_openings: 32,
};

const LANE: Record<TickerKind, TickerLane> = {
  overlays: 'alert',
  starting_soon: 'countdown',
  maintenance: 'service',
  custom_messages: 'custom',
  registration_closing: 'operational',
  guarantees: 'operational',
  winner_results: 'operational',
  table_openings: 'operational',
};

const TONE: Record<TickerKind, TickerTone> = {
  overlays: 'money',
  starting_soon: 'time',
  registration_closing: 'time',
  guarantees: 'money',
  maintenance: 'service',
  custom_messages: 'service',
  winner_results: 'info',
  table_openings: 'info',
};

/** "4:07" / "0:12". Never negative - at zero the event is starting. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** House copy rule: First Letter Of Every Word, no em dashes. */
function copy(text: string): string {
  return formatPopupText(text);
}

function item(base: TickerItem): TickerItem {
  return base;
}

/* ── COMPOSERS ─────────────────────────────────────────────────────────────
   One per source. Each returns the item or null; none of them reads a clock
   that is not passed in. */

export interface UpcomingTournament {
  id: string;
  name: string;
  startsAt: number;
  clubId: string | null;
  /** tournaments.buy_in_amount - the PRIZE side only. */
  buyIn: number;
  /** tournaments.buy_in_fee - the house cut. */
  buyInFee: number;
  registered: number;
  isRegistered: boolean;
}

/**
 * "Sunday Slam Starts In 4:07 - Buy-In 11 - 24 Entered"
 *
 * BUY-IN IS THE TOTAL, NOT THE PRIZE SIDE (audit 2026-09-05). The bar used to
 * print `buy_in_amount`, which is what reaches the prize pool after the house
 * cut. On an 11-chip event that is 9, so the strip advertised "Buy-In 9" beside
 * a name reading "$11" and understated the one figure a player decides on.
 * `formatBuyInShort` is the same helper the lobby card and the register button
 * already use, so all three now quote the same number.
 *
 * No currency symbol, deliberately: `money()` prints bare whole chips
 * everywhere else in this app and a lone "$" on the ticker would be the only
 * one on the platform.
 */
export function startingSoonItem(t: UpcomingTournament): TickerItem {
  const cost = formatBuyInShort(t.buyIn, t.buyInFee);
  return item({
    id: `soon-${t.id}`,
    kind: 'starting_soon',
    lane: LANE.starting_soon,
    tone: TONE.starting_soon,
    flag: 'STARTING SOON',
    severity: SEVERITY.starting_soon,
    parts: [
      copy(`${formatGameTitle(t.name)} starts in ${CLOCK_TOKEN}`),
      copy(`buy-in ${cost}`),
      copy(`${t.registered.toLocaleString()} entered`),
    ],
    deadlineMs: t.startsAt,
    subject: formatGameTitle(t.name),
    registeredByViewer: t.isRegistered,
    // Matches the window the render used to filter on: an event stays on the
    // bar for thirty seconds past its start time, then it is simply running.
    expiresAt: t.startsAt + 30_000,
    tournamentId: t.id,
  });
}

export function overlayItem(a: OverlayAnnouncement): TickerItem {
  return item({
    id: `overlay-${a.id}`,
    kind: 'overlays',
    lane: LANE.overlays,
    tone: TONE.overlays,
    flag: a.tier === 'live' ? 'OVERLAY' : 'POTENTIAL OVERLAY',
    severity: a.tier === 'live' ? SEVERITY.overlays : SEVERITY.overlays - 10,
    parts: [copy(overlayMessage(a))],
    subject: a.name,
    tournamentId: a.id,
  });
}

export function registrationClosingItem(
  tournamentId: string,
  name: string,
  closesAtMs: number
): TickerItem {
  return item({
    id: `reg-${tournamentId}`,
    kind: 'registration_closing',
    lane: LANE.registration_closing,
    tone: TONE.registration_closing,
    flag: 'REG CLOSING',
    severity: SEVERITY.registration_closing,
    parts: [copy(`${formatGameTitle(name)} registration closes in ${CLOCK_TOKEN}`)],
    deadlineMs: closesAtMs,
    expiresAt: closesAtMs,
    subject: formatGameTitle(name),
    tournamentId,
  });
}

export function guaranteeItem(
  tournamentId: string,
  name: string,
  guarantee: number,
  entered: number,
  startsAtMs: number
): TickerItem {
  return item({
    id: `gtd-${tournamentId}`,
    kind: 'guarantees',
    lane: LANE.guarantees,
    tone: TONE.guarantees,
    flag: 'GUARANTEED',
    severity: SEVERITY.guarantees,
    parts: [
      copy(`${Math.round(guarantee).toLocaleString()} guaranteed`),
      copy(formatGameTitle(name)),
      copy(`${Math.round(entered).toLocaleString()} entered`),
      copy(`starts in ${CLOCK_TOKEN}`),
    ],
    deadlineMs: startsAtMs,
    expiresAt: startsAtMs,
    subject: formatGameTitle(name),
    tournamentId,
  });
}

export function winnerResultsItem(
  tournamentId: string,
  name: string,
  prizePool: number,
  endedAtMs: number
): TickerItem {
  return item({
    id: `result-${tournamentId}`,
    kind: 'winner_results',
    lane: LANE.winner_results,
    tone: TONE.winner_results,
    flag: 'RESULTS',
    severity: SEVERITY.winner_results,
    parts: [
      copy(`${formatGameTitle(name)} is complete`),
      copy(`${Math.round(prizePool).toLocaleString()} prize pool`),
      copy('results available'),
    ],
    expiresAt: endedAtMs + 10 * 60_000,
    subject: formatGameTitle(name),
    tournamentId,
  });
}

export function tableOpeningItem(
  tableId: string,
  name: string,
  variant: string,
  createdAtMs: number
): TickerItem {
  return item({
    id: `table-${tableId}`,
    kind: 'table_openings',
    lane: LANE.table_openings,
    tone: TONE.table_openings,
    flag: 'TABLE OPEN',
    severity: SEVERITY.table_openings,
    parts: [
      copy(`new ${formatGameTitle(String(variant || 'poker'))} table open`),
      copy(formatGameTitle(name)),
      copy('seats available'),
    ],
    expiresAt: createdAtMs + 10 * 60_000,
    subject: formatGameTitle(name),
    tableId,
  });
}

/**
 * An operator's own line. The index is part of the id so that editing message
 * two does not silently un-dismiss message one.
 */
export function operatorItem(
  kind: 'maintenance' | 'custom_messages',
  index: number,
  message: string
): TickerItem {
  return item({
    id: `${kind}-${index}-${hashMessage(message)}`,
    kind,
    lane: LANE[kind],
    tone: TONE[kind],
    flag: kind === 'maintenance' ? 'SERVICE NOTICE' : 'CLUB UPDATE',
    severity: SEVERITY[kind],
    parts: [copy(message)],
    subject: copy(message.slice(0, 40)),
  });
}

/**
 * A short, stable fingerprint of an operator message.
 *
 * The id has to change when the TEXT changes - a club that rewrites its notice
 * is saying something new and a player who closed the old one has not closed
 * the new one - and it has to stay identical across polls while the text does
 * not. djb2 over the string is enough for both; this is a cache key, not a
 * security boundary.
 */
export function hashMessage(message: string): string {
  let h = 5381;
  for (let i = 0; i < message.length; i += 1) {
    h = ((h << 5) + h + message.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/* ── RANKING AND RENDER ────────────────────────────────────────────────────*/

/** The item's fields, with any live clock filled in. */
export function renderTickerItem(entry: TickerItem, now: number): string {
  const clock = typeof entry.deadlineMs === 'number' ? countdown(entry.deadlineMs - now) : '';
  return entry.parts
    .map((part) => part.replace(CLOCK_PATTERN, clock))
    .join(FIELD_SEPARATOR)
    .trim();
}

/** Seconds left on this item's clock, or null when it does not carry one. */
export function secondsLeft(entry: TickerItem, now: number): number | null {
  if (typeof entry.deadlineMs !== 'number') return null;
  return Math.max(0, Math.round((entry.deadlineMs - now) / 1000));
}

/**
 * Everything still worth saying, strongest first.
 *
 * Drops expired items even if the poll that produced them has not run again,
 * which is what stops a finished countdown sitting on the bar for the rest of
 * its thirty-second window.
 */
export function rankTickerItems(items: ReadonlyArray<TickerItem>, now: number): TickerItem[] {
  return items
    .filter((entry) => !entry.expiresAt || entry.expiresAt > now)
    .slice()
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      const aDue = a.deadlineMs ?? Number.POSITIVE_INFINITY;
      const bDue = b.deadlineMs ?? Number.POSITIVE_INFINITY;
      if (aDue !== bDue) return aDue - bDue;
      return a.id.localeCompare(b.id);
    });
}

/**
 * The items that actually go on the bar: the strongest one, plus everything in
 * its lane. One bar, and the strongest claim wins it.
 */
export function tickerLaneFor(
  items: ReadonlyArray<TickerItem>,
  now: number,
  limit = 8
): TickerItem[] {
  const ranked = rankTickerItems(items, now);
  if (ranked.length === 0) return [];
  const lane = ranked[0].lane;
  return ranked.filter((entry) => entry.lane === lane).slice(0, Math.max(1, limit));
}

/**
 * The line a SCREEN READER hears, which is not the line the eye reads.
 *
 * The strip used to be `role="status" aria-live="polite"` wrapped around text
 * containing a countdown that mutated every 1,000ms, so every tick queued
 * another announcement of the whole bar. For a screen-reader user at a table
 * that is not an accessible ticker, it is a denial of service on their audio
 * channel.
 *
 * The visual copy is `aria-hidden` now and this is what is announced instead:
 * the same news, rounded to the minute, so it changes about five times over a
 * five-minute window rather than three hundred. "Press to register" is there
 * because the bar is a button and nothing else says so.
 */
export function announcementFor(entry: TickerItem, now: number): string {
  const left = secondsLeft(entry, now);
  const coarse =
    left === null
      ? ''
      : left <= 0
        ? 'now'
        : left < 60
          ? 'under a minute'
          : left < 120
            ? '1 minute'
            : // FLOOR, not round. Rounding flips the spoken value halfway
              // through a minute, so a reader hears "4 minutes" and then
              // "3 minutes" four seconds later - the exact re-announcement
              // this coarse form exists to prevent. It also never overstates
              // the time a player has left.
              `${Math.floor(left / 60)} minutes`;
  const body = entry.parts
    .map((part) => part.replace(CLOCK_PATTERN, coarse))
    .join(FIELD_SEPARATOR)
    .trim();
  const action = entry.tableId ? 'Press To Open The Table' : 'Press To Register';
  return copy(`${entry.flag}. ${body}. ${action}.`);
}
