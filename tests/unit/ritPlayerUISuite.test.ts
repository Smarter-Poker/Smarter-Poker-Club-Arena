import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  verifyRitPlayerEvidence,
  verifyRitIdentity,
  qualifyRitPlayerUI,
  isRitActorTurn,
} from '../../operations/release/native/rit-player-ui-suite.mjs';

const sample = (): any => ({
  tableId: 'table',
  actorIds: ['a', 'b'],
  offer: {
    type: 'rit_offer',
    table_id: 'table',
    hand_number: 7,
    offer_id: 'offer',
    maxRuns: 3,
    chooserPlayerId: 'a',
    allPlayerIds: ['a', 'b'],
  },
  decision: {
    type: 'rit_chooser_decided',
    table_id: 'table',
    hand_number: 7,
    offer_id: 'offer',
    actor: 'a',
    requested_runs: 3,
    chosenRuns: 3,
  },
  accepted: {
    type: 'rit_all_accepted',
    table_id: 'table',
    hand_number: 7,
    offer_id: 'offer',
    runs: 3,
    agreed_runs: 3,
    accepted_ids: ['a', 'b'],
  },
  result: {
    type: 'rit_result',
    table_id: 'table',
    hand_number: 7,
    offer_id: 'offer',
    runs: 3,
    agreed_runs: 3,
    runs_dealt: 3,
    chooser_id: 'a',
    outcome_reason: 'all_accepted',
    boards: [Array(5).fill('card'), Array(5).fill('card'), Array(5).fill('card')],
    distribution: { a: 400 },
    receivedAt: 50,
  },
  witness: {
    hands: [
      {
        hand: 7,
        runs: 3,
        lanes: [100, 4300, 8500].map((winnerAt) => ({
          pendingAt: winnerAt - 50,
          winnerAt,
        })),
        resultEndedAt: 12700,
      },
    ],
    flights: [{ hand: 7, landedAt: 13000, recipient: 'a', distance: 1 }],
    confirmations: {},
    violations: [],
    visibility: { visibleSamples: 10, hiddenSamples: 0 },
  },
});

test('RIT input stays bound to the captured positive live turn', () => {
  const captured: any = {
    hand_number: 7,
    turn_start_time_ms: 100,
    current_player: 'a',
    players: [{ user_id: 'a', stack: 200, is_folded: false, is_all_in: false }],
  };
  assert.equal(isRitActorTurn(captured, captured, 'a'), true);
  for (const mutate of [
    (s) => {
      s.hand_number++;
    },
    (s) => {
      s.turn_start_time_ms++;
    },
    (s) => {
      s.current_player = 'b';
    },
    (s) => {
      s.players[0].stack = 0;
    },
    (s) => {
      s.players[0].is_folded = true;
    },
    (s) => {
      s.players[0].is_all_in = true;
    },
  ]) {
    const live = structuredClone(captured);
    mutate(live);
    assert.equal(isRitActorTurn(live, captured, 'a'), false);
  }
});

test('RIT proof retains existing three-board timing and actual consent identity', () => {
  const result = verifyRitPlayerEvidence(sample());
  assert.deepEqual(result.timing.resultGapsMs, [4200, 4200]);
  assert.equal(result.timing.lastResultMs, 4200);
  assert.equal(result.capability.runs_dealt, 3);
  assert.equal('boards' in result, false);
});

test('RIT proof refuses replay, foreign consent, two boards and unavailable capability', () => {
  for (const mutate of [
    (s) => {
      s.result.replayed = true;
    },
    (s) => {
      s.decision.actor = 'b';
    },
    (s) => {
      s.decision.requested_runs = 2;
    },
    (s) => {
      s.accepted.accepted_ids = ['a', 'foreign'];
    },
    (s) => {
      s.result.hand_number++;
    },
    (s) => {
      s.result.offer_id = 'old';
    },
    (s) => {
      s.result.runs_dealt = 2;
    },
    (s) => {
      s.offer.maxRuns = 2;
    },
    (s) => {
      s.result.outcome_reason = 'mandatory';
    },
  ]) {
    const s = sample();
    mutate(s);
    assert.throws(() => verifyRitPlayerEvidence(s));
  }
});

test('RIT proof refuses early/late winner reads, short final hold and absent chip landing', () => {
  for (const mutate of [
    (s) => {
      s.witness.hands[0].lanes[1].winnerAt = 4099;
    },
    (s) => {
      s.witness.hands[0].lanes[1].winnerAt = 4801;
    },
    (s) => {
      s.witness.hands[0].resultEndedAt = 12499;
    },
    (s) => {
      s.witness.flights = [];
    },
    (s) => {
      s.witness.visibility.hiddenSamples = 1;
    },
    (s) => {
      s.witness.confirmations['7'] = [{ shownAt: 100, hiddenAt: 1600 }];
    },
  ]) {
    const s = sample();
    mutate(s);
    assert.throws(() => verifyRitPlayerEvidence(s));
  }
});

test('RIT identity requires both origins, immutable engine, same instance and monotonic uptime', () => {
  const identity: any = {
    clients: ['web', 'web'],
    engine: { releaseSha: 'engine', instanceId: 'instance', uptime: 10 },
  };
  verifyRitIdentity(identity, structuredClone(identity));
  for (const mutate of [
    (s) => {
      s.clients[1] = 'other';
    },
    (s) => {
      s.engine.releaseSha = 'other';
    },
    (s) => {
      s.engine.instanceId = 'other';
    },
    (s) => {
      s.engine.uptime = 9;
    },
    (s) => {
      s.engine.uptime = NaN;
    },
  ]) {
    const after = structuredClone(identity);
    mutate(after);
    assert.throws(() => verifyRitIdentity(identity, after));
  }
});

test('RIT refuses historical/incomplete schema before creating any browser context', async () => {
  let opened = false;
  await assert.rejects(
    qualifyRitPlayerUI({
      fixture: {
        source_contract: {
          version: 1,
          source_sha: 'a'.repeat(40),
          current_database_contract_ready: false,
          exclusions: ['application-acl'],
        },
      },
      browser: {
        newContext() {
          opened = true;
          throw new Error('not allowed');
        },
      },
    })
  );
  assert.equal(opened, false);
});
