import { describe, it, expect } from 'vitest';
import { tournamentOriginalFundingMatchesAccepted as matches } from './tournamentAcceptedFunding.js';
/** Parsed stack_result_text uses the maintained accepted-oracle fixture's
 * success/table_id/hand_number/tournament_id/request.stacks structure. */
function fixture() {
  const players = [
    { user_id: 'hero', stack: 80, totalInvested: 20 },
    { user_id: 'villain', stack: 0, totalInvested: 40 },
  ];
  const snapshot = {
    type: 'DECIDE_FAST',
    player: { ...players[0] },
    gameState: {
      gameMode: 'tournament',
      players,
      tournament: {
        tournamentId: 'spin',
        stackByUser: { hero: 100, villain: 40 },
        stacks: [100, 40],
        contextProvenance: { projection: { tableId: 'table', handNumber: 12 } },
      },
    },
  };
  const accepted = {
    success: true,
    hand_id: '90000000-0000-4000-8000-000000000009',
    table_id: 'table',
    hand_number: 12,
    tournament_id: 'spin',
    players: 2,
    mode: 'delta',
    departed: [],
    rebased: {},
    written: { hero: 140, villain: 0 },
    request: {
      stacks: [
        {
          user_id: 'hero',
          stack: 140,
          stack_before: 100,
          seat_id: 'seat1',
          seat_joined_at: '2026-10-25T00:00:00Z',
        },
        {
          user_id: 'villain',
          stack: 0,
          stack_before: 40,
          seat_id: 'seat2',
          seat_joined_at: '2026-10-25T00:00:00Z',
        },
      ],
      rake: 0,
      bbj: 0,
      inflow: 0,
    },
  };
  return { snapshot, accepted };
}
describe('pure original funding comparison, never accepted-source authority', () => {
  it('matches exact original deal funds even when terminal stacks differ', () => {
    const f = fixture();
    expect(matches(f.snapshot, f.accepted)).toBe(true);
  });
  it('refuses altered original/context/accepted funding and nonconserved field', () => {
    for (const change of [
      (f: any) => f.accepted.request.stacks[0].stack_before++,
      (f: any) => f.snapshot.gameState.tournament.stackByUser.hero++,
      (f: any) => f.snapshot.gameState.players[1].totalInvested++,
      (f: any) => f.snapshot.player.stack++,
      (f: any) => f.snapshot.gameState.tournament.stacks[1]++,
    ]) {
      const f = fixture();
      change(f);
      expect(matches(f.snapshot, f.accepted)).toBe(false);
    }
  });
  it('refuses missing captures, unknown values, fractional/zero/unsafe starting funds', () => {
    for (const value of [
      undefined,
      null,
      NaN,
      Infinity,
      100.5,
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const f = fixture();
      (f.accepted.request.stacks[0] as any).stack_before = value;
      expect(matches(f.snapshot, f.accepted)).toBe(false);
    }
    for (const bad of [null, {}, [], { stack_result: fixture().accepted }])
      expect(matches(fixture().snapshot, bad)).toBe(false);
  });
  it('refuses duplicate/extra/foreign actors and incomplete original field', () => {
    for (const change of [
      (f: any) => (f.accepted.request.stacks[1].user_id = 'hero'),
      (f: any) =>
        f.accepted.request.stacks.push({ ...f.accepted.request.stacks[0], user_id: 'extra' }),
      (f: any) => (f.accepted.request.stacks[1].user_id = 'other'),
      (f: any) => (f.snapshot.gameState.players[1].user_id = 'hero'),
      (f: any) => delete f.snapshot.gameState.tournament.stackByUser.villain,
      (f: any) => (f.snapshot.gameState.tournament.stackByUser.extra = 1),
    ]) {
      const f = fixture();
      change(f);
      expect(matches(f.snapshot, f.accepted)).toBe(false);
    }
  });
  it('binds accepted tournament/table/hand and any present request coordinates', () => {
    for (const change of [
      (f: any) => (f.accepted.tournament_id = 'other'),
      (f: any) => (f.accepted.table_id = 'other'),
      (f: any) => (f.accepted.hand_number = 13),
      (f: any) => (f.accepted.request.tournament_id = null),
      (f: any) => (f.accepted.request.table_id = 'other'),
      (f: any) => (f.accepted.request.hand_number = 13),
      (f: any) => (f.snapshot.gameState.tournament.tournamentId = 'other'),
    ]) {
      const f = fixture();
      change(f);
      expect(matches(f.snapshot, f.accepted)).toBe(false);
    }
    const f = fixture();
    Object.assign(f.accepted.request, {
      tournament_id: 'spin',
      table_id: 'table',
      hand_number: 12,
    });
    expect(matches(f.snapshot, f.accepted)).toBe(true);
  });
  it('never substitutes final stack/written/net for absent stack_before', () => {
    const f = fixture();
    delete (f.accepted.request.stacks[0] as any).stack_before;
    f.accepted.request.stacks[0].stack = 100;
    f.accepted.written.hero = 100;
    (f.accepted.request.stacks[0] as any).net = 0;
    expect(matches(f.snapshot, f.accepted)).toBe(false);
  });
});
