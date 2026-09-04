/**
 * OPERATION STABLE HAND - the floor planner.
 *
 * Reads a snapshot of the floor, returns the orders to execute. The planner
 * is PURE: same snapshot in, same plan out, no clock and no IO. The fleet
 * manager does the seating; this decides what seating should happen.
 *
 * That split is deliberate. The seating path already exists, is exercised
 * every 30 seconds against real money, and survived three separate incidents
 * to get where it is. Rewriting it to add a shape controller would put all of
 * Sections 5 and 11 inside the one function nobody can test without a
 * database. A planner can be tested exhaustively and executed cautiously.
 */

import {
  occupancyTargetForHost,
  shapeTargets,
  seatsForBucket,
  bucketOf,
  neediestStakeBand,
  stakeBandOf,
  stakeIsLegalThisPhase,
  yieldDelayMs,
  yieldCount,
  pickYieldVictims,
  SEAT_HOLD_MS,
  planExoticTrim,
  planLimitGames,
  isExotic,
  isLimitGame,
  canonicalExotic,
  seatsPerHorseBand,
  peakCap,
  nightCap,
  isNightWindow,
  STAKE_LADDER,
  NIGHT_MIN_PLAYERS,
  nightTablesNeeded,
  MIDWAY_UNION_ID,
  DSS_CLUB_ID,
  type ShapeBucket,
  type StakeBand,
  type YieldCandidate,
} from './StableHand.js';

export interface TableSnapshot {
  tableId: string;
  hostId: string;
  variant: string;
  sb: number;
  bb: number;
  maxPlayers: number;
  /** Every seated player, horse or human. */
  occupied: number;
  humansSeated: number;
  humansWaiting: number;
  /**
   * When the LONGEST-WAITING human at this table joined the list, in ms.
   *
   * The planner does not read it - a plan is a decision, not a schedule. The
   * executor does: a yield's 2-5 minute delay is measured from the moment the
   * human joined, never from the moment a 30-second cycle first noticed them,
   * or the window Dan specified quietly becomes 2 to 5-and-a-half.
   */
  waitlistOldestJoinedAtMs?: number;
  /** Horses currently in the seats, for yield selection. */
  seatedHorses: YieldCandidate[];
  status: string;
  waitlistId?: string;
}

export interface HostSnapshot {
  hostId: string;
  /** Unique BODIES eligible for this host. Union 584, DSS 416. */
  n: number;
  /** Unique bodies currently seated anywhere on this host. */
  uniqueLive: number;
  tables: TableSnapshot[];
}

export interface FloorSnapshot {
  chicagoHour: number;
  chicagoMinute: number;
  hosts: HostSnapshot[];
  killed: boolean;
  /**
   * Hosts whose floor could not be read COMPLETELY, and which are therefore
   * absent from `hosts` rather than present with short numbers.
   *
   * A host that cannot be measured must not be managed. See
   * StableHandSnapshot: on 2026-09-04 the population read returned 0 for both
   * hosts because of an ambiguous PostgREST embed, and n is the denominator of
   * every cap, so a floor of 188 live horses read as 188 over the cap and the
   * plan asked for 170 stands.
   */
  unreadableHosts?: string[];
}

export interface SeatOrder {
  tableId: string;
  hostId: string;
  seats: number;
  reason: 'shape_full' | 'shape_joinable' | 'occupancy_ramp';
}
export interface StandOrder {
  tableId: string;
  horseId: string;
  reason: 'human_yield' | 'shape_adjust' | 'occupancy_wind_down';
  delayMs: number;
  holdSeatMs?: number;
}
export interface OpenOrder {
  hostId: string;
  variant: string;
  band: StakeBand;
  count: number;
}

