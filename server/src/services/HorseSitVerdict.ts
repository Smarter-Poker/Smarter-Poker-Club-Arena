/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SIT PREDICATE FOR THE COUNT AND THE CHAIR (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The fleet answers two questions about a horse and a table. The cluster
 * controller asks "how many horses COULD sit here" (the buyer count that
 * opens a feeder), and the seeding loop asks "may THIS horse sit here now"
 * (the chair). Until today those were two different predicates: the
 * candidate filter gated club, door, tag, bankroll and host cap, and the
 * seat stage then asked four MORE questions - can a wallet be resolved, is
 * the sized buy-in above zero, does the aggregate exposure ceiling allow
 * another table, does the Stable Hand mutex say yes - and `continue`d
 * silently on every one of them.
 *
 * Measured 2026-09-05 14:55 CDT: two games opened a feeder every five minutes
 * ("buyers": 2), no horse ever sat on any of them (table_seats rows ever
 * created on those feeders: 0), and the engine log carried NO line about them.
 * The controller was told "2 buyers" for horses the fleet would never seat,
 * abandoned the empty feeder at three minutes, and repeated.
 *
 * This module is the one predicate. It is PURE: it reads the cycle's maps
 * through `ctx`, calls the same helpers the seat stage always called, and
 * returns a verdict plus the bankroll telemetry the decision WOULD emit. The
 * caller emits that telemetry where it acts on the verdict, so a horse judged
 * once for the count and once for the chair is counted once.
 */
import { canOpenAnotherTable, bankrollPolicyFor } from './HorseBankroll.js';
import type { BankrollEvent } from './HorseBankrollTelemetry.js';
import { evaluateSit, gameKey, TWO_HOUR_WINDOW_MS, type SitRejection } from './StableHand.js';
import {
  isRestDayFor,
  sitsOnKeyToday,
  inTwoHourWindow,
  tagKey,
  tagMaxTables,
  type TagBook,
} from './StableHandTags.js';
import {
  rejoinPlayerKey,
  rejoinTableKey,
  type RejoinConstraints,
} from './HorseRejoinConstraints.js';

/** The table fields the verdict reads. Every cash table row carries them. */
export interface SitTable {
  id: string;
  name?: string | null;
  club_id?: string | null;
  union_id?: string | null;
  /** The must-move game this table belongs to (tables.cluster_id). */
  cluster_id?: string | null;
  game_variant?: string | null;
  small_blind?: number | string | null;
  big_blind: number;
  min_buy_in?: number | string | null;
  max_buy_in?: number | string | null;
}

/**
 * THE GAME KEY IS THE GAME, NOT THE TABLE (2026-09-09).
 *
 * The Stable Hand's per-key daily sit cap and two-hour window are written
 * against `gameKey(host, template, variant, sb, bb)`, where `template` is the
 * cash game's template ('classic' / 'action' / 'madness' - see StableHand.test
 * T32 and OPORD section 10). Both callers in this engine passed the TABLE NAME
 * as the template, and a must-move game names its tables differently: "NLH
 * 1/2 Classic", "NLH 1/2 Classic Feeder", "NLH 1/2 Classic Main 2". So one
 * game was three keys: the sit cap counted per chair rather than per game, and
 * the seat-key diff in the seeding cycle read every controller move between a
 * game's tables as a seat GIVEN UP - measured 2026-09-09, 1,438 must-moves in
 * 90 minutes against ~1 real departure a minute, and the cycle line said
 * "5-9 seat(s) given up, 0 sit(s)" every 30 seconds.
 *
 * A cluster table's key is its game (one game per key by construction, Gate
 * 7). A table outside any game keeps its name, exactly as before.
 */
export function gameKeyForTable(table: SitTable): string {
  return gameKey({
    hostId: String(table.club_id ?? ''),
    template: String(table.cluster_id ?? table.name ?? ''),
    variant: String(table.game_variant ?? ''),
    sb: Number(table.small_blind) || 0,
    bb: Number(table.big_blind) || 0,
  });
}

/** What sizing a buy-in returns: the amount, and the telemetry it would emit. */
export interface BuyInSizing {
  buyIn: number;
  telemetry: BankrollEvent[];
}

export interface SitVerdictContext {
  /** Which wallet pays for this horse at this table (resolveSeatClub):
   *  a club id, null for "no membership can pay: not a candidate", undefined
   *  for "the membership map did not load: the database decides". */
  resolveSeatClub: (table: SitTable, horseId: string) => string | null | undefined;
  /** computeHorseBuyIn, with its telemetry collected instead of emitted. */
  sizeBuyIn: (
    table: SitTable,
    horseId: string,
    seatClub: string | null | undefined,
    rejoinFloor: number | undefined
  ) => BuyInSizing;
  /** `${clubId}:${horseId}` -> chip balance. */
  bankrolls: ReadonlyMap<string, number>;
  bankrollsLoaded: boolean;
  rejoin: RejoinConstraints;
  /** horse id -> the tables it sits at, LIVE (grows as the cycle seats). */
  horseTables: ReadonlyMap<string, ReadonlySet<string>>;
  /** horse id -> chips at risk across its seats, LIVE. */
  horseExposure: ReadonlyMap<string, number>;
  activeClubOf: ReadonlyMap<string, string>;
  activeHostOf: ReadonlyMap<string, string>;
  /** The tag book, or null when it could not be read whole (every gate that
   *  consults it then fails OPEN, exactly as the seat stage always did). */
  book: TagBook | null;
  todayKey: string;
  chicagoWeekday: number;
  /**
   * The cycle's own clock, in epoch milliseconds.
   *
   * Passed rather than read here so every verdict in one cycle judges the
   * two-hour window against one moment: a pass that takes seconds must not
   * refuse the first table and admit the last one because the clock moved
   * underneath it.
   */
  nowMs: number;
  /** The Stable Hand kill switch, read once per cycle. */
  killed: boolean;
  /** The platform ceiling on tables per horse (MAX_TABLES_PER_HORSE). */
  maxTablesPerHorse: number;
}

/** Why a horse is not seated at a table. The first three were the seat
 *  stage's silent `continue`s; the rest are the Stable Hand mutex's. */
export type SitSkipReason =
  | 'no_seat_club'
  | 'zero_buy_in'
  | 'aggregate_exposure'
  | Exclude<SitRejection, 'ok'>;

export const SEAT_STAGE_SKIP_REASONS: readonly SitSkipReason[] = [
  'no_seat_club',
  'zero_buy_in',
  'aggregate_exposure',
];

export function isMutexRejection(r: SitSkipReason): r is Exclude<SitRejection, 'ok'> {
  return !(SEAT_STAGE_SKIP_REASONS as readonly string[]).includes(r);
}

export type SitVerdict =
  | {
      ok: true;
      /** The wallet to hand atomic_table_buyin; undefined = database decides. */
      seatClub: string | undefined;
      buyIn: number;
      /** The game key the mutex judged, when it judged: the daily counter is
       *  written against this key, never against a re-derived one. */
      sitKey?: string;
      /** Bankroll telemetry the decision would emit. The caller emits it. */
      telemetry: BankrollEvent[];
    }
  | { ok: false; reason: SitSkipReason; telemetry: BankrollEvent[] };

/**
 * May this horse sit at this table now, and with what? Side-effect free:
 * nothing here writes a counter, a map or a row. Order is the seat stage's
 * own order, unchanged: wallet, buy-in, aggregate ceiling, mutex.
 */
export function sitVerdictFor(
  horseId: string,
  table: SitTable,
  ctx: SitVerdictContext
): SitVerdict {
  const telemetry: BankrollEvent[] = [];

  /* The wallet this seat draws from - the same club the candidate filter
     gated on, the same club the buy-in is sized against, and the club handed
     to atomic_table_buyin as p_club_id. */
  const seatClub = ctx.resolveSeatClub(table, horseId);
  if (seatClub === null) return { ok: false, reason: 'no_seat_club', telemetry };

  /* The buy-in, sized in ONE place (computeHorseBuyIn), with the rejoin floor
     this horse holds in this game read from the same door rules the filter
     used. */
  const rejoinFloor = ctx.rejoin.rejoinFloor.get(rejoinPlayerKey(horseId, rejoinTableKey(table)));
  const sized = ctx.sizeBuyIn(table, horseId, seatClub, rejoinFloor);
  telemetry.push(...sized.telemetry);
  const buyIn = sized.buyIn;
  if (buyIn <= 0) return { ok: false, reason: 'zero_buy_in', telemetry };

  /* THE AGGREGATE CEILING. Everything before this reasons about ONE table;
     `canOpenAnotherTable` is the only rule that sees the horse's whole
     position. Fails open with the rest of the layer: an unreadable roll gets
     no aggregate opinion. */
  if (ctx.bankrollsLoaded) {
    const roll = seatClub ? ctx.bankrolls.get(`${seatClub}:${horseId}`) : undefined;
    if (
      roll !== undefined &&
      !canOpenAnotherTable({
        bankroll: roll,
        liveExposure: ctx.horseExposure.get(horseId) ?? 0,
        nextBuyIn: buyIn,
        policy: bankrollPolicyFor(horseId),
      })
    ) {
      telemetry.push('seat_refused_aggregate_exposure');
      return { ok: false, reason: 'aggregate_exposure', telemetry };
    }
  }

  /* THE MUTEX (Operation Stable Hand section 11), ONLY WHEN THE HORSE IS
     FULLY KNOWN. `maySitOnKey(null, n)` is FALSE by design, so calling it on
     an untagged horse would refuse every one of them - fail-CLOSED, the shape
     of the bug that emptied the cash floor on 2026-08-31. No tag or no state:
     the gates before this are the whole rule. */
  const sitTag = seatClub ? ctx.book?.tags.get(tagKey(horseId, seatClub)) : undefined;
  const sitState = ctx.book?.states.get(horseId);
  let sitKey: string | undefined;
  if (seatClub && sitTag && sitState && sitTag.personaCash) {
    const key = gameKeyForTable(table);
    /* AN UNREAD ROLL IS NULL, NOT ZERO (2026-09-11).
       This was `?? 0`, and zero is a MEASUREMENT: `evaluateSit` fed it to
       `isLicensed(0, bb)`, which is false at every stake, so a cycle whose
       bankroll read failed - the map empty, `bankrollsLoaded` false, every
       OTHER gate in this file and in the candidate filter deliberately
       failing open per the 2026-08-31 doctrine - refused `brm` to every
       tagged horse at every table. One gate failing closed on a number
       nobody read is the exact shape that emptied the cash floor for forty
       minutes that day. Null means "no money opinion"; the identity checks
       still apply and `atomic_table_buyin` is still the wallet's guard. */
    const storedRoll = ctx.bankrolls.get(`${seatClub}:${horseId}`);
    const balance = ctx.bankrollsLoaded && storedRoll !== undefined ? storedRoll : null;
    const verdict = evaluateSit({
      activeClubId: ctx.activeClubOf.get(horseId) ?? null,
      activeHostId: ctx.activeHostOf.get(horseId) ?? null,
      activeSeatCount: ctx.horseTables.get(horseId)?.size ?? 0,
      maxTables: tagMaxTables(sitTag, ctx.maxTablesPerHorse),
      clubId: seatClub,
      tableHostId: String(table.club_id ?? ''),
      bb: Number(table.big_blind) || 0,
      available: balance,
      /* The session-start balance is what the 50% cap is measured against.
         An unknown one falls back to the balance now, which is the same
         number on the first sit of a session.

         A NEW SESSION NEVER INHERITS THE LAST ONE'S START (2026-09-11).
         `session_start_balance` is written when a horse with nothing open
         sits down (HorseFleetManager) and never cleared, so a horse that
         has since stood up everywhere was judged on the balance it started
         a session with hours ago - which after a losing session reads as a
         far larger roll than it holds, and after a winning one as a smaller.
         A horse holding no seat IS starting a session, so its start is the
         balance now. */
      sessionStartBalance:
        balance === null
          ? null
          : (ctx.horseTables.get(horseId)?.size ?? 0) === 0
            ? balance
            : (sitState.sessionStartBalance ?? balance),
      currentCommit: ctx.horseExposure.get(horseId) ?? 0,
      buyIn,
      persona: sitTag.personaCash,
      sitsOnKeyToday: sitsOnKeyToday(sitState, key, ctx.todayKey),
      inTwoHourWindow: inTwoHourWindow(sitState, key, ctx.nowMs, TWO_HOUR_WINDOW_MS),
      isRestDay: isRestDayFor(sitState, ctx.chicagoWeekday),
      killed: ctx.killed,
    });
    if (verdict !== 'ok') return { ok: false, reason: verdict, telemetry };
    sitKey = key;
  }

  return { ok: true, seatClub: seatClub ?? undefined, buyIn, sitKey, telemetry };
}

/** `reason=count reason=count`, non-zero reasons only, in first-seen order. */
export function formatSkipCounts(skipped: ReadonlyMap<string, number>): string {
  return [...skipped]
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${r}=${n}`)
    .join(' ');
}
