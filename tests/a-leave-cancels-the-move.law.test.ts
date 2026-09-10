/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LEAVE CANCELS THE MOVE (2026-09-09, must-move audit lane B)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05: "IF THEY LEAVE A TABLE AND JOIN THE SAME GAME AND STAKES
 * AGAIN, THEY GO TO THE BOTTOM OF THE LIST, BUT RATHOLE PROTECTION IS IN
 * PLACE." And: every player at a feeder game gets ONE seat change, never to
 * the main game.
 *
 * `fn_cash_game_roster_track` closed a player's roster row when their chair
 * emptied - unless they had a pending move, on the theory that a planned move
 * meant they were still in the game. It does not: the executor and the swap
 * both declare themselves through `app.cash_seat_move`, so an UNDECLARED empty
 * chair is a leave every time. Three things followed, all measured on
 * production 2026-09-09:
 *
 *   1. the destination chair stayed reserved for a player who had gone, for up
 *      to `fn_cash_seat_move_window` (3-15 minutes) - 137 moves cancelled
 *      `player_not_seated` in 24 hours, each one a chair the must-move list
 *      could not have;
 *   2. a rejoin inside that window kept the OLD roster row, so the old list
 *      position and the old spent seat change - 63 rejoins in three days, 2 of
 *      them spanned by the old row;
 *   3. a swap partner was held out of the deal waiting for a side that would
 *      never arrive.
 *
 * Two smaller truths in the same migration, each its own pin below: a seat
 * change listed from a feeder that the ROLES step then renumbered to Main 1
 * was executed off the main game (Dan: NEVER to the main game), and a request
 * whose move died while a must-move had already taken the player elsewhere was
 * stranded `moved` for ever with the allowance spent.
 *
 * WHAT THIS LAW DOES NOT COVER: the executor expiry notes. Lane A found the
 * same paths and fixed them in
 * `20260909181642_every_expiry_says_why_including_the_executors.sql`; this
 * lane deleted its half rather than have two migrations rewrite one statement.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIG = read(
  'supabase/migrations/20260909181259_a_leave_cancels_the_move_and_a_move_says_why_it_expired.sql'
);

describe('a leave cancels the move', () => {
  it('the roster trigger cancels the pending move of a player who left', () => {
    expect(MIG).toMatch(/SET state = 'cancelled', note = 'player_left_game'/);
    expect(MIG).toMatch(/m\.player_id = NEW\.user_id AND m\.game_id = v_game AND m\.state = 'pending'/);
  });

  it('the clause that kept a departed player on the roster is gone', () => {
    // The whole defect was this test standing between the leave and the close.
    const body = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_roster_track'));
    const guard = body.slice(0, body.indexOf('$migration$;'));
    expect(guard).not.toMatch(
      /AND NOT EXISTS \(SELECT 1 FROM public\.cash_seat_moves m\s*\n\s*WHERE m\.player_id = NEW\.user_id AND m\.game_id = v_game AND m\.state = 'pending'\) THEN/
    );
  });

  it('a swap partner is released when the other side leaves', () => {
    expect(MIG).toMatch(/note = 'swap_partner_gone'\s*\n\s*WHERE p\.swap_move_id = v_move AND p\.state = 'pending'/);
  });

  it('the declared executor is still let through, so a move is not a leave', () => {
    expect(MIG).toMatch(/current_setting\('app\.cash_seat_move', true\) IS DISTINCT FROM 'on'/);
  });

  it('a second live chair in the game is still not a leave', () => {
    expect(MIG).toMatch(/ts\.id <> NEW\.id[\s\S]{0,200}t\.cluster_id = v_game AND t\.lifecycle <> 'closed'/);
  });

  it('the post-apply assertion refuses a body that still waits on a pending move', () => {
    expect(MIG).toMatch(/the roster trigger still waits on a pending move/);
  });
});

describe('the main game has no seat change, however a table got its number', () => {
  it('a request from a table that became Main 1 is cancelled', () => {
    expect(MIG).toMatch(/note = 'now_on_main_one'/);
    expect(MIG).toMatch(/c\.id = r\.from_table_id AND c\.role = 'main' AND c\.main_index = 1/);
  });

  it('and the allowance comes back, like every other change the system made', () => {
    const block = MIG.slice(MIG.indexOf("note = 'now_on_main_one'"));
    expect(block.slice(0, 600)).toMatch(/SET seat_change_used_at = NULL/);
    expect(block.slice(0, 900)).toMatch(/'seat_change_returned'[\s\S]{0,200}'now_on_main_one'/);
  });

  it('the 2026-09-07 left_table return survives the replacement', () => {
    expect(MIG).toMatch(/note = 'left_table'/);
    expect(MIG).toMatch(/the 2026-09-07 left_table return was lost/);
  });
});