export interface FloorPlan {
  seat: SeatOrder[];
  stand: StandOrder[];
  open: OpenOrder[];
  /**
   * Tables to close PERMANENTLY: the exotic and limit excess, which is a
   * standing rule about how many of each game the fleet can support and not a
   * time-of-day one. Executed by marking `settings.retire_when_empty`, which
   * drains the table and closes it once genuinely empty - and which the fleet
   * deliberately never reopens.
   */
  close: string[];
  /**
   * Tables to park for the NIGHT and reopen in the morning. Dan 2026-09-04:
   * "fewer tables, more players at each table. late night shouldn't have any
   * 2-3 handed games."
   *
   * A separate list from `close` because the two have opposite lifetimes, and
   * confusing them is how one quiet night would permanently delete a floor:
   * `retire_when_empty` is checked by ensureAllTablesExist specifically SO
   * THAT a retired table is never reopened. A park must come back at 08:00.
   */
  park: string[];
  alerts: string[];
  metrics: HostMetrics[];
}

export interface HostMetrics {
  hostId: string;
  n: number;
  uniqueLive: number;
  target: number;
  min: number;
  max: number;
  peakCap: number;
  nightCap: number;
  liveSeats: number;
  avgSeatsPerHorse: number;
  full: number;
  oneOpen: number;
  joinable: number;
  targetFull: number;
  targetOneOpen: number;
  targetJoinable: number;
  humansWaiting: number;
  onePlayerTablesListed: number;
}

/**
 * Tables that count toward shape: LIVE cash tables inside the phase clamp.
 *
 * ── WHY THIS IS NOT `status === 'running'` (2026-09-04) ────────────────────
 *
 * It was, and the first live reading of the floor found the consequence.
 * Measured at 03:58, minutes after an hourly engine restart:
 *
 *   Midway Union       80 open tables, 74 of them with players, 362 seats
 *   Deep Stack Society 167 open tables, 128 with players, 350 seats
 *   tables with status 'running'                                          0
 *
 * Every live cash table on the platform read `waiting`. `status` is not a
 * statement about whether a game is being played - HorseFleetManager sets it
 * to 'running' as a SIDE EFFECT once a second player sits, and the hourly
 * maintenance restart leaves the whole floor back at 'waiting'. So for part of
 * every hour the entire shape half of the planner - the buckets, the seat
 * orders, the joinable guarantee, the occupancy wind-down - was reasoning
 * about an EMPTY list and confidently reporting a floor of nothing.
 *
 * CLAUDE.md section 13 rule 3 says the same thing about the other status
 * string: never gate a table on `tables.status`. Occupancy is a fact about
 * SEATS, and seats are what this reads. The snapshot has already excluded
 * closed and tournament tables, so anything reaching here is a real, open,
 * playable cash table whether or not a hand happens to be in progress.
 *
 * Human yield never depended on this - it loops every table on the host - so
 * a waiting player was always served. Everything else was blind.
 */
function shapedTables(h: HostSnapshot): TableSnapshot[] {
  return h.tables.filter((t) => t.status !== 'closed' && stakeIsLegalThisPhase(t.bb));
}

