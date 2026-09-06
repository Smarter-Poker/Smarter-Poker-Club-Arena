/**
 * HORSES USE THE SEAT CHANGE LIKE HUMANS (CLAUDE.md 10.5, 2026-09-05)
 *
 * The must-move lobby gave every player on a feeder table a Seat Change they
 * may use once per stay. `fn_cash_seat_change_request` read `auth.uid()`, the
 * engine has none, and so the horses - who are most of the feeder population -
 * could not press a button every human can see. 10.5 is unambiguous about
 * that shape: "if you find yourself typing `is_horse` in order to leave horses
 * OUT of something a human would get, stop", and a door that only a browser
 * can open is the same thing written in SQL.
 *
 * Two halves are pinned here:
 *   THE DECISION - `seatChangeVerdict` is rate-limited and refuses for the
 *     same reasons the database refuses;
 *   THE WIRING   - the horse path goes through the SAME RPC name the client
 *     calls, with no parallel horse-only door.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SEAT_CHANGE_MIN_MINUTES,
  seatChangeVerdict,
  wantsSeatChange,
  type SeatChangeSituation,
} from './HorseBehavior.js';
import { seatChangeRefusalCode } from './supabase/seatChange.js';

const REPO = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(REPO, p), 'utf8');

const T0 = 1_757_052_000_000; // fixed epoch ms so every roll is reproducible

/** A horse who has been sitting on a two-table feeder for forty minutes. */
function situation(over: Partial<SeatChangeSituation> = {}): SeatChangeSituation {
  return {
    horseId: 'horse-0000-4000-8000-000000000001',
    tableId: 'table-0000-4000-8000-000000000001',
    gameId: 'game-0000-4000-8000-0000000000001',
    role: 'feeder',
    mainIndex: null,
    lifecycle: 'live',
    seatedCount: 6,
    minutesAtTable: 40,
    otherTables: 2,
    leaving: false,
    changeUsed: false,
    nowMs: T0,
    ...over,
  };
}

describe('the refusals, and they are the database refusals', () => {
  it('a table that is not part of a must-move game has no seat change', () => {
    expect(seatChangeVerdict(situation({ gameId: null }))).toBe('not_in_game');
  });

  it('THE MAIN GAME HAS NO SEAT CHANGE (SEAT_CHANGE_NOT_FROM_MAIN)', () => {
    expect(seatChangeVerdict(situation({ role: 'main', mainIndex: 1 }))).toBe('main_one');
    // Main 2 and up ARE feeder games in Dan's words, and do have one.
    expect(seatChangeVerdict(situation({ role: 'main', mainIndex: 2, seatedCount: 3 }))).not.toBe(
      'main_one'
    );
  });

  it('a closing table is already moving everyone (SEAT_CHANGE_TABLE_CLOSING)', () => {
    expect(seatChangeVerdict(situation({ lifecycle: 'breaking' }))).toBe('table_closing');
    expect(seatChangeVerdict(situation({ lifecycle: 'closed' }))).toBe('table_closing');
  });

  it('nowhere to go is a refusal, not a request (SEAT_CHANGE_NO_OTHER_TABLE)', () => {
    expect(seatChangeVerdict(situation({ otherTables: 0 }))).toBe('no_other_table');
  });

  it('the once-per-stay budget is respected before the roll (SEAT_CHANGE_USED)', () => {
    expect(seatChangeVerdict(situation({ changeUsed: true }))).toBe('used');
  });

  it('a horse on its way out does not ask the floor to reseat it', () => {
    expect(seatChangeVerdict(situation({ leaving: true }))).toBe('leaving');
  });

  it('nobody asks in their first half hour', () => {
    expect(seatChangeVerdict(situation({ minutesAtTable: SEAT_CHANGE_MIN_MINUTES - 0.1 }))).toBe(
      'too_new'
    );
    expect(SEAT_CHANGE_MIN_MINUTES).toBeGreaterThanOrEqual(20); // past MIN_SESSION_MINUTES
  });

  it('the structural refusals are reported before the timing ones', () => {
    // A brand-new horse on Main 1 reads main_one, so the caller's log is true
    // about why it declined.
    expect(seatChangeVerdict(situation({ role: 'main', mainIndex: 1, minutesAtTable: 1 }))).toBe(
      'main_one'
    );
  });
});

