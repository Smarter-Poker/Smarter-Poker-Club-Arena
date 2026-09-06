/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN OPENING FEEDER IS FILLED BEFORE IT IS ABANDONED (2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two halves of one defect, pinned together because either alone leaves the
 * loop running:
 *
 *   THE FLEET half - `seedAllTables` reads the open-table list once at the top
 *     of a cycle that then takes 57 to 118 seconds, and by the time it seats,
 *     the controller may have closed the feeder underneath it. The door then
 *     raises TABLE_CLOSING and the horse is spent for nothing. It now re-reads
 *     the door once per cycle, immediately before the first seat, and skips a
 *     table that went away.
 *   THE WINDOW half - the controller abandoned an opening feeder nobody came
 *     to after 3 minutes, which is shorter than one worst-case fleet cycle
 *     plus a tick interval, so the feeder could be closed before the fleet's
 *     next cycle ever reached it. The window is 6 minutes.
 *
 * The decision is pure and tested directly; the wiring and the SQL are pinned
 * against the shipped source, the discipline HorseLoneTable.test.ts and
 * HorseFleetPolicyWiring.test.ts use on this same method - seedAllTables needs
 * a live Supabase to run, so a test that faked it would be pinning the fake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SEATABLE_LIFECYCLES,
  SEATABLE_STATUSES,
  doorsFromRows,
  isStillSeatable,
  staleSnapshotLine,
  unknownDoors,
} from './HorseStaleTable.js';

const ROOT = resolve(__dirname, '../..');
const FLEET = readFileSync(resolve(ROOT, 'src/services/HorseFleetManager.ts'), 'utf8');
const MIGRATION = readFileSync(
  resolve(
    ROOT,
    '../supabase/migrations/20260906015029_an_opening_feeder_is_filled_before_it_is_abandoned.sql'
  ),
  'utf8'
);

describe('the decision: a table that went away is skipped', () => {
  it('seats into a live or opening table', () => {
    const doors = doorsFromRows([
      { id: 'live', lifecycle: 'live', status: 'running' },
      { id: 'opening', lifecycle: 'opening', status: 'waiting' },
      { id: 'active', lifecycle: 'live', status: 'active' },
    ]);
    expect(isStillSeatable(doors, 'live')).toBe(true);
    expect(isStillSeatable(doors, 'opening')).toBe(true);
    expect(isStillSeatable(doors, 'active')).toBe(true);
  });

  it('skips the table the controller closed or broke under the cycle', () => {
    // The two lifecycles fn_refuse_seat_on_closed_cluster_table raises
    // TABLE_CLOSING for - the refusal seen 15 times in 25 minutes.
    const doors = doorsFromRows([
      { id: 'closed', lifecycle: 'closed', status: 'closed' },
      { id: 'breaking', lifecycle: 'breaking', status: 'running' },
    ]);
    expect(isStillSeatable(doors, 'closed')).toBe(false);
    expect(isStillSeatable(doors, 'breaking')).toBe(false);
  });

  it('skips a table whose STATUS closed even while the lifecycle still reads live', () => {
    // An operator's close-game action and the pre-controller close path write
    // status only; the door refuses the buy-in all the same.
    const doors = doorsFromRows([{ id: 't', lifecycle: 'live', status: 'closed' }]);
    expect(isStillSeatable(doors, 't')).toBe(false);
  });

  it('skips a table that a COMPLETE read did not return at all - the row is gone', () => {
    const doors = doorsFromRows([{ id: 'other', lifecycle: 'live', status: 'running' }]);
    expect(isStillSeatable(doors, 'vanished')).toBe(false);
  });

  it('FAILS OPEN: an errored or short read seats exactly as before', () => {
    // The doctrine of every other loader in HorseFleetManager. A bad read must
    // not stop the floor filling - that would be a worse outage than one more
    // cycle of seating into a table that just went away.
    const doors = unknownDoors();
    expect(doors.known).toBe(false);
    expect(isStillSeatable(doors, 'anything')).toBe(true);
    expect(isStillSeatable(doors, 'closed')).toBe(true);
  });

  it('names the sets it judges by, so a new lifecycle is a deliberate decision', () => {
    expect([...SEATABLE_LIFECYCLES].sort()).toEqual(['live', 'opening']);
    expect([...SEATABLE_STATUSES].sort()).toEqual(['active', 'running', 'waiting']);
  });

  it('says the same sentence the cycle line says', () => {
    expect(staleSnapshotLine(3)).toBe(
      '[HorseFleet] 3 table(s) went away between the read and the seat (stale snapshot)'
    );
  });
});