describe('a re-listed seat change follows the player', () => {
  it('the tick asks whether they are in the GAME, not in the table they asked from', () => {
    expect(MIG).toMatch(/THE REQUEST COMES BACK WHEREVER THEY ARE SITTING/);
    expect(MIG).toMatch(/tb\.cluster_id = g\.id AND tb\.lifecycle <> 'closed'/);
    // The old predicate - "still in the table you asked from" - is what
    // stranded the request. It must not survive in this statement.
    const stmt = MIG.slice(MIG.indexOf('THE REQUEST COMES BACK WHEREVER THEY ARE SITTING'));
    expect(stmt.slice(0, 2400)).not.toMatch(/ts\.table_id = rq\.from_table_id/);
  });

  it('rewrites from_table_id by a correlated subquery, never a LATERAL on the target', () => {
    // Postgres refuses a lateral reference to the UPDATE target from the FROM
    // list (42P10). The first draft did exactly that and the rolled-back probe
    // caught it; had it been applied, the cluster tick would have raised on
    // every pass for every game.
    expect(MIG).toMatch(/from_table_id = \(SELECT ts\.table_id FROM public\.table_seats ts/);
    expect(MIG).not.toMatch(/LATERAL \(SELECT ts\.table_id/);
  });

  it('never sets the NOT NULL from_table_id to NULL', () => {
    // A player with no chair at all in the game is the roster trigger's case.
    const stmt = MIG.slice(MIG.indexOf('THE REQUEST COMES BACK WHEREVER THEY ARE SITTING'));
    expect(stmt.slice(0, 2400)).toMatch(/AND EXISTS \(SELECT 1 FROM public\.table_seats ts/);
  });

  it('a re-listed request keeps the allowance spent - it is still in use', () => {
    // Returning it here would hand out a second seat change.
    expect(MIG).not.toMatch(/note = 'move_' \|\| mv\.state[\s\S]{0,400}seat_change_used_at = NULL/);
  });
});

describe('the grants say what RLS enforces', () => {
  it('a browser role may not write a seat move or a waitlist row', () => {
    expect(MIG).toMatch(/REVOKE INSERT, UPDATE, DELETE[\s\S]{0,80}public\.cash_seat_moves FROM authenticated, anon/);
    expect(MIG).toMatch(/REVOKE INSERT, UPDATE, DELETE[\s\S]{0,80}public\.cash_game_waitlist FROM authenticated, anon/);
  });

  it('but keeps the read-own SELECT it has a policy for', () => {
    expect(MIG).toMatch(/the read-own grant was revoked with the writes/);
  });
});

describe('the migration is safe to apply beside the other lanes', () => {
  it('is one transaction', () => {
    expect(MIG.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIG.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('guards each whole-body replacement on the reviewed md5 and skips itself if applied', () => {
    expect(MIG).toMatch(/a441e273d59ee341da01956c6123280d/);
    expect(MIG).toMatch(/424e5c6ade9b6c8adf3f97a211b9b838/);
    expect(MIG).toMatch(/roster track already applied/);
    expect(MIG).toMatch(/seat change planner already applied/);
  });

  it('patches the cluster tick by an anchor, not by re-emitting it', () => {
    // Lane A patches two other statements of the same 35 KB function. Anchored
    // literal replacement is what lets all of them apply in any order.
    expect(MIG).toMatch(/pg_get_functiondef\('public\.fn_cash_cluster_tick'::regproc\)/);
    expect(MIG).toMatch(/the seat-change re-list statement is not in the live definition/);
    expect(MIG).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_cluster_tick/);
  });

  it('does not touch the two executor expiry paths lane A owns', () => {
    expect(MIG).not.toMatch(/boundary_reached_after_expiry/);
    expect(MIG).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_cash_seat_(move|swap)_execute/);
  });

  it('asserts every change afterwards', () => {
    expect(MIG).toMatch(/\$assert\$/);
    expect(MIG).toMatch(/the roster trigger does not cancel the move of a player who left/);
    expect(MIG).toMatch(/the planner does not return the button to a player renumbered onto Main 1/);
    expect(MIG).toMatch(/the tick still re-lists only from the requested table/);
    expect(MIG).toMatch(/a browser role can still write a seat move or a waitlist row/);
  });

  it('no em dashes anywhere (CLAUDE.md 10.7)', () => {
    // \u2014 by escape, never the literal: this file is code too.
    expect(MIG).not.toMatch(/\u2014/);
  });
});
