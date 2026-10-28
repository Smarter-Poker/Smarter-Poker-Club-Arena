import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { horseRetainedPlanContext } from './effects.js';

// The CLI must use the existing effects owner in the installed engine, not a
// fictitious re-export from review. Only journal I/O and unrelated decoding are
// synthetic; the child executes the maintained retained-plan validator.
test('opponent inspection loads the actual retained-plan owner and preserves legacy refusal rules', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'horse-plan-import-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const selection = { sourceSha: 'a'.repeat(40), opponentId: id, handKeys: ['b'.repeat(64)] };
  const script = new URL(
    '../../../../scripts/ci/inspect-horse-opponent-reads.mjs',
    import.meta.url
  );
  const effects = new URL('./effects.ts', import.meta.url);
  const require = createRequire(import.meta.url);
  const loader = require.resolve('tsx');
  expect(typeof horseRetainedPlanContext).toBe('function');
  try {
    mkdirSync(join(cwd, 'dist/services/horseDecisionJournal'), { recursive: true });
    mkdirSync(join(cwd, 'dist/engine'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(cwd, 'dist/services/horseDecisionJournal/effects.js'),
      `export { horseRetainedPlanContext } from ${JSON.stringify(effects.href)};`
    );
    writeFileSync(
      join(cwd, 'dist/services/horseDecisionJournal/review.js'),
      `
      export function readHorseJournalHandRecords() {
        const capture = {snapshot:{type:'DECIDE_FAST', player:{user_id:'${id}'}, gameState:{players:[{user_id:'${id}'}],actionHistory:[]}}, decision:{action:'fold'}};
        if (process.env.FIXTURE_INVALID === 'yes') capture.planContext = null;
        return [{kind:'decision',sourceRelease:'${selection.sourceSha}',bytes:1,body:JSON.stringify(capture)}];
      }
      export function reconcileHorseJournalHand() { return {status:'synthetic'}; }
    `
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseDecisionReadFrame.js'),
      'export function decodeHorseDecisionReads(){ return {stats:new Map()}; }'
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseDecisionEffects.js'),
      'export function horsePlanHandKey(){return "synthetic";}'
    );
    writeFileSync(
      join(cwd, 'dist/engine/HorseObserverReadEvidence.js'),
      'export function horseObserverReadsWereIndependent(){return false;}'
    );
    for (const invalid of ['no', 'yes']) {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          loader,
          script.pathname,
          Buffer.from(JSON.stringify(selection)).toString('base64'),
        ],
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_COMMIT_SHA: selection.sourceSha,
            HORSE_DECISION_JOURNAL_DIR: 'synthetic',
            FIXTURE_INVALID: invalid,
          },
        }
      );
      expect(child.status, child.stderr).toBe(invalid === 'yes' ? 1 : 0);
      if (invalid === 'yes') {
        expect(child.stdout).toBe('');
        expect(JSON.parse(child.stderr).reason).toBe('retained_plan_refused');
      } else {
        expect(child.stderr).toBe('');
        expect(JSON.parse(child.stdout).hands[0].decisions[0].action).toBe('fold');
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
