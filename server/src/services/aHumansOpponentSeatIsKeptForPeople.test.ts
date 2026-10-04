/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A HUMAN'S OPPONENT SEAT IS KEPT FOR PEOPLE FIRST (2026-10-04)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "HEADS UP SIT N GO'S DID NOT WORK WHEN 2 HUMAN PLAYERS TRIED TO SIT
 * DOWN AND PLAY TOGETHER. IT JUST FROZE AND NEVER DEALT CARDS."
 *
 * Production, 2026-10-04: KingFish sat at the empty NLH Heads-Up 1 board at
 * 19:37:19.208; a horse took the other seat at 19:37:22.994 and the game dealt
 * at 19:37:23.757, eleven seconds before the board's own window (start_time
 * 19:37:34.708) closed. The second player met a horse on every heads-up board
 * he opened in the same minute. These pins replay that timeline against the
 * rule and drive topUpWithHorses through it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpcMock = vi.fn();
type TableAnswer = { data: unknown; error: { message: string } | null };
let tableResults: Record<string, TableAnswer> = {};

vi.mock('./supabase/client.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order', 'neq', 'not', 'update', 'gt']) {
      b[m] = () => b;
    }
    const answer = () =>
      Promise.resolve(
        tableResults[table] ?? { data: null, error: { message: `no mock for ${table}` } }
      );
    b.maybeSingle = answer;
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => answer().then(ok, bad);
    return b;
  };
  const client = {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (table: string) => builder(table),
  };
  return { supabase: client, maintenanceSupabase: client };
});
const reportErrorMock = vi.fn();
vi.mock('./errorReporter.js', () => ({ reportError: (...a: unknown[]) => reportErrorMock(...a) }));

import {
  SEAT_FIRST_HUMAN_PARTNER_HOLD_MS,
  SEAT_FIRST_HUMAN_WINDOW_MAX_MS,
  TournamentRecurringService,
  firstHumanSeatedAtMs,
  seatFirstHumanPartnerHoldUntilMs,
} from './TournamentRecurringService.js';

const GAME_SERVER = readFileSync(join(__dirname, '..', 'GameServer.ts'), 'utf8');

const SAT = Date.parse('2026-10-04T19:37:19.208Z');
const WINDOW = Date.parse('2026-10-04T19:37:34.708Z');
const HORSE_TOOK_IT = Date.parse('2026-10-04T19:37:22.994Z');

describe('the rule', () => {
  it('replays 2026-10-04: the horse that sat 3.8 s after KingFish is refused', () => {
    const until = seatFirstHumanPartnerHoldUntilMs(WINDOW, SAT);
    expect(until).toBe(SAT + SEAT_FIRST_HUMAN_PARTNER_HOLD_MS);
    expect(until).toBeGreaterThan(HORSE_TOOK_IT);
    expect(SEAT_FIRST_HUMAN_PARTNER_HOLD_MS).toBe(90_000);
  });

  it("keeps the board's own window when it is the later of the two", () => {
    const late = SAT + 200_000;
    expect(seatFirstHumanPartnerHoldUntilMs(late, SAT)).toBe(late);
  });

  it('never holds longer than the window ceiling after the first human sat', () => {
    expect(seatFirstHumanPartnerHoldUntilMs(SAT + 86_400_000, SAT)).toBe(
      SAT + SEAT_FIRST_HUMAN_WINDOW_MAX_MS
    );
  });

  it('an unreadable start time still gets the 90 s floor', () => {
    expect(seatFirstHumanPartnerHoldUntilMs(NaN, SAT)).toBe(SAT + 90_000);
  });

  it('no seated human holds nothing', () => {
    expect(seatFirstHumanPartnerHoldUntilMs(WINDOW, NaN)).toBe(-Infinity);
  });

  it('measures from the FIRST human to sit, ignoring horses', () => {
    const seats = [
      { user_id: 'horse', joined_at: '2026-10-04T19:30:00.000Z' },
      { user_id: 'b', joined_at: '2026-10-04T19:38:00.000Z' },
      { user_id: 'a', joined_at: '2026-10-04T19:37:19.208Z' },
    ];
    expect(firstHumanSeatedAtMs(seats, (id) => id !== 'horse')).toBe(SAT);
    expect(firstHumanSeatedAtMs(seats, () => false)).toBeNaN();
  });
});

