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

export async function handleStableHand(res: ServerResponse): Promise<void> {
  try {
    const snapshot = await buildFloorSnapshot();

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
    });
  } catch (err) {
    sendJSON(res, 500, { error: 'stable_hand_dashboard_failed', detail: String(err) });
  }
}
