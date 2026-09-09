/**
 * GHOST SEATS IN TOURNAMENTS (2026-08-28).
 *
 * Reported: one horse (ShoveWhale) sat with 0 chips, not marked eliminated,
 * for 22 minutes, in a running 326-player freeroll that had recorded ZERO
 * eliminations. Nothing was wedged — the 5-second elimination sweep was
 * arriving minutes late, because it issued one awaited seat read PER TABLE and
 * that event had 37 of them. The bigger the field, the later the sweep, which
 * is precisely backwards.
 *
 * A ghost seat is not cosmetic: it holds a chair other players are waiting
 * for, it counts toward the four-table limit so the account cannot be seated
 * anywhere else, and it cannot act, so every orbit burns a full turn timer
 * folding somebody who is not there.
 *
 * A cash table has had rebuy-or-remove on every idle tick since 2026-08-15
 * (recoverBustedSeatedHorses). A tournament table had nothing of its own.
 * These tests cover the counterpart, and — just as importantly — the two
 * things it must NOT do.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const markSeatAsLeft = vi.fn();

vi.mock('../services/supabase.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/supabase.js');
  return {
    ...actual,
    markSeatAsLeft: (...a: unknown[]) => markSeatAsLeft(...a),
  };
});

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const occupancyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TABLE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TOURNEY = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

type Seat = { user_id: string; username: string; seat_number: number; stack: number };

/** A tournament table holding `seated`, whose roster reads `roster`. */
function engineWith(
  seated: Seat[],
  roster: Array<{ user_id: string; status: string }> | { error: true }
) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.seatedPlayers = seated.map((s) => ({ ...s, is_horse: true, occupancy_id: occupancyId }));
  engine.tableInfo = { id: TABLE, tournament_id: TOURNEY };
  engine.disconnectEngine = { unregisterPlayer: vi.fn() };
  engine.timeBankEngine = { removePlayer: vi.fn() };
  engine.straddleEngine = { removePlayer: vi.fn() };
  engine.preActionEngine = { removePlayer: vi.fn() };

  vi.spyOn(supabase, 'from').mockReturnValue({
    select: () => ({
      eq: () => ({
        in: () =>
          Promise.resolve(
            'error' in roster
              ? { data: null, error: new Error('roster unreadable') }
              : { data: roster, error: null }
          ),
      }),
    }),
  } as never);

  return engine;
}

beforeEach(() => {
  vi.restoreAllMocks();
  markSeatAsLeft.mockReset().mockResolvedValue(undefined);
});

describe('a chair is released when the field says the player is out', () => {
  it('releases the seat of an eliminated player still sitting there', () => {
    const engine = engineWith(
      [{ user_id: 'ghost', username: 'ShoveWhale', seat_number: 3, stack: 0 }],
      [{ user_id: 'ghost', status: 'eliminated' }]
    );
    return engine.releaseDeadTournamentSeats().then(() => {
      expect(markSeatAsLeft).toHaveBeenCalledWith(TABLE, 'ghost', 3, occupancyId);
      // And the chair is free for the hand about to be dealt, not the next one.
      expect(engine.seatedPlayers).toHaveLength(0);
    });
  });

  it('releases a winner who is still holding a chair', async () => {
    const engine = engineWith(
      [{ user_id: 'champ', username: 'Champ', seat_number: 1, stack: 5000 }],
      [{ user_id: 'champ', status: 'winner' }]
    );
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).toHaveBeenCalledWith(TABLE, 'champ', 1, occupancyId);
  });

  it('releases a seat held by somebody with no row in this tournament at all', async () => {
    const engine = engineWith(
      [{ user_id: 'stranger', username: 'Stranger', seat_number: 5, stack: 100 }],
      []
    );
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).toHaveBeenCalledWith(TABLE, 'stranger', 5, occupancyId);
  });

  it('tears down the per-player engines with the seat', async () => {
    // Or every released player strands an FSM entry, a time bank, a straddle
    // and a pre-action behind them — the same teardown settlement performs.
    const engine = engineWith(
      [{ user_id: 'ghost', username: 'Ghost', seat_number: 2, stack: 0 }],
      [{ user_id: 'ghost', status: 'eliminated' }]
    );
    await engine.releaseDeadTournamentSeats();
    expect(engine.disconnectEngine.unregisterPlayer).toHaveBeenCalledWith(TABLE, 'ghost');
    expect(engine.timeBankEngine.removePlayer).toHaveBeenCalledWith(TABLE, 'ghost');
    expect(engine.straddleEngine.removePlayer).toHaveBeenCalledWith(TABLE, 'ghost');
    expect(engine.preActionEngine.removePlayer).toHaveBeenCalledWith(TABLE, 'ghost');
  });
});

describe('what it must never do', () => {
  it('never eliminates a busted player itself', async () => {
    // Eliminating is assigning a finishing place and paying a prize against
    // it. Two writers of finishing places is the exact shape of the 206
    // duplicated places found on 2026-08-27. A bust that is still 'playing'
    // belongs to the sweep, however late the sweep is.
    const engine = engineWith(
      [{ user_id: 'busted', username: 'Busted', seat_number: 4, stack: 0 }],
      [{ user_id: 'busted', status: 'playing' }]
    );
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).not.toHaveBeenCalled();
    expect(engine.seatedPlayers).toHaveLength(1);
  });

  it('leaves a live player alone', async () => {
    const engine = engineWith(
      [{ user_id: 'live', username: 'Live', seat_number: 6, stack: 12_000 }],
      [{ user_id: 'live', status: 'playing' }]
    );
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).not.toHaveBeenCalled();
  });

  it('releases nobody when the roster read fails', async () => {
    // An unreadable roster is UNKNOWN, not "everybody is fine". Releasing on a
    // failed read takes a live player off the felt mid-hand, which is far
    // worse than a ghost that waits one more tick.
    const engine = engineWith(
      [{ user_id: 'live', username: 'Live', seat_number: 6, stack: 12_000 }],
      { error: true }
    );
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).not.toHaveBeenCalled();
    expect(engine.seatedPlayers).toHaveLength(1);
  });

  it('does nothing on a cash table', async () => {
    const engine = engineWith(
      [{ user_id: 'anyone', username: 'Anyone', seat_number: 1, stack: 0 }],
      [{ user_id: 'anyone', status: 'eliminated' }]
    );
    engine.tableInfo = { id: TABLE, tournament_id: null };
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).not.toHaveBeenCalled();
  });

  it('has no is_horse test in it - CLAUDE.md 10.5', async () => {
    // A human whose seat release failed is sitting in the same ghost chair for
    // the same reason. The reported case being a horse says nothing about who
    // it happens to.
    const engine = engineWith(
      [{ user_id: 'human', username: 'Human', seat_number: 7, stack: 0 }],
      [{ user_id: 'human', status: 'eliminated' }]
    );
    engine.seatedPlayers = engine.seatedPlayers.map((p: { is_horse: boolean }) => ({
      ...p,
      is_horse: false,
    }));
    await engine.releaseDeadTournamentSeats();
    expect(markSeatAsLeft).toHaveBeenCalledWith(TABLE, 'human', 7, occupancyId);
  });
});