describe('the rate limit', () => {
  /** How many of `n` horses would ask on one cycle in this situation. */
  function askRate(n: number, over: Partial<SeatChangeSituation> = {}): number {
    let asked = 0;
    for (let i = 0; i < n; i++) {
      if (wantsSeatChange(situation({ horseId: `horse-${i}`, ...over }))) asked++;
    }
    return asked / n;
  }

  it('is a small fraction of the floor per cycle, and it is not zero', () => {
    const full = askRate(4000, { seatedCount: 8 });
    const mid = askRate(4000, { seatedCount: 5 });
    const short = askRate(4000, { seatedCount: 3 });
    // Believable per 90-second cycle: rare on a full table, likelier as the
    // game empties, never a stampede.
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThan(0.01);
    expect(mid).toBeLessThan(0.02);
    expect(short).toBeLessThan(0.04);
    // A dying table is where a player actually asks to be moved.
    expect(short).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(full);
  });

  it('does not re-roll inside the same minute, so two passes cannot double-ask', () => {
    const s = situation({ seatedCount: 3 });
    for (let i = 0; i < 500; i++) {
      const a = seatChangeVerdict({ ...s, horseId: `horse-${i}`, nowMs: T0 });
      const b = seatChangeVerdict({ ...s, horseId: `horse-${i}`, nowMs: T0 + 45_000 });
      expect(a).toBe(b);
    }
  });

  it('the same horse at the same table is stable across a restart', () => {
    // Nothing here reads Math.random, so a process that restarts mid-minute
    // cannot re-roll a horse into asking immediately.
    const s = situation({ seatedCount: 3, horseId: 'horse-77' });
    expect(seatChangeVerdict(s)).toBe(seatChangeVerdict({ ...s }));
  });

  it('a horse asks about DIFFERENT tables independently', () => {
    // A horse multi-tables up to four games; its verdict at one must not
    // determine its verdict at another.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(seatChangeVerdict(situation({ tableId: `table-${i}`, seatedCount: 3 })));
    }
    expect(seen.has('ask')).toBe(true);
    expect(seen.has('not_this_cycle')).toBe(true);
  });
});

describe('the refusal code the door gives is read, not guessed', () => {
  it('takes the code from the front of the message', () => {
    expect(
      seatChangeRefusalCode('SEAT_CHANGE_USED: you have used your seat change for this game')
    ).toBe('SEAT_CHANGE_USED');
    expect(seatChangeRefusalCode('MOVE_PENDING: you are already being moved')).toBe('MOVE_PENDING');
    expect(seatChangeRefusalCode('some postgres noise')).toBe('unknown');
    expect(seatChangeRefusalCode(null)).toBe('unknown');
  });
});

