/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ALL-IN-OR-FOLD (2026-08-22 tournament parity)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * At an AoF table, preflop offers exactly two decisions: fold, or shove
 * (the big blind may check when unraised). Drives the REAL HandController with
 * `allInOrFold: true` and asserts both halves of the contract:
 *
 *   - performAction is the authoritative gate — call/bet/raise are REJECTED;
 *   - getAvailableActions mirrors it so the menu can never disagree.
 *
 * Also pins (as source text) the wiring that puts the rule on the felt: the
 * tables row column reaching the engine's table select, tournament table
 * creation stamping it, and the horse decision coercion — a horse's non-fold
 * intent must become the all-in, or every horse seat at an AoF table would
 * stall on rejected actions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HandController } from '../../server/src/engine/HandController';
import type { HandConfig, SeatPlayer } from '../../server/src/types';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

function mkPlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map(
    (stack, i) =>
      ({
        seat: i + 1,
        user_id: `u${i + 1}`,
        username: `P${i + 1}`,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
}

function mkAofConfig(over: Partial<HandConfig> = {}): HandConfig {
  return {
    tableId: 't-aof',
    handNumber: 1,
    gameVariant: 'nlh',
    smallBlind: 1,
    bigBlind: 2,
    allInOrFold: true,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...over,
  } as HandConfig;
}

function harness(players: SeatPlayer[]) {
  const hc = new HandController(mkAofConfig(), players, 1);
  const events: any[] = [];
  hc.onEvent((e) => events.push(e));
  hc.start();
  const st = () => (hc as unknown as { state: any }).state;
  return { hc, events, st, cur: () => st().currentPlayerSeat };
}

describe('AoF: performAction is the authoritative preflop gate', () => {
  it('rejects call, bet and raise; accepts fold and all_in', () => {
    const h = harness(mkPlayers([200, 200, 200]));
    const seat = h.cur(); // first to act preflop, facing the BB
    expect(h.hc.performAction(seat, 'call' as any, 2)).toBe(false);
    expect(h.hc.performAction(seat, 'raise' as any, 6)).toBe(false);
    expect(h.hc.performAction(seat, 'bet' as any, 6)).toBe(false);
    expect(h.hc.performAction(seat, 'check' as any)).toBe(false); // owes the BB
    expect(h.hc.performAction(seat, 'all_in' as any)).toBe(true);
    const p = h.st().players.find((pl: any) => pl.seat === seat);
    expect(p.is_all_in).toBe(true);
    expect(p.stack).toBe(0);
  });

  it('fold is always available', () => {
    const h = harness(mkPlayers([200, 200, 200]));
    expect(h.hc.performAction(h.cur(), 'fold' as any)).toBe(true);
  });

  it('a player owing nothing may check (the BB option)', () => {
    const h = harness(mkPlayers([200, 200, 200]));
    const st = h.st();
    // Synthesize the unraised-BB shape directly against the real gate: the
    // acting player's bet already matches the current bet level.
    const seat = h.cur();
    const player = st.players.find((p: any) => p.seat === seat);
    player.bet = st.currentBet;
    expect(h.hc.performAction(seat, 'check' as any)).toBe(true);
  });

  it('the TURN_CHANGE menu offers exactly fold + all_in when chips are owed', () => {
    const h = harness(mkPlayers([200, 200, 200]));
    const turn = h.events.filter((e) => e.type === 'TURN_CHANGE').pop();
    expect(turn).toBeTruthy();
    expect(turn.availableActions).toContain('fold');
    expect(turn.availableActions).toContain('all_in');
    expect(turn.availableActions).not.toContain('call');
    expect(turn.availableActions).not.toContain('raise');
    expect(turn.availableActions).not.toContain('bet');
    expect(turn.availableActions).not.toContain('check');
  });

  it('without the flag the normal menu is untouched', () => {
    const hc = new HandController(
      mkAofConfig({ allInOrFold: false }),
      mkPlayers([200, 200, 200]),
      1
    );
    const events: any[] = [];
    hc.onEvent((e) => events.push(e));
    hc.start();
    const turn = events.filter((e) => e.type === 'TURN_CHANGE').pop();
    expect(turn.availableActions).toContain('call');
  });
});

describe('AoF: engine wiring (source pins)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

  it('the table loader selects all_in_or_fold so the engine can see it', () => {
    expect(read('server/src/services/supabase/tables.ts')).toMatch(/all_in_or_fold/);
  });

  it('the hand config carries the flag from the tables row', () => {
    expect(read('server/src/engine/ServerTableEngineDealing.ts')).toMatch(
      /allInOrFold:\s*this\.tableInfo\.all_in_or_fold/
    );
  });

  it('tournament table creation stamps all_in_or_fold from the tournament', () => {
    expect(read('server/src/tournament/TournamentManagerBase.ts')).toMatch(
      /all_in_or_fold:\s*tournament\.all_in_or_fold === true/
    );
    expect(read('server/src/tournament/TournamentManager.ts')).toMatch(
      /all_in_or_fold:\s*this\.tournamentCache\?\.all_in_or_fold === true/
    );
  });

  it('horse decisions are coerced: non-fold becomes the all-in at AoF tables', () => {
    const turns = read('server/src/engine/ServerTableEngineTurns.ts');
    /* 2026-08-30: anchored on the bare string 'all_in_or_fold', whose FIRST
       occurrence used to be the coercion site itself. The V28 sitting-out
       work added an earlier, unrelated mention (telemetry), the anchor
       drifted onto it, and this pin went red while the coercion it guards
       had not changed by a character. Anchor on the coercion's own unique
       condition so no earlier mention can ever steal it again. */
    const anchor = "all_in_or_fold && currentState.stage === 'preflop'";
    expect(turns.indexOf(anchor)).toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(turns, anchor);
    expect(block).toMatch(/action !== 'fold'/);
    expect(block).toMatch(/action = 'all_in'/);
  });
});
