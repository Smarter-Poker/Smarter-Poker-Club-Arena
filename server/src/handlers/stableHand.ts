/**
 * OPERATION STABLE HAND - Section 15 dashboard.
 *
 * GET /stable-hand  ->  the floor as the planner sees it, plus its alerts.
 *
 * Read-only. It builds the same snapshot the EXECUTOR consumes - literally the
 * same function, buildFloorSnapshot - and returns the plan's metrics WITHOUT
 * executing any of it, so the dashboard can never seat, stand or close
 * anything by being looked at. Two different queries here would mean a
 * dashboard reporting a floor nobody is managing.
 */

import type { ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { planFloor, chicagoNow } from '../services/StableHandController.js';
import { buildFloorSnapshot } from '../services/StableHandSnapshot.js';
import {
  WALLETS_FOR_HOST,
  killed,
  controllerEnabled,
  peakCap,
  nightCap,
} from '../services/StableHand.js';
import {
  readRecentBeats,
  lastBeatAt,
  beatVerdict,
  BEAT_STALE_MS,
} from '../services/StableHandBeats.js';

export async function handleStableHand(res: ServerResponse): Promise<void> {
  try {
    const snapshot = await buildFloorSnapshot();
    /* THE HISTORY, and whether the controller is still writing one. A snapshot
       says what the floor is; only a series says whether the curve is being
       HELD, and only the absence of one says the controller has stopped. */
    const [beats, beatAt] = await Promise.all([readRecentBeats(240), lastBeatAt()]);
    const nowMs = Date.now();

    // PLANNED, NOT EXECUTED. Nothing below this line acts on the plan.
    const plan = planFloor(snapshot);
    const yields = plan.stand.filter((s) => s.reason === 'human_yield');

    sendJSON(res, 200, {
      operation: 'stable_hand',
      controllerEnabled: controllerEnabled(),
      killed: killed(),
      chicago: chicagoNow(),
      hosts: plan.metrics.map((m) => ({
        ...m,
        caps: { peak: peakCap(m.n), night: nightCap(m.n) },
        wallets: WALLETS_FOR_HOST[m.hostId] ?? [],
      })),
      wouldSeat: plan.seat.length,
      wouldStand: plan.stand.length,
      wouldOpen: plan.open,
      wouldClose: plan.close.length,
      wouldParkForTheNight: plan.park.length,
      yieldsPending: yields.length,
      /* What is actually EXECUTED, listed so the dashboard says which orders
         are live and which are still reports. `close` and `park` are executed
         by MARKING the table - the fleet's own drain empties it and its own
         retirement pass closes it, only once nobody is sitting there. Seat and
         open are still reports. See StableHandExecutor. */
      executing: ['human_yield', 'occupancy_wind_down', 'close', 'park'],
      alerts: plan.alerts,

      /* ── IS THE CONTROLLER RUNNING, AND IS THE CURVE BEING HELD ────────
         `heartbeat` answers the first question and `history` the second.
         Both were unanswerable from a snapshot endpoint, and the first is the
         one that matters most: a controller that stops does not fill a log
         with errors, it stops filling one. */
      heartbeat: {
        lastBeatAt: beatAt === null ? null : new Date(beatAt).toISOString(),
        secondsSince: beatAt === null ? null : Math.round((nowMs - beatAt) / 1000),
        staleAfterSeconds: BEAT_STALE_MS / 1000,
        verdict: beatVerdict({
          lastBeatAtMs: beatAt,
          nowMs,
          enabled: controllerEnabled(),
        }),
      },
      history: beats.map((b: any) => ({
        at: b.beat_at,
        host: b.host_id,
        hour: b.chicago_hour,
        live: b.unique_live,
        seats: b.live_seats,
        target: b.target,
        max: b.cap_max,
        tables: b.tables_open,
        shape: [b.full_tables, b.one_open_tables, b.joinable_tables],
        waiting: b.humans_waiting,
        yields: [b.yields_executed, b.yields_planned],
        windDowns: [b.winddowns_executed, b.winddowns_planned],
        pending: { close: b.close_pending, park: b.park_pending },
      })),
    });
  } catch (err) {
    sendJSON(res, 500, { error: 'stable_hand_dashboard_failed', detail: String(err) });
  }
}