export function planFloor(snap: FloorSnapshot): FloorPlan {
  const plan: FloorPlan = {
    seat: [],
    stand: [],
    open: [],
    close: [],
    park: [],
    alerts: [],
    metrics: [],
  };

  for (const hostId of snap.unreadableHosts ?? []) {
    plan.alerts.push(`host_unreadable host=${hostId}`);
  }

  for (const host of snap.hosts) {
    const running = shapedTables(host);
    const targets = shapeTargets(running.length);
    const occ = occupancyTargetForHost(host.n, snap.chicagoHour, snap.chicagoMinute);

    const buckets = {
      FULL: [] as TableSnapshot[],
      ONE_OPEN: [] as TableSnapshot[],
      JOINABLE: [] as TableSnapshot[],
      UNDER: [] as TableSnapshot[],
      OVER: [] as TableSnapshot[],
    };
    running.forEach((t) => buckets[bucketOf(t.occupied, t.maxPlayers)].push(t));

    const liveSeats = host.tables.reduce((s, t) => s + t.occupied, 0);
    const humansWaiting = host.tables.reduce((s, t) => s + t.humansWaiting, 0);

    /* ── A ZERO POPULATION IS NOT A SMALL FLEET (2026-09-04) ───────────────
       `n` is the denominator of peakCap, nightCap and the whole occupancy
       curve. At n = 0 every cap is 0, so ANY live horse reads as over the cap
       and the wind-down branch below asks for a stand at every table on the
       host. That is not hypothetical: the first live run of the dashboard
       reported n = 0 for both hosts against a fleet of 1,000, and the plan
       asked for 170 stands.

       The snapshot now leaves an unreadable host out entirely, so this should
       be unreachable. It is here anyway, because the cost of the two being
       wrong at once is the cash floor, and because a caller building its own
       snapshot deserves the same protection. Human yield is deliberately NOT
       gated on it - a yield does not depend on the population and a waiting
       human is not made to wait for a failed read. */
    const populationKnown = host.n > 0;
    if (!populationKnown) {
      plan.alerts.push(`host_population_unknown host=${host.hostId} live=${host.uniqueLive}`);
    }

    /* ── HUMAN YIELD RUNS FIRST, AND RUNS EVEN WHEN KILLED ─────────────
       Section 5.5 and the kill-switch contract both. A kill switch that
       strands a waiting human is not a safety feature, it is a second
       outage. */
    for (const t of host.tables) {
      if (t.humansWaiting <= 0) continue;
      const want = yieldCount(t.humansWaiting);
      const victims = pickYieldVictims(t.seatedHorses, want);
      for (const horseId of victims) {
        plan.stand.push({
          tableId: t.tableId,
          horseId,
          reason: 'human_yield',
          delayMs: yieldDelayMs(horseId, t.tableId, t.waitlistId ?? t.tableId),
          holdSeatMs: SEAT_HOLD_MS,
        });
      }
      if (victims.length > 0 && victims.length > t.humansWaiting + 1) {
        plan.alerts.push(
          `yield_overshoot table=${t.tableId} victims=${victims.length} waiting=${t.humansWaiting}`
        );
      }
    }

    // A one-player table must never be listed as joinable (Section 5.2).
    const onePlayer = running.filter((t) => t.occupied === 1).length;
    if (onePlayer > 0)
      plan.alerts.push(`one_player_table_listed host=${host.hostId} count=${onePlayer}`);

    if (!snap.killed && populationKnown) {
      const roomForMore = host.uniqueLive < occ.max;

      // 1. Fill the FULL bucket to target.
      const needFull = targets.full - buckets.FULL.length;
      if (needFull > 0 && roomForMore) {
        const fillable = [
          ...buckets.ONE_OPEN,
          ...buckets.OVER,
          ...buckets.JOINABLE,
          ...buckets.UNDER,
        ]
          .sort((a, b) => b.occupied - a.occupied)
          .slice(0, needFull);
        fillable.forEach((t) =>
          plan.seat.push({
            tableId: t.tableId,
            hostId: host.hostId,
            seats: t.maxPlayers - t.occupied,
            reason: 'shape_full',
          })
        );
      }

      // 2. Convert a FULL table down to ONE_OPEN by standing exactly one horse.
      const needOneOpen = targets.oneOpen - buckets.ONE_OPEN.length;
      if (needOneOpen > 0) {
        buckets.FULL.slice(0, needOneOpen).forEach((t) => {
          const victim = pickYieldVictims(t.seatedHorses, 1)[0];
          if (victim) {
            plan.stand.push({
              tableId: t.tableId,
              horseId: victim,
              reason: 'shape_adjust',
              delayMs: 0,
            });
          }
        });
      }

      // 3. Make a JOINABLE table. Prefer CONVERTING when occupancy is near the
      //    cap - opening a new table there would breach it.
      const needJoinable = targets.joinable - buckets.JOINABLE.length;
      if (needJoinable > 0) {
        const nearCap = host.uniqueLive >= occ.target;
        if (nearCap || !roomForMore) {
          buckets.FULL.slice(
            needOneOpen > 0 ? needOneOpen : 0,
            (needOneOpen > 0 ? needOneOpen : 0) + needJoinable
          ).forEach((t) => {
            const j = seatsForBucket('JOINABLE', t.maxPlayers);
            const toStand = Math.max(0, t.occupied - j.max);
            pickYieldVictims(t.seatedHorses, toStand).forEach((horseId, i) =>
              plan.stand.push({
                tableId: t.tableId,
                horseId,
                reason: 'shape_adjust',
                // Staggered 2-5 min so a table does not empty in one tick.
                delayMs: yieldDelayMs(horseId, t.tableId, `shape-${i}`),
              })
            );
          });
        } else {
          const bandSeats: Record<StakeBand, number> = { micro: 0, low: 0, top: 0 };
          running.forEach((t) => {
            const b = stakeBandOf(t.bb);
            if (b) bandSeats[b] += t.occupied;
          });
          plan.open.push({
            hostId: host.hostId,
            variant: 'nlh',
            band: neediestStakeBand(bandSeats),
            count: needJoinable,
          });
        }
      }

      // 4. Occupancy ramp / wind-down against the curve.
      if (host.uniqueLive < occ.min) {
        /* SECTION 5.3 RULE 6: an add-seat may never push a table OUT of its
           bucket. A ramp that reaches for "any table with a free seat" fills
           the ONE_OPEN tables first - they are the ones with a free seat by
           definition - and quietly destroys the 20% of the floor a human is
           supposed to be able to sit down at. Only tables that are already
           outside a target bucket can absorb a ramp seat; everything else
           needs a NEW table. */
        const short = occ.min - host.uniqueLive;
        const absorbable = [...buckets.UNDER, ...buckets.OVER]
          .filter((t) => t.occupied < t.maxPlayers - 1)
          .slice(0, short);
        absorbable.forEach((t) =>
          plan.seat.push({
            tableId: t.tableId,
            hostId: host.hostId,
            seats: 1,
            reason: 'occupancy_ramp',
          })
        );
        const stillShort = short - absorbable.length;
        if (stillShort > 0 && roomForMore) {
          const bandSeats: Record<StakeBand, number> = { micro: 0, low: 0, top: 0 };
          running.forEach((t) => {
            const b = stakeBandOf(t.bb);
            if (b) bandSeats[b] += t.occupied;
          });
          plan.open.push({
            hostId: host.hostId,
            variant: 'nlh',
            band: neediestStakeBand(bandSeats),
            count: Math.max(1, Math.ceil(stillShort / 6)),
          });
        }
      } else if (host.uniqueLive > occ.max) {
        const over = host.uniqueLive - occ.max;
        plan.alerts.push(
          `occupancy_over host=${host.hostId} live=${host.uniqueLive} max=${occ.max} clamped_by=${occ.clampedBy}`
        );
        running
          .slice()
          .sort((a, b) => a.occupied - b.occupied)
          .slice(0, over)
          .forEach((t) => {
            const victim = pickYieldVictims(t.seatedHorses, 1)[0];
            if (victim)
              plan.stand.push({
                tableId: t.tableId,
                horseId: victim,
                reason: 'occupancy_wind_down',
                delayMs: 0,
              });
          });
      }
    }

    // 5. Exotic and limit caps, per variant.
    const byVariant = new Map<string, TableSnapshot[]>();
    host.tables.forEach((t) => {
      const key = isLimitGame(t.variant)
        ? t.variant.toLowerCase()
        : (canonicalExotic(t.variant) ?? '');
      if (!key) return;
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key)!.push(t);
    });
    for (const [variant, ts] of byVariant) {
      const rows = ts.map((t) => ({ tableId: t.tableId, variant, bb: t.bb, seated: t.occupied }));
      const p = isLimitGame(variant) ? planLimitGames(rows, host.n) : planExoticTrim(rows, host.n);
      plan.close.push(...p.close);
      if (p.mayOpen > 0 && !snap.killed) {
        plan.open.push({ hostId: host.hostId, variant, band: 'low', count: p.mayOpen });
      }
      ts.filter((t) => t.bb > 2).forEach((t) =>
        plan.alerts.push(
          `exotic_above_half host=${host.hostId} variant=${variant} table=${t.tableId} bb=${t.bb}`
        )
      );
    }

    /* ── LATE NIGHT: FEWER TABLES, MORE PLAYERS AT EACH ────────────────
       Dan 2026-09-04: "fewer tables, more players at each table. late night
       shouldn't have any 2-3 handed games."

       At 5% of the population there are about sixty seats to place on Midway
       Union overnight. Spread across eighty open tables that is one player a
       table; the head count would be right and the room would look dead. So
       the thin tables are PARKED - drained of horses and closed once empty -
       and the seats concentrate onto the ones that stay.

       PARKED IS NOT CLOSED. It is written to a different settings flag with a
       different lifetime, it is lifted every morning, and nothing here can
       reach `retire_when_empty`. See FloorPlan.park.

       THREE THINGS ARE NEVER PARKED, and each is a way this could go wrong:
         - a table with a HUMAN seated. Parking it stops the seeder refilling
           it, which is how a person ends up alone at a table nobody can join.
         - a table with a human WAITING. They are queuing for that game.
         - the fullest tables the host still NEEDS, whatever their count. The
           wind-down thins tables as it runs, so without a floor the parking
           cascades: every table drops under the minimum, every table is
           parked, and the host has nowhere to seat anybody. The number is
           derived from the cap rather than fixed - 29 bodies at up to 1.3
           seats each is 38 seats and needs seven full rings, not six. */
    if (isNightWindow(snap.chicagoHour)) {
      const parkable = running
        .filter((t) => t.humansSeated === 0 && t.humansWaiting === 0)
        .sort((a, b) => b.occupied - a.occupied);
      const keepOpen = nightTablesNeeded(occ.max, snap.chicagoHour);
      const keep = new Set(parkable.slice(0, keepOpen).map((t) => t.tableId));
      let parkedHere = 0;
      for (const t of parkable) {
        if (keep.has(t.tableId)) continue;
        if (t.occupied >= NIGHT_MIN_PLAYERS) continue;
        plan.park.push(t.tableId);
        parkedHere++;
      }
      if (parkedHere > 0) {
        plan.alerts.push(
          `night_parking host=${host.hostId} parking=${parkedHere} of=${running.length}`
        );
      }
    }

    if (populationKnown) {
      if (host.uniqueLive > peakCap(host.n)) plan.alerts.push(`over_peak_cap host=${host.hostId}`);
      if (isNightWindow(snap.chicagoHour) && host.uniqueLive > nightCap(host.n)) {
        plan.alerts.push(`over_night_cap host=${host.hostId}`);
      }
    }
    const band = seatsPerHorseBand(snap.chicagoHour);
    const avg = host.uniqueLive > 0 ? liveSeats / host.uniqueLive : 0;
    if (host.uniqueLive > 0 && (avg < band.min || avg > band.max)) {
      plan.alerts.push(`seats_per_horse_out_of_band host=${host.hostId} avg=${avg.toFixed(2)}`);
    }
    const shapeError =
      Math.abs(buckets.FULL.length - targets.full) +
      Math.abs(buckets.ONE_OPEN.length - targets.oneOpen) +
      Math.abs(buckets.JOINABLE.length - targets.joinable);
    if (shapeError > 10) plan.alerts.push(`shape_error host=${host.hostId} error=${shapeError}`);

    plan.metrics.push({
      hostId: host.hostId,
      n: host.n,
      uniqueLive: host.uniqueLive,
      target: occ.target,
      min: occ.min,
      max: occ.max,
      peakCap: occ.peakCap,
      nightCap: occ.nightCap,
      liveSeats,
      avgSeatsPerHorse: Number(avg.toFixed(2)),
      full: buckets.FULL.length,
      oneOpen: buckets.ONE_OPEN.length,
      joinable: buckets.JOINABLE.length,
      targetFull: targets.full,
      targetOneOpen: targets.oneOpen,
      targetJoinable: targets.joinable,
      humansWaiting,
      onePlayerTablesListed: onePlayer,
    });
  }

  /* A table already being closed for good is never also parked. The two
     flags have opposite lifetimes and writing both to one row is how a
     permanent retirement gets lifted by the morning unpark. */
  if (plan.park.length > 0 && plan.close.length > 0) {
    const closing = new Set(plan.close);
    plan.park = plan.park.filter((id) => !closing.has(id));
  }

  return plan;
}

