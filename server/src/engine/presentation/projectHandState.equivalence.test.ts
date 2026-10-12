/**
 * THE EXTRACTION CHANGED NOTHING (Lightning Phase 6, 2026-09-27).
 *
 * `projectLiveHandState` and `projectResyncHandState` replaced the payload
 * literals inside ServerTableEngine.broadcastCurrentState and getTableState.
 * This file keeps a FROZEN COPY of those literals exactly as they stood before
 * the move (`legacyLive`, `legacyResync`, with `this` spelled `e`) and asserts
 * that the engine, now building through the shared projection, publishes the
 * identical object - same keys, same order, same values - for hands driven
 * through every stage, with and without an all-in runout reveal, mucked
 * showdown hands, voluntary per-card shows, anonymous tables and players
 * waiting for the big blind. Fix the projection, never the frozen copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in projection fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in projection fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { ServerTableEngine } = await import('../ServerTableEngine.js');
const { HandController } = await import('../HandController.js');
const { mulberry32 } = await import('../HandFuzzer.js');
import type { SeatPlayer } from '../../types.js';
import { positionLabelsFor } from './projectHandState.js';

/* ── THE FROZEN COPY: ServerTableEngine.getTableState before 2026-09-27 ── */
function legacyResync(e: any, requestingUserId: string): Record<string, any> | null {
  if (!e.handController || !e.tableInfo) return null;
  const state = e.handController.getState();
  const currentSeatPlayer = state.players.find((p: any) => p.seat === state.currentPlayerSeat);
  return {
    table_id: e.tableId,
    hand_number: e.handCount,
    pot: state.pot ?? 0,
    community_cards: state.communityCards ?? [],
    community_cards2: state.communityCards2 ?? [],
    community_cards3: state.communityCards3 ?? [],
    hand_variant: e.activeHandVariant(),
    ...e.bombPotSnapshotFields(),
    ...e.killPotSnapshotFields(),
    ...e.anteSnapshotFields(),
    current_bet: state.currentBet ?? 0,
    current_player: currentSeatPlayer?.user_id ?? null,
    dealer_seat: state.dealerSeat ?? e.currentHandDealerSeat,
    stage: state.stage ?? 'preflop',
    max_seats: Number(e.tableInfo?.max_players) || 0,
    is_anonymous: e.tableInfo?.is_anonymous === true,
    min_raise: state.minRaise ?? 0,
    last_raise: state.lastRaise ?? 0,
    ...e.bettingStructureFields(state),
    action_context: e.getActionContext(),
    turn_start_time_ms: e.playerTurnStartTime,
    turn_duration_ms: e.playerTurnDuration * 1000,
    server_time_ms: Date.now(),
    ...e.pineappleDiscardSnapshotFields(),
    pots: (state.pots ?? []).map((p: any) => ({
      amount: p.amount,
      eligible: p.eligiblePlayers ?? [],
    })),
    action_history: (state.actionHistory ?? []).map((a: any) => ({
      seat: a.seat,
      userId: a.userId ?? '',
      action: a.action,
      amount: a.amount,
      timestamp: a.timestamp ?? 0,
      stage: a.stage,
    })),
    players: (() => {
      const positionLabels = e.getPositionLabels(
        state.dealerSeat ?? e.currentHandDealerSeat,
        state.players ?? []
      );
      return (state.players ?? []).map((p: any) => {
        let showCards = false;
        if (p.user_id === requestingUserId) {
          showCards = true;
        } else if (
          (state.stage === 'showdown' || e.runoutRevealActive) &&
          !p.is_folded &&
          !e.isMuckedAtShowdown(p.user_id)
        ) {
          showCards = true;
        }
        const picked = e.showHandCards?.get(p.user_id);
        const handIsOver = state.stage === 'showdown' || e.currentHandWinnerIds.length > 0;
        const partialReveal = !showCards && handIsOver && !!picked && picked.size > 0;
        const cardsOut = showCards
          ? (p.cards ?? [])
          : partialReveal
            ? (p.cards ?? []).map((card: any, index: number) => (picked!.has(index) ? card : null))
            : [];
        return {
          seat: p.seat,
          user_id: p.user_id,
          ...e.seatIdentity(p),
          stack: p.stack,
          bet: p.bet ?? 0,
          totalInvested: p.totalInvested ?? 0,
          cards: cardsOut,
          is_folded: p.is_folded ?? false,
          is_all_in: p.is_all_in ?? false,
          is_sitting_out: e.disconnectEngine.isSittingOut(e.tableId, p.user_id),
          is_mucked: state.stage === 'showdown' && !p.is_folded && e.isMuckedAtShowdown(p.user_id),
          is_disconnected: !e.disconnectEngine.isConnected(e.tableId, p.user_id),
          time_bank_remaining: e.timeBankEngine.getRemainingSeconds(e.tableId, p.user_id),
          time_bank_uses_remaining: e.timeBankEngine.getUsesRemaining(e.tableId, p.user_id),
          position: positionLabels.get(p.seat) ?? '',
          ...e.chipContinuity.seatFields(p.user_id, e.continuityStack(p.user_id, p.stack)),
        };
      });
    })(),
  };
}