describe('the wiring: one batched read, as late as the cycle allows', () => {
  it('re-reads the door and skips the table BEFORE any horse is committed', () => {
    const guard = FLEET.slice(
      FLEET.indexOf('THE DOOR, RE-READ'),
      FLEET.indexOf('// Seat each horse at an ACTUAL empty seat')
    );
    expect(guard).toMatch(/await readDoorsOnce\(\)/);
    expect(guard).toMatch(/if \(!isStillSeatable\(doors, table\.id\)\)/);
    expect(guard).toMatch(/staleTablesSkipped\+\+/);
    expect(guard).toMatch(/continue;/);
  });

  it('the skip precedes the first seatHorse, so the horses stay available', () => {
    // `continue` before the seating loop means nothing below ran: no exposure,
    // no horseTables entry, no seat budget spent - the next table in this same
    // cycle can take those horses. If the guard ever moved BELOW the first
    // seatHorse it would be re-shipping the wasted buy-in it exists to stop.
    expect(FLEET.indexOf('THE DOOR, RE-READ')).toBeGreaterThan(0);
    expect(FLEET.indexOf('THE DOOR, RE-READ')).toBeLessThan(
      FLEET.indexOf('const success = await this.seatHorse(')
    );
  });

  it('asks ONCE per cycle, not once per table and not once per horse', () => {
    // `doorsAsked` latches on the first call, and the reader is invoked from
    // exactly one place.
    expect(FLEET).toMatch(/const first = !doorsAsked;\s*\n\s*doorsAsked = true;/);
    // and it carries no bare `return;` - HorseFleetPolicyWiring asserts this
    // method has no early return by reading the source for the word, so a
    // closure that returns early reads exactly like a cycle that bailed out.
    const reader = FLEET.slice(
      FLEET.indexOf('const readDoorsOnce'),
      FLEET.indexOf('for (const table of tablesToSeed)')
    );
    expect(reader).not.toMatch(/\breturn;/);
    expect(FLEET.match(/await readDoorsOnce\(\)/g)).toHaveLength(1);
  });

  it('reads id, lifecycle and status for the cluster tables the cycle will seat', () => {
    const reader = FLEET.slice(
      FLEET.indexOf('const readDoorsOnce'),
      FLEET.indexOf('for (const table of tablesToSeed)')
    );
    expect(reader).toMatch(/\.select\('id, lifecycle, status'\)/);
    expect(reader).toMatch(/\.in\('id', clusterIdsToSeed\)/);
    expect(reader).toMatch(/HorseFleet\.doorRecheck/);
    // Paged, like every other read in this method: a short read is a lie.
    expect(reader).toMatch(/fetchAllRows</);
  });

  it('fails open on a short read or an error, and says so on the beat', () => {
    const reader = FLEET.slice(
      FLEET.indexOf('const readDoorsOnce'),
      FLEET.indexOf('for (const table of tablesToSeed)')
    );
    expect(reader).toMatch(/if \(doorPage\.complete\)/);
    expect(reader).toMatch(/beat\.staleDoorReadFailed = 1/);
    expect(reader).toMatch(/fail open/);
    expect(reader).toMatch(/reportError\(err, 'HorseFleet\.door_recheck_failed'\)/);
    // Nothing in the reader throws or returns out of the cycle.
    expect(reader).not.toMatch(/beat\.reason = /);
  });

  it('reports the skips once per cycle, on the log line and on the beat', () => {
    expect(FLEET).toMatch(/beat\.staleTablesSkipped = staleTablesSkipped;/);
    expect(FLEET).toMatch(/console\.log\(staleSnapshotLine\(staleTablesSkipped\)\)/);
    expect(FLEET).toMatch(/stale_tables_skipped: beat\.staleTablesSkipped/);
    expect(FLEET).toMatch(/stale_door_read_failed: beat\.staleDoorReadFailed/);
  });
});

describe('the window: six minutes, because a fleet cycle is 118 seconds', () => {
  it('abandons an opening feeder nobody came to after SIX minutes', () => {
    const block = MIGRATION.slice(
      MIGRATION.indexOf('AN OPENING FEEDER NOBODY CAME TO (2026-09-05, window raised'),
      MIGRATION.indexOf("'feeder_abandoned');")
    );
    expect(block).toMatch(
      /coalesce\(tb\.opened_at, tb\.created_at\) < v_now - interval '6 minutes'/
    );
    expect(block).not.toMatch(/interval '3 minutes'/);
  });

  it('leaves the two-minute rest and the sixty-second opening hold alone', () => {
    expect(MIGRATION).toMatch(
      /e\.kind = 'feeder_abandoned' AND e\.at > v_now - interval '2 minutes'/
    );
    expect(MIGRATION).toMatch(/interval '60 seconds'/);
  });

  it('leaves the waitlist notify expiry on its own separate three minutes', () => {
    // There were two `3 minutes` in the function and only one of them was the
    // feeder window. The other is a notified waitlist seat going stale.
    const fn = MIGRATION.slice(MIGRATION.indexOf('AS $fn$'));
    expect(fn.match(/interval '3 minutes'/g)).toHaveLength(1);
    expect(fn).toMatch(/w\.status = 'notified' AND w\.updated_at < v_now - interval '3 minutes'/);
  });

  it('re-declares the function whole, guarded by the live md5 on both sides', () => {
    expect(MIGRATION).toMatch(/BEGIN;/);
    expect(MIGRATION).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(MIGRATION).toMatch(/5433f92b25cb592c5d9de007b4a94110/); // live before
    expect(MIGRATION).toMatch(/992399462c97fcde1a30494691ecdb99/); // and after
    expect(MIGRATION.match(/DO \$guard\$/g)).toHaveLength(2);
    expect(MIGRATION.match(/\bCOMMIT;/g)).toHaveLength(1);
  });

  it('keeps the controller off the browser surface on every re-declaration', () => {
    // fn_cash_cluster_tick is SECURITY DEFINER, it writes, and it takes the
    // game to act on as a parameter. check-definer-authorization blocks the
    // push without this pair, and naming PUBLIC as well as the roles is the
    // difference between a fix and a line that reads like one.
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cash_cluster_tick\(uuid, integer\) FROM PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_cash_cluster_tick\(uuid, integer\) TO service_role;/
    );
  });

  it('says WHY six, in the numbers it was derived from', () => {
    // A constant with no measurement behind it is the next agent's mystery.
    expect(MIGRATION).toMatch(/118/);
    expect(MIGRATION).toMatch(/30-second tick|30 30s|30s tick/);
    expect(MIGRATION).toMatch(/feeder_abandoned/);
  });
});