/** America/Chicago wall clock without pulling in a tz library. */
export function chicagoNow(d: Date = new Date()): {
  hour: number;
  minute: number;
  weekday: number;
} {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: Math.max(0, days.indexOf(String(parts.weekday))),
  };
}

export const STABLE_HAND_HOSTS = [MIDWAY_UNION_ID, DSS_CLUB_ID];
export type { ShapeBucket };

/* ══════════════════════════════════════════════════════════════════════════
   THE SEEDING SIDE OF THE CURVE

   The planner can stand horses up all it likes; if the fleet manager refills
   the seat thirty seconds later, all that happens is churn - a cash-out and a
   buy-in per horse per cycle, which is both expensive and the single loudest
   tell a floor can have. So the curve has to be visible to the seeder too, and
   this is the whole of what it needs to know.

   IT ONLY EVER REFUSES A NEW BODY. It cannot stand anybody up, it cannot
   shorten a session, and a horse already seated on the host may still open
   another table - that is what makes it a UNIQUE-OCCUPANCY cap rather than a
   seat cap, and it is why multi-tabling is unaffected. Nothing here can empty
   a floor: an unreadable population yields no cap at all, which is exactly
   today's behaviour.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The blinds a new table of this band opens at.
 *
 * The HIGHEST rung inside the band, because the alternative - the lowest - puts
 * every new micro table at 0.01/0.02, and a floor whose new games are always
 * its cheapest is not a floor anybody grows into. Never above the phase clamp
 * by construction: `stakeBandOf` returns null past it, so no band maps there.
 */
