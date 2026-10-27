import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateSelection,
  summarizeDecision,
} from '../../scripts/ci/inspect-horse-opponent-reads.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const selection = { sourceSha: 'a'.repeat(40), opponentId: id, handKeys: ['b'.repeat(64)] };
test('accepts only a finite closed data selection, with no command or path overrides', () => {
  assert.deepEqual(validateSelection(selection), selection);
  for (const p of [
    { ...selection, command: 'whoami' },
    { ...selection, handKeys: [] },
    { ...selection, handKeys: Array(17).fill('a'.repeat(64)) },
    { ...selection, opponentId: 'x;env' },
    { ...selection, sourceSha: 'main' },
    { ...selection, handKeys: ['../private'] },
  ])
    assert.throws(() => validateSelection(p));
});
test('emits only selected public counters and scalar execution receipts, never private cards or raw frames', () => {
  const secret = 'NEVER_EXPORT_THIS';
  const capture = {
    snapshot: {
      type: 'DECIDE_FAST',
      player: { user_id: id, cards: [secret] },
      gameState: { players: [{ user_id: id, cards: [secret] }], stage: 'preflop' },
      decisionTimeMs: 10,
    },
    decision: { action: 'raise', cards: [secret] },
    observerReads: {
      history: 'own_public_window',
      historyHands: 12,
      learnedThroughMs: 9,
      private: secret,
    },
    readFrame: { json: secret },
  };
  const view = {
    stats: new Map([[id, { hands: 12, vpip: 10, pfr: 8, threeBet: 3, private: secret }]]),
  };
  const execution = {
    executionStatus: 'intended',
    executedAction: 'raise',
    phase11Authority: {
      mode: 'candidate',
      selection: 'candidate',
      verdict: 'usable',
      private: secret,
    },
    private: secret,
  };
  const result = summarizeDecision(
    { handKey: 'b'.repeat(64), sourceRelease: 'a'.repeat(40) },
    capture,
    view,
    id,
    true,
    execution
  );
  assert.equal(result.opponent.hands, 12);
  assert.equal(result.execution.phase11.mode, 'candidate');
  assert.equal(result.independent, true);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(
    summarizeDecision({}, capture, view, '22222222-2222-4222-8222-222222222222', true),
    null
  );
});
test('runs only from an explicit default-branch dispatch, through pinned provider SSH, without a release route', () => {
  const y = readFileSync(
    new URL('../../.github/workflows/inspect-horse-opponent-reads.yml', import.meta.url),
    'utf8'
  );
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /github.event_name == 'workflow_dispatch'/);
  assert.match(y, /StrictHostKeyChecking=yes/);
  assert.match(y, /secrets.HETZNER_HOST_KEY/);
  assert.match(y, /flock -n 9/);
  assert.match(y, /docker exec -i/);
  assert.doesNotMatch(y, /schedule:|repository_dispatch:|docker restart|auto-deploy/);
});
