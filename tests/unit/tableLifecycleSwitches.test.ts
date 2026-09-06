import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * AUTO RESTART / AUTO EXTENSION / AUTO CREATE TABLE - three switches on the
 * table creation page with three tooltips and, until 2026-08-25, zero readers.
 *
 * `auto_restart` was worse than merely dead. CreateTableModal's checkbox landed
 * in the `settings` JSONB blob nothing reads, so it never reached the column at
 * all - the same class of bug as the straddle / bomb-pot / ante mirrors beside
 * it in TableService.
 *
 * Each switch now means what its tooltip promises, anchored to behaviour that
 * already existed rather than invented:
 *
 *   AUTO RESTART       GameServer's boot comment is the anchor - "CLOSED IS A
 *                      DECISION, NOT A STATE TO CLEAN UP ... the fleet still
 *                      reopens the tables it OWNS". A host's table, once
 *                      closed, stayed closed forever. This is the host saying
 *                      "reopen mine too".
 *   AUTO EXTENSION     extended the table's LIFE: an empty table carrying it
 *                      was skipped by retireSurplusTables instead of being
 *                      closed for going quiet. GONE with Gate 7 (2026-09-05):
 *                      the fleet closes nothing, the tick's BREAK rule does.
 *   AUTO CREATE TABLE  the overflow spawn the fleet's own tables already got,
 *                      extended to a host's table.
 *
 * The rules live in SQL (fn_table_lifecycle_pass) because spawnOverflowTables
 * only knows DEFAULT_TABLES, matched by name prefix - a host's table is not in
 * that list and never could be. Verified against production in rolled-back
 * transactions; see the migration header.
 */

const src = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the fleet closes no table; closing is the tick BREAK rule (Gate 7, 2026-09-05)', () => {
  /* Moved 2026-09-05 for Gate 7. This block used to pin retireSurplusTables'
     UPDATE: `.update({ status: 'closed' })` carrying an `.or(...)` in which
     auto_extension vetoed the close unless the row was retire_when_empty or
     night_parked. OPORD 1.4 s2.11 removes auto_extension, auto_restart and
     auto_create_table as switches ("removed, not kept for compatibility") and
     deletes retireSurplusTables outright: a cash table is closed ONLY by the
     cluster controller's BREAK rule in fn_cash_cluster_tick, which writes
     status = 'closed' and records table_break_completed. */
  const fleet = src('server/src/services/HorseFleetManager.ts');
  const tick = src(
    'supabase/migrations/20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined.sql'
  );

  it('the fleet never writes status closed onto a table and has no retirement sweep', () => {
    expect(fleet).not.toContain("status: 'closed'");
    expect(fleet).not.toMatch(/private async retireSurplusTables/);
    expect(fleet).not.toContain('await this.retireSurplusTables(');
    // and the switch that used to veto the close is not read by the fleet
    expect(fleet).not.toContain('auto_extension');
  });

  it("closing is the tick's table_break_completed path, in SQL", () => {
    const body = tick.slice(tick.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick'));
    const close = body.indexOf("UPDATE public.tables SET status = 'closed', lifecycle = 'closed'");
    const event = body.indexOf("'table_break_completed'");
    expect(close).toBeGreaterThan(0);
    expect(event).toBeGreaterThan(close);
  });
});

describe('the lifecycle pass is GONE, and the fleet owns no table lifecycle (2026-09-06)', () => {
  const fleet = src('server/src/services/HorseFleetManager.ts');

  /* This block used to pin `runTableLifecyclePass` as "called on every cycle".
     OPORD 1.4 s18.2 lists it for deletion beside spawnOverflowTables and
     retireSurplusTables; those two went at Gate 7 and this one was left
     running every 30 seconds for another day. Deleted now, for three reasons
     measured on 2026-09-06:

       - it had NOTHING to act on. Of 3,636 live cluster tables and 1,954
         non-cluster cash tables, zero carry `auto_restart` or
         `auto_create_table`; Gate 5's applier forces both false on every
         cluster table each tick. Every pass was an RPC returning an empty set.
       - its AUTO CREATE arm called `fn_clone_table_row`, which copied
         `cluster_id`, `role`, `main_index` and `lifecycle` - so cloning a full
         Main 1 produced a SECOND Main 1 of the same game, the shape that
         opened 3,000 tables on one game on 2026-09-05.
       - and the clone could not have worked anyway: `public.tables` has four
         GENERATED columns, so its `INSERT ... SELECT *` raised 428C9 on every
         call, which the arm's `EXCEPTION WHEN unique_violation` does not catch.

     The cloner is fixed in the same PR (migration 20260906160550) so no caller
     can repeat it. The block below is a TOMBSTONE: the comment stays in the
     source precisely so the pass is not restored a fourth time. */
  it('is not called, and the method is gone', () => {
    expect(fleet).not.toContain('await this.runTableLifecyclePass();');
    expect(fleet).not.toContain('private async runTableLifecyclePass');
  });

  it('the RPC is not referenced anywhere in the fleet', () => {
    expect(fleet).not.toContain("supabase.rpc('fn_table_lifecycle_pass')");
    expect(fleet).not.toContain('fn_table_lifecycle_pass');
  });

  it('and it says why, so nobody restores it', () => {
    expect(fleet).toContain('runTableLifecyclePass is GONE');
  });
});

describe('auto_restart reaches the column from the live creation path', () => {
  // 2026-08-27: this block used to pin the CreateTableModal path
  // (settings-blob mirror in TableService.createTable). That entire path was
  // unreachable dead code and was deleted in the create-flow audit.
  //
  // 2026-09-04 (Operation Table Stakes, Slice 1): the live cash writer is now
  // fn_cash_game_create in SQL, and the three switches are no longer a host's
  // choice at all - OPORD 1.4 section 18 makes the cluster lifecycle
  // autonomous. Ruling R3 (Main 1 is always on) is carried by the same two
  // mechanisms until the ClusterController lands: auto_extension = true
  // (retireSurplusTables skips it) and auto_restart = true
  // (fn_table_lifecycle_pass reopens it). auto_create_table stays false
  // because the lifecycle pass's clone would not carry cluster_id.
  const sql = src('supabase/migrations/20260904230000_cash_games_slice_1_hardening.sql');

  it('the cash create function writes the columns the lifecycle pass reads', () => {
    expect(sql).toMatch(/auto_extension, auto_restart, auto_create_table,/);
    // R9: a must-move game keeps Main 1 alive; a manual table does not.
    expect(sql).toMatch(/^\s*v_must_move, v_must_move, false,\s*$/m);
  });

  it('the dead modal path stayed deleted', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'src/components/club/CreateTableModal.tsx'))
    ).toBe(false);
  });
});

describe('the cash flow does not offer lifecycle switches, because the cluster owns its lifecycle', () => {
  // The three tooltips ("Reopen This Table If It Closes", "Keep This Table
  // Open When It Empties", "Create New Table When Full") described a host
  // running a table by hand. Under OPORD 1.4 nobody runs a table by hand:
  // Main 1 never closes and feeders open and close themselves. A switch for
  // any of it would be a switch that lies.
  const flow = src('src/components/cash/CashGameCreateFlow.tsx');

  it.each(['Auto Restart', 'Auto Extension', 'Auto Create Table'])(
    'offers no "%s" toggle',
    (label) => {
      expect(flow).not.toContain(`label="${label}"`);
    }
  );

  it('and the tournament tabs never had them', () => {
    const page = src('src/pages/TableConfigPage.tsx');
    expect(page).not.toContain('label="Auto Restart"');
    expect(page).not.toContain('Extend table automatically');
  });
});
