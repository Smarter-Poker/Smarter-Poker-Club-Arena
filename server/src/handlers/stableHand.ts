/**
 * OPERATION STABLE HAND - Section 15 dashboard.
 *
 * GET /stable-hand  ->  the floor as the planner sees it, plus its alerts.
 *
 * Read-only. It builds the same snapshot the planner consumes and returns the
 * plan's metrics WITHOUT executing any of it, so the dashboard can never seat,
 * stand or close anything by being looked at.
 */

import type { ServerResponse } from 'http';
import { sendJSON } from '../http/respond.js';
import { supabase } from '../services/supabase.js';
import {
  planFloor,
  chicagoNow,
  type FloorSnapshot,
  type HostSnapshot,
} from '../services/StableHandController.js';
import {
  MIDWAY_UNION_ID,
  DSS_CLUB_ID,
  WALLETS_FOR_HOST,
  killed,
  controllerEnabled,
  peakCap,
  nightCap,
} from '../services/StableHand.js';

/** Eligible BODIES per host. Measured 2026-09-04: Union 584 (JAQK is a strict
 *  subset of Shark, so the union of the two wallets is 584 bodies, not 1,164),
 *  DSS 416, and 584 + 416 = 1,000 exactly. Read live so it self-corrects. */
async function eligibleBodies(hostId: string): Promise<number> {
  const wallets = WALLETS_FOR_HOST[hostId] ?? [];
  if (wallets.length === 0) return 0;
  const { data, error } = await supabase
    .from('club_members')
    .select('user_id, profiles!inner(is_horse)')
    .in('club_id', wallets)
    .in('status', ['active', 'approved']);
  if (error || !data) return 0;
  return new Set(data.filter((r: any) => r.profiles?.is_horse).map((r: any) => r.user_id)).size;
}

export async function handleStableHand(res: ServerResponse): Promise<void> {
  try {
    const now = chicagoNow();
    const hosts: HostSnapshot[] = [];

    for (const hostId of [MIDWAY_UNION_ID, DSS_CLUB_ID]) {
      const { data: tables } = await supabase
        .from('tables')
        .select('id, game_variant, small_blind, big_blind, max_players, status, current_players')
        .eq('club_id', hostId)
        .is('tournament_id', null)
        .in('status', ['waiting', 'running', 'active']);

      const tableIds = (tables ?? []).map((t: any) => t.id);
      const { data: seats } = tableIds.length
        ? await supabase
            .from('table_seats')
            .select('table_id, user_id, stack, profiles!inner(is_horse)')
            .in('table_id', tableIds)
            .is('left_at', null)
        : { data: [] as any[] };

      const { data: waits } = tableIds.length
        ? await supabase
            .from('table_waitlist')
            .select('table_id, user_id, profiles!inner(is_horse)')
            .in('table_id', tableIds)
            .eq('status', 'waiting')
        : { data: [] as any[] };

      const seatsByTable = new Map<string, any[]>();
      (seats ?? []).forEach((s: any) => {
        if (!seatsByTable.has(s.table_id)) seatsByTable.set(s.table_id, []);
        seatsByTable.get(s.table_id)!.push(s);
      });

      const waitingByTable = new Map<string, number>();
      (waits ?? []).forEach((w: any) => {
        // Only HUMANS on a list trigger a yield. Horses do not queue.
        if (w.profiles?.is_horse) return;
        waitingByTable.set(w.table_id, (waitingByTable.get(w.table_id) ?? 0) + 1);
      });

      const uniqueLive = new Set(
        (seats ?? []).filter((s: any) => s.profiles?.is_horse).map((s: any) => s.user_id)
      ).size;

      hosts.push({
        hostId,
        n: await eligibleBodies(hostId),
        uniqueLive,
        tables: (tables ?? []).map((t: any) => {
          const rows = seatsByTable.get(t.id) ?? [];
          const horses = rows.filter((r: any) => r.profiles?.is_horse);
          return {
            tableId: t.id,
            hostId,
            variant: String(t.game_variant ?? ''),
            sb: Number(t.small_blind ?? 0),
            bb: Number(t.big_blind ?? 0),
            maxPlayers: Number(t.max_players ?? 6),
            occupied: rows.length,
            humansSeated: rows.length - horses.length,
            humansWaiting: waitingByTable.get(t.id) ?? 0,
            seatedHorses: horses.map((h: any) => ({
              horseId: h.user_id,
              sittingOut: false,
              minutesAtTable: 0,
              isRed: false,
              stack: Number(h.stack ?? 0),
            })),
            status: String(t.status ?? ''),
          };
        }),
      });
    }

    const snapshot: FloorSnapshot = {
      chicagoHour: now.hour,
      chicagoMinute: now.minute,
      hosts,
      killed: killed(),
    };

    // PLANNED, NOT EXECUTED. Nothing below this line acts on the plan.
    const plan = planFloor(snapshot);

    sendJSON(res, 200, {
      operation: 'stable_hand',
      controllerEnabled: controllerEnabled(),
      killed: killed(),
      chicago: now,
      hosts: plan.metrics.map((m) => ({
        ...m,
        caps: { peak: peakCap(m.n), night: nightCap(m.n) },
        wallets: WALLETS_FOR_HOST[m.hostId] ?? [],
      })),
      wouldSeat: plan.seat.length,
      wouldStand: plan.stand.length,
      wouldOpen: plan.open,
      wouldClose: plan.close.length,
      yieldsPending: plan.stand.filter((s) => s.reason === 'human_yield').length,
      alerts: plan.alerts,
    });
  } catch (err) {
    sendJSON(res, 500, { error: 'stable_hand_dashboard_failed', detail: String(err) });
  }
}