describe('the wiring: the horse presses the same button', () => {
  const CLIENT = read('src/services/cashGameLobby.ts');
  const ENGINE = read('server/src/services/supabase/seatChange.ts');
  const ROTATOR = read('server/src/services/HorseSessionRotator.ts');
  const MIGRATION = read(
    'supabase/migrations/20260905064237_horses_use_the_seat_change_and_presence_follows_the_move.sql'
  );

  /** Every RPC name either side asks for a seat change with. */
  const rpcNames = (src: string) => [
    ...new Set([...src.matchAll(/rpc\(\s*'([a-z0-9_]*seat_change[a-z0-9_]*)'/g)].map((m) => m[1])),
  ];

  it('THE SAME RPC NAME, on both sides', () => {
    expect(rpcNames(CLIENT)).toContain('fn_cash_seat_change_request');
    // Exactly one, so no horse-only variant can be slipped in beside it.
    expect(rpcNames(ENGINE)).toEqual(['fn_cash_seat_change_request']);
  });

  it('the engine names the horse and nothing else', () => {
    expect(ENGINE).toMatch(/p_game_id: gameId/);
    expect(ENGINE).toMatch(/p_to_table_id: toTableId/);
    expect(ENGINE).toMatch(/p_user_id: userId/);
  });

  it('there is no horse-only door and no direct write to the request table', () => {
    // A parallel path is how a horse ends up with a different deal.
    // Neither side touches the request table or the roster directly: the
    // budget and the queue are the door's to write, for a horse as for a
    // person. (Prose naming them is fine; a query is not.)
    expect(ENGINE).not.toMatch(/from\(\s*'cash_seat_change_requests'/);
    expect(ROTATOR).not.toMatch(/from\(\s*'cash_seat_change_requests'/);
    expect(ROTATOR).not.toMatch(/from\(\s*'cash_game_roster'/);
    // 2026-09-05 (no lone horse): the rotator READS cash_seat_moves - is a
    // partner pending into a lone table - and never writes it.
    const moves = [...ROTATOR.matchAll(/from\(\s*'cash_seat_moves'\)([\s\S]{0,200})/g)];
    expect(moves.length).toBe(1);
    expect(moves[0][1]).toMatch(/^\s*\.select\('to_table_id'\)/);
    expect(moves[0][1]).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(ROTATOR).not.toMatch(/\.rpc\(/);
  });

  it('the rotator asks through that module, gated by seatChangeVerdict', () => {
    expect(ROTATOR).toMatch(
      /import \{ requestSeatChangeFor \} from '\.\/supabase\/seatChange\.js'/
    );
    const pass = ROTATOR.slice(ROTATOR.indexOf('private async considerSeatChanges'));
    expect(pass).toMatch(/seatChangeVerdict\(\{/);
    expect(pass).toMatch(/if \(verdict !== 'ask'\) continue;/);
    expect(pass).toMatch(/await requestSeatChangeFor\(gameId, userId, null\)/);
  });

  it('a refusal is recorded and never retried in a loop', () => {
    const pass = ROTATOR.slice(ROTATOR.indexOf('private async considerSeatChanges'));
    // The suppression is written BEFORE the call, so a throw on the way out
    // cannot leave the horse eligible again on the next cycle.
    const write = pass.indexOf(
      'this.seatChangeAsked.set(key, now + HorseSessionRotator.SEAT_CHANGE_STAY_MS)'
    );
    const call = pass.indexOf('await requestSeatChangeFor(');
    expect(write).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(write);
    expect(pass).toMatch(/if \(this\.seatChangeAsked\.has\(key\)\) continue;/);
  });

  it('the freeze and a queued human both stop the pass', () => {
    const pass = ROTATOR.slice(ROTATOR.indexOf('private async considerSeatChanges'));
    expect(pass).toMatch(/if \(isMaintenanceFrozen\(\)\) return;/);
    expect(pass).toMatch(/if \(\(humansWaiting\.get\(tableId\) \?\? 0\) > 0\) continue;/);
  });

  it('the migration honours p_user_id only for the engine, and keeps one door', () => {
    expect(MIGRATION).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_cash_seat_change_request\(uuid, uuid\);/
    );
    expect(MIGRATION).toMatch(
      /v_uid uuid := CASE WHEN public\.fn_caller_is_engine\(\) THEN coalesce\(p_user_id, auth\.uid\(\)\)\s*\n?\s*ELSE auth\.uid\(\) END;/
    );
    // The human path still refuses everything it refused before.
    for (const code of [
      'SEAT_CHANGE_NOT_FROM_MAIN',
      'SEAT_CHANGE_NEVER_TO_MAIN',
      'SEAT_CHANGE_USED',
      'SEAT_CHANGE_TABLE_CLOSING',
      'SEAT_CHANGE_NO_OTHER_TABLE',
      'MOVE_PENDING',
      'PLATFORM_FROZEN',
    ]) {
      expect(MIGRATION).toContain(code);
    }
    // And the once-per-roster-row budget is still the database's.
    expect(MIGRATION).toMatch(/UPDATE public\.cash_game_roster SET seat_change_used_at = now\(\)/);
  });
});