export function stakeForBand(band: StakeBand): { sb: number; bb: number } | null {
  const inBand = STAKE_LADDER.filter((s) => stakeBandOf(s.bb) === band);
  return inBand.length === 0 ? null : inBand[inBand.length - 1];
}

/**
 * The most unique BODIES each host may carry right now, from the 24-hour
 * curve. A host with no readable population gets no entry, and a caller with
 * no entry applies no cap.
 */
export function stableHandHostCaps(
  eligibleByHost: ReadonlyMap<string, number>,
  now: { hour: number; minute: number }
): Map<string, number> {
  const caps = new Map<string, number>();
  for (const [hostId, n] of eligibleByHost) {
    if (!Number.isFinite(n) || n <= 0) continue;
    caps.set(hostId, occupancyTargetForHost(n, now.hour, now.minute).max);
  }
  return caps;
}

/**
 * May this horse take a NEW seat on this host?
 *
 * Yes when the host has no cap, when the horse is already seated somewhere on
 * that host (it is already counted, so a second table costs nothing), when the
 * host is under its cap, or when a human at that table needs the game rescued.
 * A waiting person outranks the shape of the floor, every time.
 */
export function hostAllowsNewBody(opts: {
  hostId: string;
  horseId: string;
  caps: ReadonlyMap<string, number>;
  bodiesOnHost: ReadonlyMap<string, ReadonlySet<string>>;
  humanNeedsRescue: boolean;
}): boolean {
  if (opts.humanNeedsRescue) return true;
  const cap = opts.caps.get(opts.hostId);
  if (cap === undefined) return true;
  const live = opts.bodiesOnHost.get(opts.hostId);
  if (live?.has(opts.horseId)) return true;
  return (live?.size ?? 0) < cap;
}

/**
 * Bodies currently seated on each host, from the seat map the seeding cycle
 * already holds. Keyed by host so it can be updated in place as seats are
 * taken during the cycle - a cap read from the position the cycle STARTED
 * with would let one pass seat the whole floor.
 */
export function bodiesOnHostFrom(
  seats: ReadonlyArray<{ user_id: string; table_id: string }>,
  hostOfTable: ReadonlyMap<string, string>,
  isHorse: (id: string) => boolean
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of seats) {
    if (!isHorse(s.user_id)) continue;
    const host = hostOfTable.get(s.table_id);
    if (!host) continue;
    if (!out.has(host)) out.set(host, new Set());
    out.get(host)!.add(s.user_id);
  }
  return out;
}