/* ── THE FROZEN COPY: broadcastCurrentState's payload before 2026-09-27 ── */
function legacyLive(e: any): Record<string, any> {
  const state = e.handController.getState();
  const currentSeatPlayer = state.players.find((p: any) => p.seat === state.currentPlayerSeat);
  return {
    table_id: e.tableId,
    hand_number: e.handCount,
    pot: state.pot ?? 0,
    community_cards: state.communityCards ?? [],
    community_cards2: state.communityCards2 ?? [],
    community_cards3: state.communityCards3 ?? [],
    hand_variant: e.activeHandVariant(),
    ...e.bombPotSnapshotFields(),
    ...e.killPotSnapshotFields(),
    ...e.anteSnapshotFields(),
    current_bet: state.currentBet ?? 0,
    current_player: currentSeatPlayer?.user_id ?? null,
    dealer_seat: state.dealerSeat ?? e.currentHandDealerSeat,
    stage: state.stage ?? 'preflop',
    winner_ids: e.currentHandWinnerIds.length > 0 ? e.currentHandWinnerIds : [],
    winners:
      e.currentHandWinners.length > 0
        ? e.currentHandWinners.map((w: any) => ({
            user_id: w.userId,
            amount: w.amount,
            pot_index: w.potIndex ?? 0,
          }))
        : [],
    min_raise: state.minRaise ?? 0,
    last_raise: state.lastRaise ?? 0,
    ...e.bettingStructureFields(state),
    action_context: e.getActionContext(),
    turn_start_time_ms: e.playerTurnStartTime,
    turn_duration_ms: e.playerTurnDuration * 1000,
    server_time_ms: Date.now(),
    ...e.pineappleDiscardSnapshotFields(),
    turn_deadline_ms:
      e.playerTurnStartTime > 0 ? e.playerTurnStartTime + e.playerTurnDuration * 1000 : 0,
    time_bank_active: e.timeBankActivatedThisTurn,
    disconnect_states: e.disconnectEngine.getFsmStatesForTable(e.tableId),
    max_seats: Number(e.tableInfo?.max_players) || 0,
    is_anonymous: e.tableInfo?.is_anonymous === true,
    waiting_for_bb_user_ids: Array.from(e.waitingForBB),
    post_bb_deferred_user_ids: Array.from(e.postBBWhenClear),
    posting_bb_user_ids: Array.from(e.postingBBToEnter),
    pots: (state.pots ?? []).map((p: any) => ({
      amount: p.amount,
      eligible: p.eligiblePlayers ?? [],
    })),
    action_history: (state.actionHistory ?? []).map((a: any) => ({
      seat: a.seat,
      userId: a.userId ?? '',
      action: a.action,
      amount: a.amount,
      timestamp: a.timestamp ?? 0,
      stage: a.stage,
    })),
    players: (() => {
      const positionLabels = e.getPositionLabels(
        state.dealerSeat ?? e.currentHandDealerSeat,
        state.players ?? []
      );
      return (state.players ?? []).map((p: any) => {
        const muckedHere = e.isMuckedAtShowdown(p.user_id);
        const showCards =
          (state.stage === 'showdown' || e.runoutRevealActive) && !p.is_folded && !muckedHere;
        const picked = e.showHandCards?.get(p.user_id);
        const handIsOver = state.stage === 'showdown' || e.currentHandWinnerIds.length > 0;
        const partialReveal =
          !showCards && handIsOver && !!picked && picked.size > 0 && (p.cards?.length ?? 0) > 0;
        const cardsOut = showCards
          ? (p.cards ?? [])
          : partialReveal
            ? (p.cards ?? []).map((c: any, i: number) => (picked!.has(i) ? c : null))
            : [];
        return {
          seat: p.seat,
          user_id: p.user_id,
          ...e.seatIdentity(p),
          stack: p.stack,
          bet: p.bet ?? 0,
          totalInvested: p.totalInvested ?? 0,
          cards: cardsOut,
          is_folded: p.is_folded ?? false,
          is_all_in: p.is_all_in ?? false,
          is_sitting_out: e.disconnectEngine.isSittingOut(e.tableId, p.user_id),
          is_disconnected: !e.disconnectEngine.isConnected(e.tableId, p.user_id),
          time_bank_remaining: e.timeBankEngine.getRemainingSeconds(e.tableId, p.user_id),
          time_bank_uses_remaining: e.timeBankEngine.getUsesRemaining(e.tableId, p.user_id),
          position: positionLabels.get(p.seat) ?? '',
          ...e.chipContinuity.seatFields(p.user_id, e.continuityStack(p.user_id, p.stack)),
          is_waiting_for_bb: e.waitingForBB.has(p.user_id),
          is_mucked: state.stage === 'showdown' && !p.is_folded && muckedHere,
          hand_name: showCards
            ? (e.currentHandShowdownResults.find((r: any) => r.userId === p.user_id)?.handName ??
              '')
            : '',
        };
      });
    })(),
  };
}

