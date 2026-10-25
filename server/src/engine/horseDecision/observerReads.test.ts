import { horseObserverReadsWereIndependent } from '../HorseObserverReadEvidence.js';
import { afterEach, describe, expect, it } from 'vitest';
import { HorseMind } from '../HorseMind.js';
import { observeHandResults, winnerReadout } from '../HorseWinnerRead.js';
import { captureHorseHandJournalContext } from '../HorseDecisionHandBinding.js';
import { HorseObserverReads } from './observerReads.js';
import {
  HorseObserverParticipantRegistry,
  observerParticipantsBind,
} from './observerParticipants.js';
import { horseObserverReadContextFromRequest } from '../HorseObserverReadContext.js';
import type { FastHorseDecisionRequest, ObserveCompletedHandRequest } from './protocol.js';
const table = '10000000-0000-4000-8000-000000000001';
const actor = '20000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const opponent = '30000000-0000-4000-8000-000000000001';
const committed = '40000000-0000-4000-8000-000000000001';
const lease = '50000000-0000-4000-8000-000000000001';
function request(
  id = actor,
  format = 'cash',
  variant = 'nlh',
  hand = 1000001
): FastHorseDecisionRequest {
  return {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:${hand}:1:${lease}:7`,
    decisionKey: '',
    decisionTimeMs: 1000,
    handJournalContext: captureHorseHandJournalContext([]),
    player: { user_id: id, seat: 1 },
    gameState: {
      gameVariant: variant,
      format,
      gameMode: format === 'cash' ? 'cash' : 'tournament',
      ...(format === 'cash' ? {} : { tournament: { contextStatus: 'complete' } }),
      dealtSeatIds: [1, 2],
      players: [
        { user_id: id, seat: 1 },
        { user_id: opponent, seat: 2 },
      ],
    },
  } as never;
}
function completion(hand = 1000001): ObserveCompletedHandRequest {
  return {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 2,
    generation: hand,
    fence: `${table}:${hand}:${lease}:observe`,
    handKey: `${table}:${hand}`,
    committedHandId: committed,
    actions: [],
    bigBlind: 2,
    results: [{ user_id: opponent, net: 20 }],
  };
}
function learn() {
  HorseMind.observe(
    [
      { userId: opponent, seat: 2, action: 'raise', amount: 8, stage: 'preflop', timestamp: 1 },
    ] as never,
    []
  );
}
afterEach(() => HorseMind.reset());
describe('each horse learns only its own public observations', () => {
  it('retains its own reads and isolates observer, variant and tournament format', () => {
    const bank = new HorseObserverReads();
    bank.run(request(), learn);
    bank.run(request(), () => expect(HorseMind.getStats(opponent)).toBeDefined());
    for (const r of [
      request(other),
      request(actor, 'mtt'),
      request(actor, 'spin'),
      request(actor, 'sng'),
      request(actor, 'hu_sng'),
      request(actor, 'cash', 'plo5'),
      request(actor, 'cash', 'pineapple'),
    ])
      bank.run(r, () => expect(HorseMind.getStats(opponent)).toBeUndefined());
    expect(HorseMind.getStats(opponent)).toBeUndefined();
  });
  it('never falls through to the global mind or global winner history', () => {
    learn();
    observeHandResults('global', [{ user_id: opponent, net: 20 }], 2);
    const bank = new HorseObserverReads();
    bank.run(request(), () => {
      expect(HorseMind.getStats(opponent)).toBeUndefined();
      expect(winnerReadout(opponent)).toBeNull();
    });
    expect(HorseMind.getStats(opponent)).toBeDefined();
  });
  it('learns a completion only for original participants, exactly once, and strips pooled profiles', () => {
    const bank = new HorseObserverReads(20, 20, () => 100);
    bank.run(request(), () => undefined);
    bank.run(request(other, 'cash', 'nlh', 1000002), () => undefined);
    const done = { ...completion(), durableOpponentProfiles: [] };
    expect(
      bank.complete(done, (r) => {
        expect(r).not.toHaveProperty('durableOpponentProfiles');
        learn();
      })
    ).toBe(1);
    expect(bank.complete(done, learn)).toBe(0);
    bank.run(request(), () => {
      expect(HorseMind.getStats(opponent)).toBeDefined();
      expect(winnerReadout(opponent)?.effectiveHands).toBe(1);
    });
    bank.run(request(other), () => expect(HorseMind.getStats(opponent)).toBeUndefined());
  });
  it('refuses another lease and an uncommitted hand without learning', () => {
    const bank = new HorseObserverReads();
    bank.run(request(), () => undefined);
    expect(bank.complete({ ...completion(), fence: `${table}:1000001:99:observe` }, learn)).toBe(0);
    expect(bank.complete({ ...completion(), committedHandId: undefined }, learn)).toBe(0);
  });
  it('cannot expose a completion learned after a queued snapshot cutoff', () => {
    const bank = new HorseObserverReads(20, 20, () => 2000);
    bank.run(request(), () => undefined);
    bank.complete(completion(), learn);
    bank.run(request(), () => expect(HorseMind.getStats(opponent)).toBeUndefined());
    bank.run({ ...request(), decisionTimeMs: 3000 }, () =>
      expect(HorseMind.getStats(opponent)).toBeDefined()
    );
  });
  it('keeps the exact issued view for its commit even after entry eviction', () => {
    const bank = new HorseObserverReads(1);
    const original = request();
    bank.run(original, learn);
    bank.run(request(other), () => undefined);
    bank.runIssued(original, () => expect(HorseMind.getStats(opponent)).toBeDefined());
    bank.run(request(), () => expect(HorseMind.getStats(opponent)).toBeUndefined());
  });
  it('restores process state on exceptions and starts fresh after restart', () => {
    const bank = new HorseObserverReads();
    expect(() =>
      bank.run(request(), () => {
        learn();
        throw Error('fault');
      })
    ).toThrow('fault');
    expect(HorseMind.getStats(opponent)).toBeUndefined();
    new HorseObserverReads().run(request(), () =>
      expect(HorseMind.getStats(opponent)).toBeUndefined()
    );
  });
  it('requires explicit format, dealt roster and an observer identity; unknown is independently empty', () => {
    const bank = new HorseObserverReads();
    learn();
    for (const r of [
      request('legacy'),
      { ...request(), gameState: { ...request().gameState, format: undefined } },
      { ...request(), gameState: { ...request().gameState, dealtSeatIds: undefined } },
    ]) {
      expect(horseObserverReadContextFromRequest(r as never)).toBeNull();
      bank.run(r as never, () => expect(HorseMind.getStats(opponent)).toBeUndefined());
    }
  });
  it('keeps 1,000 distinct eligible observer views separate without global writes', () => {
    const bank = new HorseObserverReads();
    const requests = Array.from({ length: 1000 }, (_, i) =>
      request(
        `20000000-0000-4000-8000-${(i + 10).toString(16).padStart(12, '0')}`,
        'mtt',
        'nlh',
        1000010 + i
      )
    );
    for (const r of requests) bank.run(r, learn);
    for (const r of requests)
      bank.run(r, () => expect(HorseMind.getStats(opponent)?.hands).toBe(1));
    expect(HorseMind.getStats(opponent)).toBeUndefined();
    expect(bank.receipt(requests[0]!)).toMatchObject({
      disposition: 'independent',
      history: 'volatile_only',
    });
  });
  it('records an explicit unavailable receipt when original participation or cutoff is unknown', () => {
    const bank = new HorseObserverReads(20, 20, () => 2000);
    const original = request();
    bank.run(original, () => undefined);
    bank.complete(completion(), learn);
    const stale = request();
    bank.run(stale, () => undefined);
    expect(bank.receipt(stale)).toMatchObject({ disposition: 'cutoff_unavailable', context: null });
    const missing = { ...request(), handJournalContext: null };
    bank.run(missing, () => undefined);
    expect(bank.receipt(missing)).toMatchObject({ disposition: 'unknown_hand' });
  });
  it('refuses contradictory variant/format censuses for one original hand', () => {
    const bank = new HorseObserverReads();
    bank.run(request(), () => undefined);
    bank.run(request(other, 'mtt'), () => undefined);
    expect(bank.complete(completion(), learn)).toBe(0);
  });

  it('applies accepted plans to the original observer, with no other horse seeing them', () => {
    const bank = new HorseObserverReads(20, 20, () => 100);
    const original = request();
    bank.run(original, () => undefined);
    bank.runIssued(original, () => HorseMind.notePlan('own-plan', actor, true));
    bank.run(request(), () => expect(HorseMind.getPlan('own-plan', actor)).toBe(true));
    bank.run(request(other), () => expect(HorseMind.getPlan('own-plan', actor)).toBeUndefined());
    expect(HorseMind.getPlan('own-plan', actor)).toBeUndefined();
  });
  it('a queued earlier snapshot cannot read a later accepted own plan', () => {
    const bank = new HorseObserverReads(20, 20, () => 2000);
    const original = request();
    bank.run(original, () => undefined);
    bank.runIssued(original, () => HorseMind.notePlan('own-plan', actor, true));
    const queued = request();
    bank.run(queued, () => expect(HorseMind.getPlan('own-plan', actor)).toBeUndefined());
    expect(bank.receipt(queued)?.disposition).toBe('cutoff_unavailable');
    bank.run({ ...request(), decisionTimeMs: 3000 }, () =>
      expect(HorseMind.getPlan('own-plan', actor)).toBe(true)
    );
  });
  it('verifies exact retained provenance and refuses forged or missing read receipts', () => {
    const bank = new HorseObserverReads();
    const r = request();
    bank.run(r, () => undefined);
    const receipt = bank.receipt(r)!;
    expect(horseObserverReadsWereIndependent(receipt, r)).toBe(true);
    for (const changed of [
      null,
      { ...receipt, extra: true },
      { ...receipt, version: 2 },
      { ...receipt, disposition: 'unknown_hand' },
      { ...receipt, cutoffMs: 1001 },
      { ...receipt, learnedThroughMs: 1001 },
      { ...receipt, context: { ...receipt.context!, observerId: other } },
    ])
      expect(horseObserverReadsWereIndependent(changed, r)).toBe(false);
  });
  it('resets the whole over-capacity view instead of keeping counters without dedupe', () => {
    const bank = new HorseObserverReads();
    bank.run(request(), () => {
      learn();
      HorseMind.importStats(
        Array.from({ length: 513 }, (_, i) => ({ user_id: `opponent-${i}`, hands: 1 }))
      );
    });
    const r = request();
    bank.run(r, () => expect(HorseMind.getStats(opponent)).toBeUndefined());
    expect(bank.receipt(r)?.disposition).toBe('capacity_reset');
    expect(horseObserverReadsWereIndependent(bank.receipt(r), r)).toBe(false);
  });
  it('detaches recovered observer metadata from a caller-owned object', () => {
    const bank = new HorseObserverReads(20, 20, () => 100);
    const context = structuredClone(horseObserverReadContextFromRequest(request())!);
    bank.runContext(context, learn);
    (context as { observerId: string }).observerId = other;
    const r = request();
    bank.run(r, () => expect(HorseMind.getStats(opponent)).toBeDefined());
    expect(bank.receipt(r)?.context?.observerId).toBe(actor);
    bank.run(request(other), () => expect(HorseMind.getStats(opponent)).toBeUndefined());
  });
});

describe('original observer routing and retained window evidence', () => {
  it('preserves admission after an uncommitted notification, refuses another lease and consumes once', () => {
    const registry = new HorseObserverParticipantRegistry();
    registry.capture(request());
    expect(registry.take({ ...completion(), committedHandId: undefined }).status).toBe('unknown');
    expect(registry.take({ ...completion(), fence: `${table}:1000001:99:observe` }).status).toBe(
      'unknown'
    );
    const bound = registry.take(completion());
    expect(bound.status).toBe('bound');
    expect(bound.contexts.map((c) => c.observerId)).toEqual([actor]);
    expect(observerParticipantsBind(bound, completion())).toBe(true);
    expect(observerParticipantsBind({ ...bound, extra: true }, completion())).toBe(false);
    expect(
      observerParticipantsBind(
        { ...bound, contexts: [...bound.contexts, ...bound.contexts] },
        completion()
      )
    ).toBe(false);
    expect(registry.take(completion()).status).toBe('unknown');
  });
  it('refuses conflicting partitions and treats bounded eviction as unknown', () => {
    const registry = new HorseObserverParticipantRegistry(1);
    registry.capture(request());
    registry.capture(request(other, 'mtt'));
    expect(registry.take(completion()).status).toBe('conflict');
    registry.capture(request());
    registry.capture(request(actor, 'cash', 'nlh', 1000002));
    expect(registry.take(completion()).status).toBe('unknown');
    expect(registry.take(completion(1000002)).status).toBe('bound');
    expect(() => new HorseObserverParticipantRegistry(0)).toThrow();
  });
  it('requires a closed bounded v2 history receipt at or before the original cutoff', () => {
    const r = request();
    const bank = new HorseObserverReads();
    bank.run(r, () => undefined);
    const receipt = {
      ...bank.receipt(r)!,
      version: 2,
      history: 'own_public_window',
      historyDigest: 'a'.repeat(64),
      historyAvailableAtMs: 0,
      historyHands: 64,
      historyCapped: true,
    };
    expect(horseObserverReadsWereIndependent(receipt, r)).toBe(true);
    for (const changed of [
      { ...receipt, historyAvailableAtMs: 1001 },
      { ...receipt, historyHands: 65 },
      { ...receipt, historyHands: -1 },
      { ...receipt, historyDigest: 'a'.repeat(63) },
      { ...receipt, historyCapped: 'true' },
      { ...receipt, history: 'volatile_only' },
      { ...receipt, extra: true },
    ])
      expect(horseObserverReadsWereIndependent(changed, r)).toBe(false);
  });
});
