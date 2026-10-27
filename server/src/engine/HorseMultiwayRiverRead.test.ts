import { horseRetainedPlanContext } from '../services/horseDecisionJournal/effects.js';
import { Deck } from './PokerEngine.js';
import { freshExploitCounters } from './HorseOpponentExploit.js';
import { HorseObserverReads } from './horseDecision/observerReads.js';
import {
  attachRiverNodeSidecar,
  riverNodeBindings,
  HORSE_RIVER_NODE_DEFINITION_MD5,
} from './horseDecision/riverNodeSidecar.js';
import {
  makeOwnPublicHistoryPacket,
  type HorseOwnPublicHistoryWindow,
} from './horseDecision/ownPublicHistory.js';
import { workerHarness, requestAt } from '../testing/horseRegression/plan/fixture.js';
import { buildHorseDecisionKey } from './horseDecision/protocol.js';
import { captureHorseHandJournalContext } from './HorseDecisionHandBinding.js';
import { afterEach, expect, it } from 'vitest';
import { HandController } from './HandController.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import { encodeHorseDecisionReads, decodeHorseDecisionReads } from './HorseDecisionReadFrame.js';
import {
  multiwayRiverIncrements,
  multiwayRiverPressure,
  multiwayRiverLine,
  multiwayRiverContext,
  mergeMultiwayRiverStates,
  riverPublicNode,
} from './HorseMultiwayRiverRead.js';
import { completedHandActionsForMind } from './horseDecision/completedHandActions.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { HorseLogic } from './HorseLogic.js';
import type { ActionRecord, HandConfig, SeatPlayer } from '../types.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function spot(
  count = 3,
  ante = 0,
  bigBlindAnte = false,
  answer: 'fold' | 'call' | 'all_in' = 'fold',
  variant = 'nlh',
  blockerDeck = false,
  checkBack = false
) {
  const players = Array.from(
    { length: count },
    (_, i) =>
      ({
        seat: i + 1,
        user_id: id(i + 1),
        username: `p${i + 1}`,
        stack: 400,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const config = {
    tableId: id(100),
    handNumber: 1000001,
    gameVariant: variant,
    smallBlind: 1,
    bigBlind: 2,
    ante,
    bigBlindAnte,
    isTournament: false,
    rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
  } as HandConfig;
  let c: HandController;
  const shuffle = Deck.prototype.shuffle;
  if (blockerDeck)
    Deck.prototype.shuffle = function () {
      const pack = this as unknown as { cards: import('../types.js').Card[] };
      const card = (rank: string, suit: string) => ({ rank, suit }) as import('../types.js').Card;
      const hole = [
        card('A', 'diamonds'),
        card('4', 'clubs'),
        ...(variant === 'nlh' ? [] : [card('5', 'hearts'), card('6', 'spades')]),
        ...(variant === 'plo5' || variant === 'plo6' ? [card('3', 'clubs')] : []),
        ...(variant === 'plo6' ? [card('8', 'spades')] : []),
      ];
      const board = [
        card('K', 'diamonds'),
        card('Q', 'diamonds'),
        card('7', 'diamonds'),
        card('2', 'clubs'),
        card('9', 'hearts'),
      ];
      const key = (c: import('../types.js').Card) => c.rank + ':' + c.suit,
        known = new Set([...hole, ...board].map(key));
      const spare = pack.cards.filter((c) => !known.has(key(c))),
        used = hole.length * (count - 1);
      pack.cards = [
        ...spare.slice(0, hole.length),
        ...hole,
        ...spare.slice(hole.length, used),
        ...board,
        ...spare.slice(used),
      ];
    };
  try {
    c = new HandController(config, players, 1);
    c.start();
  } finally {
    Deck.prototype.shuffle = shuffle;
  }
  // Original late-position participants fold; SB/BB call and button checks.
  while (c.getState().stage === 'preflop') {
    const s = c.getState(),
      seat = s.currentPlayerSeat;
    const menu = c.getAuthoritativeActionState(s.players.find((p) => p.seat === seat)!.user_id)!;
    expect(c.performAction(seat, seat > 2 ? 'fold' : menu.toCall > 0 ? 'call' : 'check')).toBe(
      true
    );
  }
  for (let street = 0; street < 2; street++) {
    expect(c.performAction(2, 'check')).toBe(true);
    expect(c.performAction(1, 'check')).toBe(true);
  }
  expect(c.performAction(2, 'check')).toBe(true);
  if (checkBack) {
    const captured = controllerDecisionState(c, variant as never, 'cash', config)!;
    expect(c.performAction(1, 'check')).toBe(true);
    return { actions: structuredClone(c.getState().actionHistory), captured };
  }
  expect(c.performAction(1, 'bet', 2)).toBe(true);
  const captured = controllerDecisionState(c, variant as never, 'cash', config)!;
  captured.state.smallBlind = config.smallBlind;
  captured.state.bigBlindAnte = bigBlindAnte;
  expect(c.performAction(2, 'raise', 6)).toBe(true);
  expect(c.performAction(1, answer)).toBe(true);
  return { actions: structuredClone(c.getState().actionHistory), captured };
}
afterEach(() => HorseMind.reset());
it.each([3, 6])(
  'counts only the completed canonical %s-to-2 response and retains exact context',
  (n) => {
    const { actions } = spot(n);
    const result = multiwayRiverIncrements(actions, n);
    expect(result).toMatchObject({ id: id(1), opportunities: 1, folds: 1 });
    const prefix = actions.slice(0, -1);
    expect(multiwayRiverIncrements(prefix, n)).toBeNull();
    expect(multiwayRiverIncrements(actions, 2)).toBeNull();
    expect(
      completedHandActionsForMind(actions, readScopeOf('nlh', n))!.actions.filter(
        (a) => a.publicNode
      ).length
    ).toBe(4);
  }
);
it.each([
  'missing',
  'third_allin',
  'third_unfolded',
  'off_grid',
  'sidepot',
  'actor',
  'board',
  'straddle',
] as const)('refuses %s public proof', (fault) => {
  const { actions } = spot();
  const river = actions.filter((a) => a.stage === 'river');
  const n = river[1].publicNode as any;
  if (fault === 'missing') delete river[2].publicNode;
  if (fault === 'third_allin') n.seats.find((s: number[]) => s[0] === 3)[6] = 3;
  if (fault === 'third_unfolded') n.seats.find((s: number[]) => s[0] === 3)[6] = 0;
  if (fault === 'off_grid') n.seats[0][1] += 0.001;
  if (fault === 'sidepot') n.seats[0][3] += 10;
  if (fault === 'actor') n.actorSeat = 3;
  if (fault === 'board') n.boards = ['AhAh2c3d4s'];
  if (fault === 'straddle')
    actions.unshift({ ...actions[0], action: 'straddle' } as unknown as ActionRecord);
  expect(multiwayRiverIncrements(actions, 3)).toBeNull();
});
it('dedupes the public line, preserves v8 absence and replays context-separated v9', () => {
  const { actions } = spot(),
    view = HorseMind.createSandbox(),
    players = [1, 2, 3].map((n) => ({ user_id: id(n) }));
  HorseMind.runInSandbox(view, () => {
    HorseMind.setDecisionScope(readScopeOf('nlh', 3), 'nlh', 'cash');
    for (let h = 1; h <= 10; h++) {
      const identity = { version: 1 as const, tableId: id(100), handNumber: 1000000 + h };
      HorseMind.observe(actions, [], identity, 3);
      HorseMind.observe(actions, [], identity, 3);
    }
  });
  const context = multiwayRiverIncrements(actions, 3)!.context;
  for (const k of ['seenActions', 'handFlags', 'dirty', 'dirtyPairs', 'dirtyScoped'] as const)
    view[k].clear();
  const frame = encodeHorseDecisionReads(view, players, null);
  expect(frame.version).toBe('horse-decision-reads-v9');
  const replay = decodeHorseDecisionReads(frame, players, null);
  HorseMind.runInSandbox(replay, () => {
    HorseMind.setDecisionScope(readScopeOf('nlh', 3), 'nlh', 'cash');
    expect(HorseMind.multiwayRiverRead(id(1), context)).toMatchObject({
      opportunities: 10,
      folds: 10,
    });
    const other = JSON.parse(context);
    other[5] = 1000;
    expect(HorseMind.multiwayRiverRead(id(1), JSON.stringify(other))).toBeNull();
    expect(HorseMind.riverTripleCheckRaiseRead(id(1))).toBeNull();
  });
  expect(encodeHorseDecisionReads(replay, players, null)).toEqual(frame);
  for (const map of [view.stats, view.scoped]) for (const row of map.values()) delete row.riverHu;
  const older = encodeHorseDecisionReads(view, players, null);
  expect(older.version).toBe('horse-decision-reads-v7');
  expect(
    encodeHorseDecisionReads(decodeHorseDecisionReads(older, players, null), players, null)
  ).toEqual(older);
});
it('bounds contexts without evicting known evidence or treating overflow as a fold', () => {
  const { actions } = spot();
  const key = multiwayRiverIncrements(actions, 3)!.context;
  let state;
  for (let i = 0; i < 65; i++) {
    const k = JSON.parse(key);
    k[5] = i + 200;
    state = mergeMultiwayRiverStates(state, {
      entries: [[JSON.stringify(k), 1, 0, 0, 0]],
      overflow: false,
    });
  }
  expect(state?.entries).toHaveLength(64);
  expect(state?.overflow).toBe(true);
  expect(state?.entries.every((r) => r[2] === 0)).toBe(true);
});
it('keeps the runtime candidate off with the original flag alone', () => {
  const { captured } = spot();
  const fold = { action: 'fold' as const, thinkTime: 0 };
  expect(
    HorseLogic.__testables.riverBluffCheckRaise(fold, captured.hero, captured.state, {
      riverBluffCheckRaise: true,
    })
  ).toBe(fold);
  expect(riverPublicNode({ secret: 'private' })).toBeNull();
});

function enrichedHistory() {
  const { actions, captured } = spot();
  const t = Date.now() - 100000;
  const window: HorseOwnPublicHistoryWindow = {
    version: 1,
    source: 'original_dealt_public_v1',
    context: { version: 1, observerId: id(2), variant: 'nlh', format: 'cash', dealtCount: 3 },
    capped: false,
    hands: Array.from({ length: 10 }, (_, i) => ({
      handId: id(1000 + i),
      tableId: id(100),
      handNumber: 1000000 + i,
      observerId: id(2),
      observerSeat: 2,
      position: 'SB',
      playersDealt: 3,
      variant: 'nlh',
      format: 'cash',
      playedAtMs: t + i * 100 + 50,
      bigBlind: 2,
      results: null,
      actions: actions.map(({ publicNode, ...a }, j) => ({ ...a, timestamp: t + i * 100 + j })),
    })),
  };
  const bindings = riverNodeBindings(window);
  const data = {
    version: 1,
    status: 'captured',
    definitionMd5: HORSE_RIVER_NODE_DEFINITION_MD5,
    hands: bindings.map((b) => ({
      handId: b.handId,
      binding: b.binding,
      status: 'captured',
      nodes: actions.flatMap((a, ordinal) =>
        a.stage === 'river' ? [{ ordinal, node: riverPublicNode(a.publicNode, true) }] : []
      ),
    })),
  };
  return { window, data, captured, at: t + 2000 };
}
it.each(['binding', 'source', 'foreign', 'extra', 'duplicate', 'oversize'] as const)(
  'retains original history when sidecar %s is untrusted',
  (fault) => {
    const { window, data, at } = enrichedHistory();
    const bad: any = structuredClone(data);
    if (fault === 'binding') bad.hands[0].binding = '0'.repeat(64);
    if (fault === 'source') bad.definitionMd5 = '0'.repeat(32);
    if (fault === 'foreign') bad.hands[0].handId = id(9999);
    if (fault === 'extra') bad.secret = 'unknown';
    if (fault === 'duplicate') bad.hands[1] = bad.hands[0];
    if (fault === 'oversize') bad.hands[0].nodes.push(bad.hands[0].nodes[0]);
    const result = attachRiverNodeSidecar(window, bad, at);
    expect(result.status).toBe('unavailable');
    expect(result.window).toBe(window);
    expect(window.hands.every((h) => h.actions.every((a) => a.publicNode === undefined))).toBe(
      true
    );
  }
);
it('transports canonical reader sidecars into the actual worker independent read view and v9 journal', async () => {
  const { window, data, captured, at } = enrichedHistory();
  const attached = attachRiverNodeSidecar(window, data, at);
  expect(attached.status).toBe('captured');
  const packet = makeOwnPublicHistoryPacket(attached.window, at)!;
  expect(packet).not.toBeNull();
  const request = requestAt(900, id(100), 1002000);
  request.player = captured.hero;
  request.gameState = { ...captured.state, commitmentCapRemaining: null };
  request.fence = request.fence.replace(':1:', ':2:');
  request.decisionTimeMs = Date.now() + 100;
  request.handJournalContext = captureHorseHandJournalContext(request.gameState.actionHistory!);
  request.ownPublicHistory = packet;
  request.ownPublicHistoryState = 'available';
  request.decisionKey = buildHorseDecisionKey(request);
  const context = multiwayRiverContext(data.hands[0].nodes[0].node!, 3);
  let consumed: ReturnType<typeof HorseMind.multiwayRiverRead> = null;
  const h = workerHarness({
    decide: (...args) => {
      const d = HorseLogic.decide(...args);
      consumed = HorseMind.multiwayRiverRead(id(1), context);
      return d;
    },
  });
  try {
    await h.runtime.start();
    const result = await h.fast(request);
    expect(result.decision.action).toBeTruthy();
    expect(consumed).toMatchObject({ opportunities: 10, folds: 10 });
    const capture = h.captures.at(-1)!;
    expect(horseRetainedPlanContext(capture, request).kind).toBe('current');
    expect(capture.observerReads).toMatchObject({ history: 'own_public_window', historyHands: 10 });
    expect(JSON.stringify(capture)).toContain('horse-decision-reads-v9');
  } finally {
    await h.close();
  }
});

it.each([false, true])(
  'retains real controller ante context and conserved money (big blind ante=%s)',
  (bigBlindAnte) => {
    const { actions } = spot(6, 2, bigBlindAnte);
    const inc = multiwayRiverIncrements(actions, 6);
    expect(inc).not.toBeNull();
    const key = JSON.parse(inc!.context);
    expect(key.slice(6, 9)).toEqual([200, bigBlindAnte ? 'big_blind' : 'per_player', 6]);
  }
);
it.each(['call', 'all_in'] as const)(
  'counts an actual %s response as defense, never a fold',
  (answer) => {
    const { actions } = spot(3, 0, false, answer);
    expect(multiwayRiverIncrements(actions, 3)).toMatchObject({ opportunities: 1, folds: 0 });
    const river = actions.filter((a) => a.stage === 'river');
    river[3].amount += 0.01;
    expect(multiwayRiverIncrements(actions, 3)).toBeNull();
  }
);

it('rebuilds once after restart and does not pool another observer or recount an accepted historical completion', () => {
  const { window, data, captured, at } = enrichedHistory();
  const packet = makeOwnPublicHistoryPacket(attachRiverNodeSidecar(window, data, at).window, at)!;
  const key = multiwayRiverContext(data.hands[0].nodes[0].node!, 3);
  for (let restart = 0; restart < 2; restart++) {
    const bank = new HorseObserverReads(20, 20, () => at + 10);
    const request = requestAt(901, id(100), 1002000);
    request.player = captured.hero;
    request.gameState = captured.state;
    request.fence = request.fence.replace(':1:', ':2:');
    request.decisionTimeMs = at + 20;
    request.ownPublicHistory = packet;
    request.ownPublicHistoryState = 'available';
    bank.run(request, () =>
      expect(HorseMind.multiwayRiverRead(id(1), key)).toMatchObject({
        opportunities: 10,
        folds: 10,
      })
    );
    const h = packet.hands[0],
      handKey = `${h.tableId}:${h.handNumber}`;
    const done = {
      type: 'OBSERVE_COMPLETED_HAND' as const,
      requestId: 1,
      generation: h.handNumber,
      fence: `${handKey}:${id(999)}:observe`,
      handKey,
      committedHandId: h.handId,
      bigBlind: 2,
      actions: h.actions,
      observerParticipants: {
        version: 1 as const,
        handKey,
        status: 'bound' as const,
        contexts: [packet.context],
      },
    };
    expect(
      bank.complete(done, () => {
        throw Error('historical completion counted twice');
      })
    ).toBe(0);
    bank.run({ ...request, requestId: 902 }, () =>
      expect(HorseMind.multiwayRiverRead(id(1), key)).toMatchObject({
        opportunities: 10,
        folds: 10,
      })
    );
    bank.runContext({ ...packet.context, observerId: id(9) }, () =>
      expect(HorseMind.multiwayRiverRead(id(1), key)).toBeNull()
    );
  }
});

it.each(['nlh', 'plo4', 'plo5', 'plo6'])(
  '%s uses only the new exact-context response read for the physically legal candidate',
  (variant) => {
    const { actions, captured } = spot(3, 2, true, 'fold', variant, true),
      view = HorseMind.createSandbox();
    HorseMind.runInSandbox(view, () => {
      const scope = readScopeOf(variant, 3);
      HorseMind.setDecisionScope(scope, variant, 'cash');
      for (let h = 0; h < 100; h++)
        HorseMind.observe(
          actions,
          [],
          { version: 1, tableId: id(100), handNumber: 1000000 + h },
          3
        );
      view.exploit.set(scope + '|' + id(1), {
        ...freshExploitCounters(),
        hands: 1000,
        vpip: 999,
        betCheckedToOpp: 1000,
        betCheckedTo: 200,
      });
      const fold = { action: 'fold' as const, thinkTime: 0 };
      const enabled = { riverBluffCheckRaise: true, multiwayRiverBluffCheckRaise: true };
      const selected = HorseLogic.__testables.riverBluffCheckRaise(
        fold,
        captured.hero,
        captured.state,
        enabled
      );
      expect(selected).toMatchObject({ action: 'raise', amount: 6 });
      expect(HorseMind.riverTripleCheckRaiseRead(id(1))).toBeNull();
      expect(
        HorseLogic.__testables.riverBluffCheckRaise(
          fold,
          captured.hero,
          { ...captured.state, smallBlind: undefined },
          enabled
        )
      ).toBe(fold);
    });
  }
);

it('retains check-backs in the exact-context pressure denominator without fabricating a raise response', () => {
  const bet = spot(3, 2, true),
    check = spot(3, 2, true, 'fold', 'nlh', false, true);
  expect(multiwayRiverPressure(check.actions, 3)).toMatchObject({ opportunities: 1, bets: 0 });
  expect(multiwayRiverIncrements(check.actions, 3)).toBeNull();
  const view = HorseMind.createSandbox();
  HorseMind.runInSandbox(view, () => {
    HorseMind.setDecisionScope(readScopeOf('nlh', 3), 'nlh', 'cash');
    for (let i = 0; i < 20; i++)
      HorseMind.observe(
        i < 10 ? bet.actions : check.actions,
        [],
        { version: 1, tableId: id(100), handNumber: 1000000 + i },
        3
      );
    const context = multiwayRiverPressure(check.actions, 3)!.context;
    expect(HorseMind.multiwayRiverPressureRead(id(1), context)).toMatchObject({
      opportunities: 20,
      bets: 10,
    });
    expect(HorseMind.multiwayRiverRead(id(1), context)).toMatchObject({
      opportunities: 10,
      folds: 10,
    });
    const other = JSON.parse(context);
    other[6] = 0;
    expect(HorseMind.multiwayRiverPressureRead(id(1), JSON.stringify(other))).toBeNull();
  });
  const { window, at } = enrichedHistory();
  const h = window.hands[0];
  window.hands = [h];
  h.actions = check.actions.map(({ publicNode, ...a }, i) => ({
    ...a,
    timestamp: h.playedAtMs - 20 + i,
  }));
  const binding = riverNodeBindings(window)[0];
  const sidecar = {
    version: 1,
    status: 'captured',
    definitionMd5: HORSE_RIVER_NODE_DEFINITION_MD5,
    hands: [
      {
        handId: h.handId,
        binding: binding.binding,
        status: 'captured',
        nodes: check.actions.flatMap((a, ordinal) =>
          a.stage === 'river' ? [{ ordinal, node: riverPublicNode(a.publicNode, true) }] : []
        ),
      },
    ],
  };
  const attached = attachRiverNodeSidecar(window, sidecar, at);
  expect(attached.status).toBe('captured');
  expect(attached.window.hands[0].actions.filter((a) => a.publicNode)).toHaveLength(2);
});

it('refuses a real controller river with a third all-in claimant', () => {
  const players = [1, 2, 3].map(
    (n) =>
      ({
        seat: n,
        user_id: id(n),
        username: `p${n}`,
        stack: n === 3 ? 2 : 400,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }) as SeatPlayer
  );
  const c = new HandController(
    {
      tableId: id(100),
      handNumber: 1000100,
      gameVariant: 'nlh',
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      isTournament: false,
      rakeConfig: { percent: 5, cap: 6, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  c.start();
  while (c.getState().stage === 'preflop') {
    const state = c.getState(),
      seat = state.currentPlayerSeat;
    const menu = c.getAuthoritativeActionState(
      state.players.find((p) => p.seat === seat)!.user_id
    )!;
    expect(c.performAction(seat, menu.toCall ? 'call' : 'check')).toBe(true);
  }
  for (let round = 0; round < 2; round++) {
    expect(c.performAction(2, 'check')).toBe(true);
    expect(c.performAction(1, 'check')).toBe(true);
  }
  expect(c.getState().players.find((p) => p.seat === 3)?.is_all_in).toBe(true);
  expect(c.computeLivePots().some((p) => p.eligiblePlayers.length === 3)).toBe(true);
  expect(c.performAction(2, 'check')).toBe(true);
  expect(c.performAction(1, 'bet', 2)).toBe(true);
  expect(multiwayRiverPressure(c.getState().actionHistory, 3)).toBeNull();
  expect(c.performAction(2, 'raise', 6)).toBe(true);
  expect(c.performAction(1, 'fold')).toBe(true);
  expect(multiwayRiverIncrements(c.getState().actionHistory, 3)).toBeNull();
});