/* ── THE FROZEN COPY: ServerTableEngineBase.getPositionLabels ── */
function legacyPositionLabels(dealerSeat: number, players: Array<{ seat: number }>) {
  const labels = new Map<number, string>();
  const seats = players.map((p) => p.seat).sort((a, b) => a - b);
  const n = seats.length;
  if (n === 0) return labels;
  let dealerIdx = seats.indexOf(dealerSeat);
  if (dealerIdx === -1) dealerIdx = 0;
  if (n === 2) {
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'BB');
  } else if (n === 3) {
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'SB');
    labels.set(seats[(dealerIdx + 2) % n], 'BB');
  } else {
    labels.set(seats[dealerIdx], 'BTN');
    labels.set(seats[(dealerIdx + 1) % n], 'SB');
    labels.set(seats[(dealerIdx + 2) % n], 'BB');
    const positionNames: Record<number, string[]> = {
      4: ['UTG'],
      5: ['UTG', 'CO'],
      6: ['UTG', 'MP', 'CO'],
      7: ['UTG', 'UTG+1', 'MP', 'CO'],
      8: ['UTG', 'UTG+1', 'MP', 'MP+1', 'CO'],
      9: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
    };
    const names = positionNames[n] || positionNames[9] || [];
    for (let i = 0; i < n - 3 && i < names.length; i++)
      labels.set(seats[(dealerIdx + 3 + i) % n], names[i]);
  }
  return labels;
}

