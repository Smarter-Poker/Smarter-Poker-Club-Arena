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
  close: string[];
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

/** Tables that count toward shape: running cash tables inside the phase clamp. */
function shapedTables(h: HostSnapshot): TableSnapshot[] {
  return h.tables.filter(
    (t) => (t.status === 'running' || t.status === 'active') && stakeIsLegalThisPhase(t.bb)
  );
}

export function planFloor(snap: FloorSnapshot): FloorPlan {
  const plan: FloorPlan = { seat: [], stand: [], open: [], close: [], alerts: [], metrics: [] };

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

    if (!snap.killed) {
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

    if (host.uniqueLive > peakCap(host.n)) plan.alerts.push(`over_peak_cap host=${host.hostId}`);
    if (isNightWindow(snap.chicagoHour) && host.uniqueLive > nightCap(host.n)) {
      plan.alerts.push(`over_night_cap host=${host.hostId}`);
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
