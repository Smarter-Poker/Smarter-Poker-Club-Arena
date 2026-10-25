import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHorseExecutionWitness,
  settleHorseExecutionWitness,
} from '../../engine/HorseExecutionWitness.js';
import { captureHorseHandJournalContext } from '../../engine/HorseDecisionHandBinding.js';
import { encodeHorseDecisionReads } from '../../engine/HorseDecisionReadFrame.js';
import { HorseMind } from '../../engine/HorseMind.js';
import type { HorseDecision } from '../../types.js';
import {
  buildHorseDecisionKey,
  type FastHorseDecisionRequest,
} from '../../engine/horseDecision/protocol.js';
import { jointPolicyFixture } from '../../engine/multiway/JointRangeFixture.test-support.js';
import { journalHash, makeHorseJournalRecord, type HorseJournalRecord } from './record.js';
import { HorseDecisionJournalStore } from './store.js';
import { runtimeHorseJournalArchiveOptions } from './config.js';
import {
  readHorseJournalFleet,
  validateHorseFleetPacket,
  chargeHorseFleetReadBudget,
  HORSE_FLEET_READ_LIMITS,
} from './fleet.js';
import { runHorseJournalReview } from '../../scripts/horseJournalReview.js';
const table = '10000000-0000-4000-8000-000000000001',
  hand = '30000000-0000-4000-8000-000000000001',
  producer = '40000000-0000-4000-8000-000000000001';
const handKey = journalHash(`${table}:12:9`);
const turn = (x: any) =>
  journalHash(
    JSON.stringify([x.generation, x.fence, x.requestId, x.decisionKey, x.decisionTimeMs])
  );