function seat(seatNo: number, stack: number): SeatPlayer {
  return {
    seat: seatNo,
    user_id: `u${seatNo}`,
    username: `P${seatNo}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
}

function engineFor(rnd: () => number) {
  const n = 2 + Math.floor(rnd() * 8);
  const seats = Array.from({ length: n }, (_, i) => seat(i + 1, 20 + Math.floor(rnd() * 400)));
  const dealer = 1 + Math.floor(rnd() * n);
  const e = new ServerTableEngine('projection-equivalence') as any;
  const h = new HandController(
    {
      tableId: 'projection-equivalence',
      handNumber: 7,
      gameVariant: rnd() < 0.3 ? 'plo4' : 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      ante: rnd() < 0.3 ? 1 : undefined,
      rakeConfig: { percent: 5, cap: 3, noFlopNoDrop: true },
    },
    seats,
    dealer
  );
  e.handController = h;
  e.tableInfo = {
    game_variant: 'nlh',
    small_blind: 1,
    big_blind: 2,
    ante: 1,
    ante_enabled: rnd() < 0.5,
    max_players: 9,
    is_anonymous: rnd() < 0.3,
    observer_show_cards: true,
  };
  e.handCount = 7;
  e.currentHandDealerSeat = dealer;
  e.hub = { publish: vi.fn(), emitEvent: vi.fn(), sendToUser: vi.fn() };
  e.showHandCards = new Map();
  if (rnd() < 0.3) e.waitingForBB.add(`u${1 + Math.floor(rnd() * n)}`);
  if (rnd() < 0.2) e.postingBBToEnter.add(`u${1 + Math.floor(rnd() * n)}`);
  if (rnd() < 0.2) e.postBBWhenClear.add('u9');
  e.playerTurnStartTime = rnd() < 0.5 ? 1_700_000_000_000 : 0;
  e.playerTurnDuration = 15;
  e.timeBankActivatedThisTurn = rnd() < 0.2;
  for (const s of seats) {
    if (rnd() < 0.5) e.disconnectEngine.registerPlayer(e.tableId, s.user_id);
    if (rnd() < 0.5) e.timeBankEngine.initializePlayer(e.tableId, s.user_id);
  }
  return { e, h, n };
}

async function livePayload(e: any) {
  e.hub.publish.mockClear();
  await e.broadcastCurrentState();
  return e.hub.publish.mock.calls.at(-1)[1];
}

/** Drive the hand forward by up to `steps` legal actions. */
function advance(h: any, rnd: () => number, steps: number) {
  for (let i = 0; i < steps; i++) {
    const st = h.state;
    if (st.stage === 'showdown' || st.currentPlayerSeat < 1) return;
    const p = st.players.find((x: any) => x.seat === st.currentPlayerSeat);
    if (!p) return;
    const acts: string[] = h.getAvailableActions(p);
    const pick = acts[Math.floor(rnd() * acts.length)];
    const ok =
      pick === 'bet' || pick === 'raise'
        ? h.performAction(p.seat, 'all_in')
        : h.performAction(p.seat, pick);
    if (!ok && !h.performAction(p.seat, acts.includes('check') ? 'check' : 'fold')) return;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the shared projection is the engine projection it replaced', () => {
  it('position labels are identical for every table size, button and seat gap', () => {
    const rnd = mulberry32(4242);
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(rnd() * 9);
      const seats = [...new Set(Array.from({ length: n }, () => 1 + Math.floor(rnd() * 9)))].map(
        (s) => ({ seat: s }) as SeatPlayer
      );
      const dealer = 1 + Math.floor(rnd() * 10);
      expect([...positionLabelsFor(dealer, seats)]).toEqual([
        ...legacyPositionLabels(dealer, seats),
      ]);
    }
  });

  it('the live payload and every resync payload match the frozen copy through whole hands', async () => {
    const rnd = mulberry32(20260927);
    let compared = 0;
    for (let hand = 0; hand < 60; hand++) {
      const { e, h, n } = engineFor(rnd);
      h.start();
      for (let phase = 0; phase < 6; phase++) {
        advance(h, rnd, 1 + Math.floor(rnd() * 4));
        e.runoutRevealActive = rnd() < 0.2;
        if (rnd() < 0.3) {
          e.currentHandShowdownResults = Array.from({ length: n }, (_, i) => ({
            userId: `u${i + 1}`,
            handRanking: i,
            handName: `Hand ${i}`,
            kickers: [],
            holeCards: [],
            seat: i + 1,
            revealOrder: i,
            mucked: rnd() < 0.4,
          }));
        }
        if (rnd() < 0.3) e.showHandCards.set(`u${1 + Math.floor(rnd() * n)}`, new Set([0]));
        if (rnd() < 0.2) {
          e.currentHandWinnerIds = ['u1'];
          e.currentHandWinners = [
            { userId: 'u1', amount: 12.5, potIndex: rnd() < 0.5 ? 1 : undefined },
          ];
        }
        if (rnd() < 0.15) (h as any).state.stage = 'showdown';
        const live = await livePayload(e);
        expect(JSON.stringify(live)).toBe(JSON.stringify(legacyLive(e)));
        for (let viewer = 1; viewer <= n + 1; viewer++) {
          const uid = `u${viewer}`;
          expect(JSON.stringify(e.getTableState(uid))).toBe(JSON.stringify(legacyResync(e, uid)));
        }
        compared++;
      }
    }
    expect(compared).toBe(360);
  });

  it('no payload is produced without a hand, exactly as before', () => {
    const e = new ServerTableEngine('projection-equivalence-empty') as any;
    expect(e.getTableState('u1')).toBeNull();
    expect(legacyResync(e, 'u1')).toBeNull();
  });
});
