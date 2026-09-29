import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_OBSERVATION_ACTION_KEYS,
  qualifyAdaptiveHand,
} from './HorseAdaptiveObservation.js';
import type { CompletedHandObservation } from './horseDecision/protocol.js';

/**
 * The committed snapshot RPC (`fn_horse_committed_observation_snapshot`)
 * projects every persisted action through a key whitelist before it crosses
 * the service boundary. `seat` is not in that whitelist and never was: the
 * public node carries only the actor's seat, identity lives on `userId`.
 * This fixture is that projected shape, anonymised, exactly as the database
 * returns it. It is not a controller replay; a controller replay carries
 * `seat` and cannot show what production sends.
 */
const NOW = Date.UTC(2026, 8, 25, 12);
const handId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actors = [
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
];
const sessionKey = (i: number) => (i + 1).toString(16).repeat(64).slice(0, 64);
type Action = NonNullable<CompletedHandObservation['actions']>[number];

const node = (actorSeat: number) => ({
  version: 1 as const,
  status: 'captured' as const,
  variant: 'nlh' as const,
  mode: 'cash' as const,
  asset: 'chips' as const,
  chipUnit: 0.01 as const,
  deductions: {
    version: 1,
    status: 'captured',
    rules: 'controller-rake-bbj-v1',
    rake: { percent: 5, cap: 3, noFlopNoDrop: true, playerCountCaps: [] },
    bbj: { enabled: false, feeBB: 0, minPotBB: 10, minPlayersDealt: 3 },
  },
  street: 'preflop' as const,
  dealerSeat: 1,
  actorSeat,
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  anteType: 'per_player' as const,
  allInOrFold: false,
  bombPot: false,
  boardCount: 1,
  boards: [''],
  pot: 3,
  currentBet: 2,
  toCall: 2,
  structure: 'no_limit' as const,
  minRaiseTo: 4,
  maxRaiseTo: 200,
  fixedBetSize: null,
  wagersCapped: false,
  legalActions: ['fold', 'call', 'raise', 'all_in'] as const,
  seats: [
    [1, 200, 0, 0, 0, 0, 0],
    [2, 199, 1, 1, 0, 0, 0],
    [3, 198, 2, 2, 0, 0, 0],
  ] as const,
});

const identity = (ordinal: number, actor: number) => ({
  version: 1 as const,
  status: 'bound' as const,
  observationId: handId + ':' + ordinal,
  handId,
  actionOrdinal: ordinal,
  sessionKey: sessionKey(actor),
});

/** Key order is the database's (jsonb_object_agg sorts by key length, then bytes). */
const projected = (ordinal: number, actor: number, action: string, seat: number): Action =>
  ({
    stage: 'preflop',
    action,
    origin: 'player',
    userId: actors[actor],
    timestamp: NOW - 1000,
    publicNode: node(seat),
    observationIdentity: identity(ordinal, actor),
  }) as Action;

function committedHand(): CompletedHandObservation {
  const actions: Action[] = [
    { userId: actors[1], action: 'sb', stage: 'preflop', timestamp: NOW - 1000 } as Action,
    { userId: actors[2], action: 'bb', stage: 'preflop', timestamp: NOW - 1000 } as Action,
    projected(2, 0, 'call', 1),
    projected(3, 1, 'call', 2),
    projected(4, 2, 'check', 3),
  ];
  const bigBlindOption = actions[4].publicNode as unknown as Record<string, unknown>;
  bigBlindOption.legalActions = ['check', 'raise', 'all_in'];
  bigBlindOption.toCall = 0;
  bigBlindOption.pot = 6;
  bigBlindOption.seats = [
    [1, 198, 2, 2, 0, 0, 0],
    [2, 198, 2, 2, 0, 0, 0],
    [3, 198, 2, 2, 0, 0, 0],
  ];
  return {
    handKey: 'x',
    committedHandId: handId,
    actions,
    bigBlind: 2,
  } as CompletedHandObservation;
}

describe('an observation is qualified by the shape the database returns', () => {
  it('the fixture is the projected shape: no seat, exactly the whitelisted keys', () => {
    for (const action of committedHand().actions!.slice(2)) {
      expect(Object.keys(action).sort()).toEqual([...COMMITTED_OBSERVATION_ACTION_KEYS].sort());
      expect('seat' in action).toBe(false);
    }
  });

  it('qualifies every voluntary action the RPC projects without a seat column', () => {
    const result = qualifyAdaptiveHand(committedHand(), NOW);
    expect(result.rejected.unavailable_public_node ?? 0).toBe(0);
    expect(result.rejected.unavailable_public_line ?? 0).toBe(0);
    expect(result.observations.length).toBe(3);
    expect(result.observations.map((o) => o.observationId)).toEqual([
      handId + ':2',
      handId + ':3',
      handId + ':4',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/cccccccc|dddddddd|eeeeeeee/);
  });

  it('still rejects an actor that is not the node actor once the seat is proven by userId', () => {
    const h = committedHand();
    // Ordinal 3 was acted from seat 2 by the second actor. Persist it under the
    // first actor instead: one userId now claims two seats and one seat two
    // actors, so no action of the hand can prove whose public line it is.
    h.actions![3].userId = actors[0];
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.observations).toEqual([]);
    expect(result.rejected.unavailable_public_node).toBeGreaterThan(0);
  });

  it('still rejects an action whose actor cannot be resolved at all', () => {
    const h = committedHand();
    delete (h.actions![2] as { userId?: string }).userId;
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.rejected.unavailable_public_node).toBe(1);
    expect(result.observations).toEqual([]);
  });

  it('a persisted seat that disagrees with the node is still rejected', () => {
    const h = committedHand();
    (h.actions![2] as { seat?: number }).seat = 2;
    const result = qualifyAdaptiveHand(h, NOW);
    expect(result.rejected.unavailable_public_node).toBe(1);
    expect(result.observations).toEqual([]);
  });
});

describe('the RPC projection and the qualifier agree on the action keys', () => {
  const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations');
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const defining = files.filter((f) =>
    /CREATE OR REPLACE FUNCTION public\.fn_horse_committed_observation_snapshot\(/.test(
      readFileSync(resolve(migrations, f), 'utf8')
    )
  );

  it('the latest migration that defines the RPC projects exactly the keys the qualifier reads', () => {
    expect(defining.length).toBeGreaterThan(0);
    const sql = readFileSync(resolve(migrations, defining[defining.length - 1]), 'utf8');
    const match = /f\.key IN \(([^)]*)\)/.exec(sql);
    expect(match, 'the action key whitelist must be a literal f.key IN (...) list').toBeTruthy();
    const keys = [...match![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([...COMMITTED_OBSERVATION_ACTION_KEYS].sort());
    expect(keys).not.toContain('seat');
  });
});
