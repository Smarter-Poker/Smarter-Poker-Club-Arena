import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { REMOTE_OBSERVER } from '../../server/scripts/phase6d-population.mjs';
import {
  horseTurnCensusPacketDigest,
  horseTurnContextBinding,
  validateHorseTurnCensusPacket,
  sanitizeHorseTurnCensusResult,
} from '../../scripts/ci/horse-turn-census-proof.mjs';
import {
  turnCensusRemoteObserver,
  turnCensusProgram,
  runFleetTurnCensus,
} from '../../server/scripts/phase6d-turn-census.mjs';

function fixture() {
  const start = '2026-10-28T00:00:00.000Z';
  return {
    version: 2,
    sourceSha: 'a'.repeat(40),
    window: { startUtc: start, endUtc: '2026-10-28T00:01:00.000Z' },
    horseIds: Array.from(
      { length: 1000 },
      (_, i) => `face0000-0000-4000-8000-${String(i).padStart(12, '0')}`
    ),
    hands: [
      {
        handKey: 'b'.repeat(64),
        committedAtMs: Date.parse(start) + 1000,
        actions: [
          {
            actorIndex: 0,
            actionOrdinal: 3,
            stage: 'flop',
            action: 'check',
            origin: 'horse_policy',
            amount: 0,
            seat: 1,
            timestamp: Date.parse(start) - 1000,
          },
        ],
      },
    ],
  };
}
function observation(packet) {
  return {
    version: 2,
    scope: 'supplied_committed_turn_census',
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    completePopulation: false,
    strategyCorrectnessVerified: false,
    activationAllowed: false,
    sourceSha: packet.sourceSha,
    packetDigest: horseTurnCensusPacketDigest(packet),
    expectedTurns: 1,
    validatedBytes: 0,
    boundReached: false,
    missingTurns: 1,
    contradictoryTurns: 0,
    extraneousCaptures: 0,
    unboundCaptures: 0,
    inspectedHands: 1,
    remainingHands: 0,
    turns: [
      {
        actorIndex: 0,
        handKey: packet.hands[0].handKey,
        actionOrdinal: 3,
        stage: 'flop',
        action: 'check',
        origin: 'horse_policy',
        expectedBinding: 'unknown',
        capture: 'missing',
        execution: 'missing',
        selection: 'unknown',
        inputBinding: 'unknown',
        publicRead: 'unknown',
        historicalRead: 'unknown',
        handReconciliation: 'unknown',
        phases: Object.fromEntries(
          Array.from({ length: 15 }, (_, i) => [
            `phase${i + 1}`,
            {
              status: 'unknown',
              capability: 'unobserved',
              eligibility: 'unknown',
              qualification: 'unknown',
              application: 'unknown',
              reasonSha256: null,
            },
          ])
        ),
      },
    ],
  };
}
function runFixture(mutate = () => {}) {
  assert.ok(process.platform !== 'darwin' || tmpdir().startsWith('/Volumes/SmarterWork/'));
  const dir = mkdtempSync(join(tmpdir(), 'horse-census-transport-'));
  try {
    const packet = fixture(),
      packetPath = join(dir, 'packet.json'),
      sshCommand = join(dir, 'ssh'),
      outputPath = join(dir, 'result.json');
    writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
    writeFileSync(sshCommand, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    let calls = 0;
    const result = runFleetTurnCensus(
      { packetPath, sshCommand, outputPath, remoteObserver: REMOTE_OBSERVER },
      {
        spawnSync(command, args, options) {
          calls++;
          assert.equal(command, sshCommand);
          assert.equal(args.length, 1);
          const p = JSON.parse(options.input);
          assert.equal(p.mode, 'fleet-turns');
          assert.equal(p.deadline, 90);
          assert.equal(options.timeout, 105000);
          assert.equal(options.maxBuffer, 2097152);
          const e = {
            containerName: p.name,
            release: packet.sourceSha,
            imageId: 'sha256:' + 'c'.repeat(64),
            servingContainer: 'd'.repeat(64),
            servingStartedAt: '2026-10-28T00:00:00.000Z',
            horseJournalMountVerified: true,
            readOnly: true,
            network: 'none',
            memoryBytes: 536870912,
            cpus: 0.5,
            exitCode: 0,
            stderrBytes: 0,
            v8HeapExhausted: false,
            oomKilled: false,
            containerExitCode: 0,
            observation: observation(packet),
            sameServingIdentityAfter: true,
            cleanupExitCode: 0,
            observerRemoved: true,
          };
          mutate(e);
          return { status: 0, stdout: Buffer.from(JSON.stringify(e)) };
        },
      }
    );
    return { result, saved: JSON.parse(readFileSync(outputPath, 'utf8')), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('closed host program and reused isolated observer parse without executing a journal read', () => {
  const remote = turnCensusRemoteObserver(REMOTE_OBSERVER);
  const python = spawnSync('python3', ['-B', '-c', 'import ast,sys;ast.parse(sys.stdin.read())'], {
    input: remote,
    encoding: 'utf8',
  });
  assert.equal(python.status, 0, python.stderr);
  for (const required of [
    '"--network","none"',
    '"--read-only"',
    '"--memory","512m"',
    '"--cpus","0.5"',
    '"observerRemoved"',
  ])
    assert.ok(remote.includes(required));
  const node = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: turnCensusProgram(fixture()),
    encoding: 'utf8',
  });
  assert.equal(node.status, 0, node.stderr);
  assert.throws(
    () => turnCensusRemoteObserver(REMOTE_OBSERVER + '\nfleet=p.get("mode")=="fleet"'),
    /contract/
  );
});
test('qualified isolated execution retains a missing expected turn without a full-coverage claim', () => {
  const { result, saved, calls } = runFixture();
  assert.equal(calls, 1);
  assert.equal(result.qualifiedExecution, true);
  assert.equal(saved.execution.observation.missingTurns, 1);
  assert.equal(saved.execution.observation.status, 'unknown');
  assert.equal(saved.completePopulation, false);
  assert.equal(saved.allPhasesVerified, false);
});
for (const [name, mutate] of [
  [
    'serving change',
    (e) => {
      e.sameServingIdentityAfter = false;
    },
  ],
  [
    'OOM',
    (e) => {
      e.oomKilled = true;
    },
  ],
  [
    'incomplete cleanup',
    (e) => {
      e.observerRemoved = false;
    },
  ],
  [
    'wrong mounted source',
    (e) => {
      e.release = 'e'.repeat(40);
    },
  ],
  [
    'changed isolation',
    (e) => {
      e.network = 'bridge';
    },
  ],
  [
    'private outer field',
    (e) => {
      e.privateCards = ['As', 'Ah'];
    },
  ],
  [
    'private per-turn field',
    (e) => {
      e.observation.turns[0].snapshot = { cards: ['As', 'Ah'] };
    },
  ],
])
  test(`refuses ${name} before exporting a qualified receipt`, () => {
    const { result, saved } = runFixture(mutate);
    assert.equal(result.qualifiedExecution, false);
    assert.equal(JSON.stringify(saved).includes('As'), false);
  });

test('the predeclared256turn partition plus worst closed phase rows and outer envelope fits remote stdout', () => {
  const helper = readFileSync(
    new URL('../../scripts/ci/horse-turn-census-packet.py', import.meta.url),
    'utf8'
  );
  const limit = Number(/^PARTITION_TURN_LIMIT=(\d+)$/m.exec(helper)?.[1]);
  assert.equal(limit, 256);
  const packet = fixture(),
    result = observation(packet);
  result.version = 3;
  const phase = {
    status: 'applicable-active',
    capability: 'unobserved',
    eligibility: 'outside-domain',
    qualification: 'owner-forced',
    application: 'not-applicable',
    reasonSha256: 'f'.repeat(64),
  };
  // Longest permitted values on every closed phase axis conservatively bound
  // actual interpreter combinations as well as every possible hashed reason.
  const turn = {
    ...result.turns[0],
    contextBinding: 'contradictory',
    historyReason: 'unknown',
    actorIndex: 999,
    actionOrdinal: 4095,
    stage: 'pineapple_discard',
    action: 'discard',
    origin: 'horse_fallback',
    expectedBinding: 'matched',
    capture: 'present',
    execution: 'intended',
    selection: 'matched',
    inputBinding: 'original_discard_request_and_controller',
    publicRead: 'not_applicable',
    historicalRead: 'not_applicable',
    handReconciliation: 'reconciled',
    phases: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`phase${i + 1}`, phase])),
  };
  result.turns = Array.from({ length: limit }, (_, i) => ({ ...turn, actionOrdinal: 4095 - i }));
  Object.assign(result, { expectedTurns: limit, missingTurns: 0 });
  sanitizeHorseTurnCensusResult(result);
  const envelope = {
    containerName: 'horse-phase6d-fleet-' + '9'.repeat(64),
    release: packet.sourceSha,
    imageId: 'sha256:' + 'c'.repeat(64),
    servingContainer: 'd'.repeat(64),
    servingStartedAt: '2026-10-28T00:00:00.000000000Z',
    horseJournalMountVerified: true,
    readOnly: true,
    network: 'none',
    memoryBytes: 536870912,
    cpus: 0.5,
    exitCode: 0,
    stderrBytes: 9007199254740991,
    v8HeapExhausted: false,
    oomKilled: false,
    containerExitCode: 0,
    observation: result,
    sameServingIdentityAfter: true,
    cleanupExitCode: 0,
    observerRemoved: true,
  };
  const size = Buffer.byteLength(JSON.stringify(envelope));
  const reasonHeadroom = limit * ('retention_heap_unavailable'.length - 'unknown'.length);
  assert.ok(size + reasonHeadroom < 1572864, 'longest closed history reason must also fit');
  assert.ok(size < 1572864, `closed envelope ${size} must fit remote stdout1572864`);
  const old = {
    ...envelope,
    observation: { ...result, expectedTurns: 512, turns: [...result.turns, ...result.turns] },
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(old)) > 1572864,
    'the former512turn bound overflows this same closed shape'
  );
});

test('version3 carries original closed context through maintained installed observer program', () => {
  const p = fixture();
  p.version = 3;
  p.hands[0].context = { variant: 'plo8', format: 'cash', provenance: 'committed_hand_history' };
  assert.equal(validateHorseTurnCensusPacket(p), p);
  const program = turnCensusProgram(p);
  assert.match(program, /horseTurnContextBinding\(expected.context,\s*s\)/);
  assert.equal(
    horseTurnContextBinding(p.hands[0].context, {
      gameState: { gameVariant: 'plo8', gameMode: 'cash' },
    }),
    'matched'
  );
  assert.equal(
    horseTurnContextBinding(p.hands[0].context, {
      gameState: { gameVariant: 'plo6', gameMode: 'cash' },
    }),
    'contradictory'
  );
  assert.equal(
    horseTurnContextBinding(p.hands[0].context, {
      gameState: { gameVariant: 'plo8', gameMode: 'tournament' },
    }),
    'contradictory'
  );
  assert.equal(
    horseTurnContextBinding(p.hands[0].context, { gameState: { gameVariant: 'plo8' } }),
    'unknown'
  );
  p.hands[0].context.variant = 'eight_cards';
  assert.throws(() => validateHorseTurnCensusPacket(p));
});
