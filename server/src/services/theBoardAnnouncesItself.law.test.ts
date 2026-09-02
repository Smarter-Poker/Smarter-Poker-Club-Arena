import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A SEAT-FIRST BOARD ANNOUNCES ITSELF. NOBODY GOES LOOKING FOR IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-02, verbatim: "IM TALKING ABOUT THE AMOUNT OF TIME IT TAKES
 * FROM WHEN THE LAST PLAYER 'BUYS IN' TO THE TIME IT TAKES THE SPIN ANIMATION
 * TO START PLAYING ... ADD A REAL TIME CONNECTION IF THAT WILL SPEED IT UP TO
 * 1 SECOND", and then, when told it could not be done: "THATS A LIE, POKER
 * BROS STARTS ONE SECOND AFTER THE LAST BUY IN IS CONFIRMED ... THERE IS A
 * WAY, YOU JUST HAVENT FIGURED IT OUT YET".
 *
 * He was right and the first answer was wrong. What was measured, on
 * production, through the same PostgREST path the engine uses, for ONE pass of
 * discoverSeatFirstStarts:
 *
 *     REGISTERING seat-first tournaments .............  0.475 s
 *     their live tables, .in(tournament_id, 85 uuids)   4.029 s
 *     their live seats ...............................  0.944 s
 *                                                      -------
 *                                            per pass   5.448 s
 *
 * so a loop advertised in its own comment as "ONE SECOND, not five" was really
 * running a six-and-a-half second cycle, and a board that filled just after a
 * pass waited the whole of the next one. Four Spins seen filling seconds apart
 * drew eight seconds apart, in a queue.
 *
 * Collapsing the three round trips into one RPC (fn_seat_first_boards_ready)
 * made the QUERY 76 ms - and the same RPC then measured 1.9 s, 10.0 s and
 * 4.1 s through PostgREST on three consecutive calls. That is the measurement
 * that settles the design: the query is no longer the cost, the ROUND TRIP is,
 * and NO POLL OVER THAT TRANSPORT CAN EVER HONOUR A ONE-SECOND PROMISE. The
 * only way to be told in one second is to be TOLD.
 *
 * So the seat that fills the board broadcasts `seat_first_ready` in the same
 * transaction that commits it, and the engine listens. Every pin below is one
 * of the ways that can silently rot back into a poll.
 */

const here = new URL('.', import.meta.url).pathname;
const repo = join(here, '..', '..', '..');
const migrations = join(repo, 'supabase', 'migrations');
const gameServer = readFileSync(join(repo, 'server', 'src', 'GameServer.ts'), 'utf8');

function broadcastMigration(): string {
  const f = readdirSync(migrations).find((n) =>
    n.includes('the_board_announces_itself_the_moment_the_last_seat_is_paid')
  );
  if (!f) throw new Error('the broadcast migration is gone from supabase/migrations');
  return readFileSync(join(migrations, f), 'utf8');
}

