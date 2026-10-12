// UNQUALIFIED source assembly only. No reserved migration or database client.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  buildCompleteRankingCandidate,
  rankingPredecessor,
} from './leaderboard-complete-ranking-candidate.mjs';
import { buildPromoPayoutCandidate, predecessor } from './leaderboard-promo-payout-candidate.mjs';
import {
  buildPromoConfigCandidate,
  configPredecessor,
} from './leaderboard-promo-config-candidate.mjs';
import {
  buildPromoOpeningCandidate,
  openingPredecessor,
} from './leaderboard-promo-opening-candidate.mjs';

export const reviewedInputs = Object.freeze([
  'd942ae27470d77666f1209a82dd137fe630d2af431f1babc03d444462a9502bc',
  '2f541ea70ee273c52721ad768f4af87f9f6655dfa8894f6308609ad115836be6',
  'a055971e3aa2cb154637bebc2efe64aa0ff4f59157ef80b1ab816204c5c1681a',
  '7a520913f0034a17815c7cfecd40a6b1aa3eb03fce990e5ce239eaa16d973115',
  '622c22ae5374766213d4bae20a90306bee3741238f6b8d075a32468e3103392e',
]);
export const disposableGuards = Object.freeze([
  null,
  `  IF session_user<>'leaderboard_qualification_bootstrap' OR current_user<>session_user
    OR inet_server_addr() IS NOT NULL OR current_database()<>'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;\n`,
  `  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
     OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;\n`,
  `  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
    OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;\n`,
  `  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
    OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;\n`,
]);
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const reviewedOutputHash =
  '58aebf766bbf7645a15205d675e06e574d88a5c0434fdf036d06f35cd3884a82';
export function loadReviewedInputs() {
  return [
    readFileSync(new URL('./leaderboard-capture-basis-candidate.sql', import.meta.url), 'utf8'),
    buildCompleteRankingCandidate(readFileSync(rankingPredecessor, 'utf8')),
    buildPromoPayoutCandidate(readFileSync(predecessor, 'utf8')),
    buildPromoConfigCandidate(readFileSync(configPredecessor, 'utf8')),
    buildPromoOpeningCandidate(readFileSync(openingPredecessor, 'utf8')),
  ];
}

// Exact pinned inputs make these literal removals unambiguous. This is not a
// generic SQL transaction parser and never strips BEGIN inside routine bodies.
export function assembleConsolidatedCandidate(inputs) {
  assert.ok(Array.isArray(inputs) && inputs.length === 5, 'Exact five inputs required');
  const chunks = inputs.map((input, index) => {
    assert.equal(typeof input, 'string');
    assert.equal(digest(input), reviewedInputs[index], 'Reviewed input drift');
    assert.equal(input.match(/^BEGIN;$/gm)?.length, 1, 'Unique outer BEGIN required');
    assert.equal(input.match(/^COMMIT;$/gm)?.length, 1, 'Unique outer COMMIT required');
    assert.ok(input.endsWith('COMMIT;\n'), 'Exact final COMMIT required');
    let chunk = input.replace('\nBEGIN;\n', '\n').slice(0, -'COMMIT;\n'.length);
    if (index !== 0) {
      const guard = disposableGuards[index];
      assert.equal(chunk.split(guard).length, 2, 'Exact unique disposable guard required');
      chunk = chunk.replace(guard, '');
    }
    return chunk;
  });
  const output =
    '-- UNQUALIFIED consolidated candidate. Not reserved or installed.\nBEGIN;\n' +
    chunks.join('\n') +
    'COMMIT;\n';
  assert.equal(output.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(output.match(/^COMMIT;$/gm)?.length, 1);
  assert.doesNotMatch(
    output,
    /leaderboard_qualification_bootstrap|Disposable bootstrap socket required/
  );
  assert.ok(output.includes("current_user <> 'postgres'"));
  assert.equal(digest(output), reviewedOutputHash, 'Reviewed assembled output drift');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(assembleConsolidatedCandidate(loadReviewedInputs()));
  } catch {
    process.stderr.write('Consolidated candidate refused: reviewed source or boundary changed\n');
    process.exitCode = 1;
  }
}