function fixture() {
  const raw = jointPolicyFixture('nlh', 1, 'cash', 'preflop');
  const { hero, state } = JSON.parse(JSON.stringify(raw), (k, v) =>
    typeof v === 'string' && /^p[0-9]$/.test(v)
      ? `20000000-0000-4000-8000-00000000000${Number(v.slice(1)) + 1}`
      : v
  );
  state.toCall = 1;
  const snapshot: FastHorseDecisionRequest = {
    type: 'DECIDE_FAST',
    requestId: 1,
    generation: 7,
    fence: `${table}:12:1:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: hero,
    gameState: state,
    style: 'balanced',
    handJournalContext: captureHorseHandJournalContext(state.actionHistory),
  };
  snapshot.decisionKey = buildHorseDecisionKey(snapshot);
  const decision: HorseDecision = { action: 'call', thinkTime: 50 };
  const d = {
    snapshot,
    readFrame: encodeHorseDecisionReads(
      HorseMind.createSandbox(),
      state.players,
      HorseMind.handKeyOf(state.actionHistory)
    ),
    decision,
    effects: [],
    rngBefore: 1,
    rngAfter: 2,
    computeMs: 1,
    governorScale: 1,
    runtimePins: 'incomplete',
  };
  if (decision.tournamentUtility?.evidence)
    decision.tournamentUtility.readFrameSha256 = d.readFrame.sha256;
  if (decision.plo4Policy?.inputs) decision.plo4Policy.readFrameSha256 = d.readFrame.sha256;
  const w = createHorseExecutionWitness(snapshot, decision, {
    requestId: 1,
    lane: 'fast',
    computeMs: 1,
    governorScale: 1,
  });
  const record = {
    seat: hero.seat,
    userId: hero.user_id,
    action: decision.action,
    amount: 1,
    timestamp: 1001,
    stage: 'preflop' as const,
  };
  settleHorseExecutionWitness(w, { applied: true, acceptedActions: [{ record, intended: true }] });
  const ordinal = state.actionHistory.length;
  const a = {
    type: 'OBSERVE_COMPLETED_HAND',
    requestId: 3,
    generation: 12,
    fence: `${table}:12:9:observe`,
    handKey: `${table}:12`,
    committedHandId: hand,
    bigBlind: state.bigBlind,
    actions: [
      ...state.actionHistory,
      {
        ...record,
        origin: 'horse_policy',
        publicNode: { version: 1, status: 'captured', actorSeat: hero.seat, street: 'preflop' },
        observationIdentity: {
          version: 1,
          status: 'bound',
          handId: hand,
          actionOrdinal: ordinal,
          observationId: `${hand}:${ordinal}`,
          sessionKey: 'a'.repeat(64),
        },
      },
    ],
  };
  const make = (
    kind: HorseJournalRecord['kind'],
    sequence: number,
    body: unknown,
    recordTurn = turn(snapshot)
  ) =>
    makeHorseJournalRecord(
      {
        producerId: producer,
        sequence,
        atMs: 2000,
        sourceRelease: 'a'.repeat(40),
        kind,
        handKey,
        turnKey: kind === 'accepted_hand' ? handKey : recordTurn,
      },
      body
    );
  const result = {
    d,
    w,
    a,
    make,
    rows: (): HorseJournalRecord[] => [
      make('decision', 1, result.d),
      make('execution', 2, result.w),
      make('accepted_hand', 3, result.a),
    ],
  };
  return result;
}
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const roster = () =>
  Array.from(
    { length: 1000 },
    (_, i) => `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`
  );
const packet = () => ({
  version: 1 as const,
  sourceSha: 'a'.repeat(40),
  window: { startUtc: '1970-01-01T00:00:00.000Z', endUtc: '1970-01-01T00:01:00.000Z' },
  horseIds: roster(),
  handKeys: [handKey],
});
function stored(shard = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'horse-fleet-'));
  dirs.push(dir);
  const f = fixture();
  const store = new HorseDecisionJournalStore(dir, {
    archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: shard }),
  });
  store.appendBatch(f.rows());
  store.close();
  return { dir, f };
}
describe('finite private fleet accepted-decision reader', () => {
  it('reads archived SQLite/shards, reports absent horses and preserves private storage', () => {
    const { dir, f } = stored(1);
    const before = readFileSync(join(dir, 'horse-decisions.sqlite'));
    const result = readHorseJournalFleet(dir, packet());
    expect(result).toMatchObject({
      reconciledHands: 1,
      acceptedDecisions: 1,
      observedHorses: 1,
      unobservedHorses: 999,
      completeHorseCoverage: false,
      completePopulation: false,
      phaseQualification: 'unknown',
      gaps: {},
    });
    expect(
      result.horses.find((h) => h.horseId === f.d.snapshot.player.user_id)?.acceptedDecisions
    ).toBe(1);
    const output = JSON.stringify(result);
    for (const privateValue of ['readFrame', 'communityCards', 'rngBefore', f.d.snapshot.fence])
      expect(output).not.toContain(privateValue);
    expect(readFileSync(join(dir, 'horse-decisions.sqlite'))).toEqual(before);
  });
  it('refuses wrong source and out-of-window capture', () => {
    const { dir } = stored();
    const p = packet();
    p.sourceSha = 'b'.repeat(40);
    expect(readHorseJournalFleet(dir, p)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { source_mismatch: 1 },
    });
    const outside = packet();
    outside.window = { startUtc: '1970-01-01T00:00:03.000Z', endUtc: '1970-01-01T00:01:00.000Z' };
    expect(readHorseJournalFleet(dir, outside)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { capture_outside_window: 1 },
    });
  });
  it('deduplicates exact replay across archive shards', () => {
    const { dir, f } = stored();
    const once = readHorseJournalFleet(dir, packet()).validatedBytes;
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 1 }),
    });
    store.appendBatch(f.rows());
    store.close();
    expect(readHorseJournalFleet(dir, packet())).toMatchObject({
      validatedBytes: 2 * once,
      acceptedDecisions: 1,
      observedHorses: 1,
      gaps: {},
    });
  });
  it('rejects conflicting same-event capture across shards', () => {
    const { dir, f } = stored();
    const conflict = f.make('decision', 1, { ...f.d, computeMs: 2 });
    expect(conflict.eventId).toBe(f.rows()[0]!.eventId);
    const store = new HorseDecisionJournalStore(dir, {
      archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 1 }),
    });
    store.append(conflict);
    store.close();
    expect(readHorseJournalFleet(dir, packet())).toMatchObject({
      acceptedDecisions: 0,
      gaps: { record_conflict: 1 },
    });
  });
  it('does not infer missing capture or current horse membership', () => {
    const { dir } = stored();
    const p = packet();
    p.handKeys = [journalHash('missing')];
    expect(readHorseJournalFleet(dir, p)).toMatchObject({
      acceptedDecisions: 0,
      observedHorses: 0,
      completeHorseCoverage: false,
    });
    const notRoster = packet();
    notRoster.horseIds = roster().map((id) => id.replace('20000000', '90000000'));
    expect(readHorseJournalFleet(dir, notRoster)).toMatchObject({
      acceptedDecisions: 0,
      gaps: { actor_outside_roster: 1 },
    });
  });
  it('enforces exact roster, UTC window and finite selection', () => {
    for (const change of [
      { horseIds: roster().slice(1) },
      { horseIds: [...roster().slice(1), roster()[1]] },
      { handKeys: Array(10001).fill(handKey) },
      { window: { startUtc: '2026-10-25', endUtc: '2026-10-26' } },
    ])
      expect(() => validateHorseFleetPacket({ ...packet(), ...change })).toThrow();
    expect(readHorseJournalFleet('/no-such-private-journal', packet())).toMatchObject({
      acceptedDecisions: 0,
      gaps: { storage_unavailable: 1 },
    });
  });
});

describe('fleet CLI private input boundary', () => {
  it('uses the existing command and emits no packet paths or captured payloads', () => {
    const { dir } = stored();
    const input = join(dir, 'private-roster.json');
    writeFileSync(input, JSON.stringify(packet()));
    const result = runHorseJournalReview(['--fleet', dir, input]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      observedHorses: 1,
      completePopulation: false,
    });
    expect(result.output).not.toContain(dir);
    expect(result.output).not.toContain('readFrame');
    expect(runHorseJournalReview(['--fleet', 'relative', input]).code).toBe(64);
    writeFileSync(input, 'x'.repeat(1024 * 1024 + 1));
    const oversized = runHorseJournalReview(['--fleet', dir, input]);
    expect(oversized.code).toBe(3);
    expect(oversized.output).not.toContain(dir);
  });
});

describe('fleet global observation budget', () => {
  it('stops on elapsed bound and retains uninspected hands as unknown', () => {
    const { dir } = stored();
    let calls = 0;
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => (++calls === 1 ? 0 : 30001));
    try {
      expect(readHorseJournalFleet(dir, packet())).toMatchObject({
        boundReached: true,
        captureUnfinished: true,
        inspectedHands: 0,
        remainingHands: 1,
        completeHorseCoverage: false,
        gaps: { bound_reached: 1 },
        rosterVerified: false,
        horseCoverageScope: 'supplied_cohort_only',
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('global budget owner charges duplicate validated bytes', () => {
  it('refuses at the unchanged64MiB ceiling and retains charged bytes', () => {
    const budget = {
      started: performance.now(),
      validatedBytes: HORSE_FLEET_READ_LIMITS.validatedBytes - 1,
    };
    expect(() => chargeHorseFleetReadBudget(budget, 2)).toThrow('bound_reached');
    expect(budget.validatedBytes).toBe(HORSE_FLEET_READ_LIMITS.validatedBytes + 1);
  });
});

describe('elapsed budget inside a catalog read', () => {
  it('breaks the outer hand loop instead of resetting budget on refusal', () => {
    const { dir } = stored();
    const p = packet();
    p.handKeys.push(journalHash('next-hand'));
    let calls = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (++calls <= 3 ? 0 : 30001));
    try {
      expect(readHorseJournalFleet(dir, p)).toMatchObject({
        boundReached: true,
        captureUnfinished: true,
        inspectedHands: 0,
        remainingHands: 2,
        acceptedDecisions: 0,
        gaps: { bound_reached: 1 },
      });
    } finally {
      clock.mockRestore();
    }
  });
});