describe('LAW: the board announces itself the moment the last seat is paid', () => {
  it('the seat that fills the board broadcasts seat_first_ready', () => {
    const sql = broadcastMigration();
    // The event name is a contract between the migration and the engine. If
    // either side renames it alone, the push silently stops and the only
    // symptom is that Spins go back to starting six seconds late - which is
    // exactly the failure this law exists to make loud.
    expect(sql).toContain('seat_first_ready');
    expect(sql).toContain('realtime.send');
    expect(gameServer).toContain("event: 'seat_first_ready'");
  });

  it('the broadcast rides the hook that commits the seat, not a separate pass', () => {
    const sql = broadcastMigration();
    // fn_sync_seat_first_player_count is reached by BOTH seating paths, the
    // human's and the horse's (CLAUDE.md 10.5 - a horse fills a board exactly
    // as a human does, so it must announce it exactly as a human does). Moving
    // the send to a caller instead would give one of them a slower wheel.
    expect(sql).toContain('fn_sync_seat_first_player_count');
  });

  it('a failed broadcast can never refuse a player their seat', () => {
    const sql = broadcastMigration();
    // §11.5's lesson, learned here the hard way once already: an alarm added
    // inside fn_take_seat_and_buy_in raised 42703 and would have REFUSED the
    // seat. Notification is never worth a player's buy-in. The send is wrapped
    // so its failure degrades to the poll, which is the old behaviour.
    const idx = sql.indexOf('realtime.send');
    const before = sql.slice(Math.max(0, idx - 600), idx);
    const after = sql.slice(idx, idx + 600);
    expect(before).toContain('BEGIN');
    expect(after).toMatch(/EXCEPTION\s+WHEN\s+OTHERS/i);
  });

  it('only a genuinely full board announces itself', () => {
    const sql = broadcastMigration();
    // Announcing a half-sold board would have the engine start a Spin with two
    // seats paid. The gate is the same one the poll uses: seats >= capacity,
    // capacity known, and the board actually seat-first.
    expect(sql).toMatch(/v_seats\s*>=\s*v_cap/);
    expect(sql).toMatch(/v_cap\s*>\s*0/);
    expect(sql).toMatch(/COALESCE\(\s*v_seat_first\s*,\s*false\s*\)/);
  });

  it('the poll survives as the backstop and is NOT deleted', () => {
    // This is the pin that makes the push safe to ship. A dropped socket, a
    // realtime restart or a missed message must cost lateness, never a game
    // that never starts. Deleting the poll to "clean up" would turn every
    // realtime hiccup into a board of three players sitting forever.
    expect(gameServer).toContain('discoverSeatFirstStarts');
    expect(gameServer).toMatch(/SEAT_FIRST_START_INTERVAL/);
  });

  it('the push and the poll cannot both start the same game', () => {
    // Two managers on one tournament would deal two hands to one table. Both
    // paths consult tournamentEngines and claim the id with no await between
    // the check and the set, so one manager per id is structural, not lucky.
    const fn = gameServer.slice(
      gameServer.indexOf('private startSeatFirstNow('),
      gameServer.indexOf('private async discoverSeatFirstStarts(')
    );
    expect(fn).toContain('this.tournamentEngines.has(id)');
    expect(fn).toContain('this.tournamentEngines.set(id, tm)');
    // The claim must be made before start() is awaited on, or the window
    // reopens.
    expect(fn.indexOf('this.tournamentEngines.set(id, tm)')).toBeLessThan(fn.indexOf('tm.start()'));
  });

  it('the listener is actually wired, not merely written', () => {
    // Dead code is the quietest way for this to regress: the method exists,
    // reads correctly in review, and is never called.
    expect(gameServer).toContain('this.subscribeSeatFirstReady();');
  });

  it('a pre-drawn multiplier still receives its own tier payouts', () => {
    // Why this pin lives in THIS file: removing the poll from the path makes
    // drawing the multiplier at buy-in time the next honest second to shave.
    // That is only safe while the tier patch - blinds, payouts, prize pool -
    // is written for EVERY spin rather than only for the ones this process
    // drew itself. If the patch is ever moved back inside the
    // `if (!spinMultiplier)` branch, a pre-drawn 25x would pay 100% to first
    // place on a board that owes three players. That was the Spin Royale bug.
    const tm = readFileSync(
      join(repo, 'server', 'src', 'tournament', 'TournamentManagerBase.ts'),
      'utf8'
    );
    const drawGate = tm.indexOf(
      'if (!spinMultiplier || spinMultiplier <= 0) {\n          // THE DRAW'
    );
    const patch = tm.indexOf('const spinRowPatch = {');
    const tier = tm.indexOf('const tier = spinTier(spinMultiplier);');
    expect(drawGate).toBeGreaterThan(-1);
    expect(tier).toBeGreaterThan(drawGate);
    expect(patch).toBeGreaterThan(tier);
    // Same indentation as the gate itself = same block depth = outside it.
    for (const needle of ['const tier = spinTier(spinMultiplier);', 'const spinRowPatch = {']) {
      const line = tm.slice(tm.lastIndexOf('\n', tm.indexOf(needle)) + 1, tm.indexOf(needle));
      expect(line).toBe('        ');
    }
  });
});
