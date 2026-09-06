/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN OPENING FEEDER IS FILLED BEFORE IT IS ABANDONED (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `HorseFleetManager.seedAllTables` reads the whole open-table list ONCE at the
 * top of a cycle (`HorseFleet.openTables`), and the cycle then takes 57 to 118
 * seconds - its own line: "Seeding cycle took 118s and 3 30s tick(s) were
 * dropped while it ran". Everything the loop decides after that is decided
 * against a snapshot, and the controller is moving tables the whole time.
 *
 * Measured on production 2026-09-05 20:45 CDT. Two games opened a feeder about
 * every five minutes all night and nobody ever sat on one:
 *
 *   last hour: 22 feeder_opened, 4 feeder_live, 20 feeder_abandoned
 *   NLH 0.05/0.10 Classic  11 abandons in 90 minutes (18 seated on 18 seats)
 *   PLO4 0.50/1 Classic     8 abandons          (6 seated on 6 seats)
 *
 * The cycle line said the fleet had chosen its horses:
 *
 *   [HorseFleet] opening feeder "NLH 0.05/0.10 Classic Feeder": candidates 14,
 *     sittable 9, wanted 2, empty seats 2, selected 2, seated 0, ...
 *
 * `selected 2, seated 0` - and the door said why, fifteen times in twenty-five
 * minutes:
 *
 *   [HorseFleet.atomic_table_buyin_failed_for_horse] TABLE_CLOSING: this table
 *   is closed and takes no new players (code 23514)
 *
 * `fn_refuse_seat_on_closed_cluster_table` raises that when the table's
 * lifecycle is 'breaking' or 'closed'. The feeder the fleet was seating into
 * had already been abandoned by `fn_cash_cluster_tick` (an opening feeder with
 * nobody on it is closed after its window) while the cycle was still walking
 * the snapshot it read minutes earlier.
 *
 * Every one of those refusals costs a horse: it is selected for a table that
 * cannot take it, the buy-in bounces, and the cycle moves on without offering
 * it to a table that IS open. This file is the DECISION half - pure, so it can
 * be tested without a database. The wiring (one batched re-read per cycle,
 * issued as late as possible, immediately before the first seat of the cycle)
 * is in HorseFleetManager.
 */

/**
 * The lifecycles a cluster table will accept a new player in. `breaking` and
 * `closed` are the two `fn_refuse_seat_on_closed_cluster_table` raises
 * TABLE_CLOSING for; anything else unknown is refused here as well, because
 * the door is the authority and we would only be guessing.
 */
export const SEATABLE_LIFECYCLES: ReadonlySet<string> = new Set(['live', 'opening']);

/**
 * The statuses a table takes a buy-in in. A table the controller has put to
 * `closed` (or an operator's close-game action, which writes status only) is
 * not seatable however its lifecycle reads.
 */
export const SEATABLE_STATUSES: ReadonlySet<string> = new Set(['waiting', 'running', 'active']);

/** What the re-read says about one table's door, right now. */
export interface TableDoorState {
  lifecycle?: string | null;
  status?: string | null;
}

/**
 * The re-read's answer for the whole cycle.
 *
 * `known: false` is the FAIL-OPEN state - the read errored or came back
 * incomplete - and it is the doctrine every other loader in HorseFleetManager
 * follows (the disabled-games loader says it plainest: failing closed here
 * would empty the floor on one bad read, which is a worse outage than one more
 * cycle of seating into a table that just went away). A cycle with no opinion
 * seats exactly as it did before this file existed.
 */
export interface DoorSnapshot {
  known: boolean;
  byTableId: Map<string, TableDoorState>;
}

/** A cycle that could not read the doors: everything is seatable, as before. */
export function unknownDoors(): DoorSnapshot {
  return { known: false, byTableId: new Map() };
}

/**
 * Is this cluster table still worth committing a horse to?
 *
 * Three answers, in order:
 *
 *  - the snapshot is not known (`known: false`): TRUE. Fail open.
 *  - the table is absent from a COMPLETE read: FALSE. It was asked for by id
 *    and did not come back, so the row is gone. That is not the fail-open case
 *    - the read answered, and its answer was "no such table".
 *  - otherwise the lifecycle AND the status both have to be seatable.
 */
export function isStillSeatable(doors: DoorSnapshot, tableId: string): boolean {
  if (!doors.known) return true;
  const row = doors.byTableId.get(tableId);
  if (!row) return false;
  const lifecycle = String(row.lifecycle ?? '');
  const status = String(row.status ?? '');
  return SEATABLE_LIFECYCLES.has(lifecycle) && SEATABLE_STATUSES.has(status);
}

/** Build the snapshot from a COMPLETE read of `id, lifecycle, status`. */
export function doorsFromRows(
  rows: Array<{ id: string; lifecycle?: string | null; status?: string | null }>
): DoorSnapshot {
  const byTableId = new Map<string, TableDoorState>();
  for (const r of rows) {
    if (!r?.id) continue;
    byTableId.set(r.id, { lifecycle: r.lifecycle, status: r.status });
  }
  return { known: true, byTableId };
}

/** The cycle line, so the wording lives beside the decision it reports. */
export function staleSnapshotLine(n: number): string {
  return `[HorseFleet] ${n} table(s) went away between the read and the seat ` + `(stale snapshot)`;
}