describe('topUpWithHorses honours the hold', () => {
  const T = 'aaaaaaaa-0000-4000-8000-0000000000aa';
  const TABLE = 'bbbbbbbb-0000-4000-8000-0000000000bb';
  const HUMAN = 'cccccccc-0000-4000-8000-0000000000cc';
  let svc: TournamentRecurringService;
  let pick: ReturnType<typeof vi.spyOn>;

  function board(humanSatMsAgo: number, windowMsFromNow: number, isHorse = false) {
    tableResults = {
      tournaments: {
        data: {
          variant: 'sng',
          format_contract: 'sng-v1',
          max_players: 2,
          club_id: 'club',
          start_time: new Date(Date.now() + windowMsFromNow).toISOString(),
          prize_pool_finalized: false,
        },
        error: null,
      },
      table_seats: {
        data: [
          {
            user_id: HUMAN,
            seat_number: 1,
            joined_at: new Date(Date.now() - humanSatMsAgo).toISOString(),
          },
        ],
        error: null,
      },
      profiles: { data: [{ id: HUMAN, is_horse: isHorse }], error: null },
      tables: { data: { max_players: 2 }, error: null },
    };
  }

  beforeEach(() => {
    rpcMock.mockReset();
    reportErrorMock.mockReset();
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_primary_table') return { data: TABLE, error: null };
      return { data: { ok: true, seat_number: 2 }, error: null };
    });
    svc = new TournamentRecurringService();
    pick = vi
      .spyOn(svc as unknown as { pickFreeHorses: () => Promise<string[]> }, 'pickFreeHorses')
      .mockResolvedValue(['free-1', 'free-2']);
    vi.spyOn(
      svc as unknown as { unseatedRegistrantHorses: () => Promise<string[]> },
      'unseatedRegistrantHorses'
    ).mockResolvedValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a human who sat 4 s ago keeps the other seat for a person: no horse is picked', async () => {
    board(4_000, 11_000);
    expect(await svc.topUpWithHorses(T, 2, { forHuman: true })).toBe(0);
    expect(pick).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalledWith('fn_seat_horse_in_seat_first_game', expect.anything());
  });

  it('once the hold has run out, the board fills exactly as before', async () => {
    board(95_000, -60_000);
    expect(await svc.topUpWithHorses(T, 2, { forHuman: true })).toBe(1);
    expect(pick).toHaveBeenCalled();
  });

  it('a horse-only partial board is not held by this rule', async () => {
    board(4_000, -1_000, true);
    expect(await svc.topUpWithHorses(T, 2)).toBe(1);
  });

  it('an unreadable occupant read is reported and holds nothing', async () => {
    board(4_000, 11_000);
    tableResults.profiles = { data: null, error: { message: 'boom' } };
    expect(await svc.topUpWithHorses(T, 2, { forHuman: true })).toBe(1);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      'TournamentRecurring.seat_first_partner_hold_read_failed'
    );
  });
});

describe('the fast lane waits out the hold quietly', () => {
  const start = GAME_SERVER.indexOf('private async fillPartialSeatFirstGame(');
  const fill = GAME_SERVER.slice(start, GAME_SERVER.indexOf('\n  private ', start + 10));

  it('does not ask, count a miss or alarm while the hold runs', () => {
    expect(fill).toContain('seatFirstHumanPartnerHoldUntilMs(startMs, occupancy.firstHumanAtMs)');
    const hold = fill.indexOf('if (holdUntil > now)');
    const ask = fill.indexOf('await this.topUpPartialSeatFirst(');
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(ask);
  });

  it("declares the human's seats in the hold's last stretch so horses are free when it ends", () => {
    expect(fill).toContain('holdUntil - now <= HUMAN_SEAT_DEMAND_TTL_MS');
    expect(fill).toContain('noteHumanSeatDemand(tournamentId, seats - paid)');
  });
});
