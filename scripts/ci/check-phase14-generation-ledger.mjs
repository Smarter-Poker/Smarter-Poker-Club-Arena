/** Mandatory finite source publication guard. Unknown base/history is failure. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PHASE14_GENERATION_LEDGER_PATH,
  parsePhase14GenerationLedger,
  phase14GenerationTransitionAllowed,
} from '../../server/src/services/horseCorrectiveReview/kernelGenerationLedgerRules.mjs';
const root = process.cwd();
const env = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL']
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]])
);
const git = (args) =>
  execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
try {
  let base = process.argv[2] || process.env.CI_BASE_SHA;
  if (!base && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    base = event.pull_request?.base?.sha;
  }
  if (!base) base = git(['rev-parse', 'origin/main']);
  if (!/^[a-f0-9]{40}$/.test(base) || git(['rev-parse', '--is-shallow-repository']) !== 'false')
    throw Error('generation_base_unknown');
  git(['cat-file', '-e', base + '^{commit}']);
  const current = readFileSync(join(root, PHASE14_GENERATION_LEDGER_PATH));
  const shipped = readFileSync(
    join(root, 'server/release-evidence', PHASE14_GENERATION_LEDGER_PATH)
  );
  if (current.length > 512 * 1024 || !current.equals(shipped))
    throw Error('generation_shipping_mismatch');
  const after = parsePhase14GenerationLedger(JSON.parse(current.toString('utf8')));
  let before = null;
  const listed = git(['ls-tree', '--name-only', base, '--', PHASE14_GENERATION_LEDGER_PATH]);
  if (listed) {
    const bytes = git(['show', base + ':' + PHASE14_GENERATION_LEDGER_PATH]);
    if (Buffer.byteLength(bytes) > 512 * 1024) throw Error();
    before = parsePhase14GenerationLedger(JSON.parse(bytes));
    if (!before) throw Error('generation_base_invalid');
  } else if (git(['log', '-1', '--format=%H', base, '--', PHASE14_GENERATION_LEDGER_PATH]))
    throw Error('generation_ledger_deleted_from_base');
  if (!phase14GenerationTransitionAllowed(before, after))
    throw Error('generation_regression_or_tombstone_loss');
  process.stdout.write('Phase14 generation publication transition verified.\n');
} catch {
  process.stderr.write(
    'Phase14 generation publication refused: unavailable base/history, malformed/shipping mismatch, or nonmonotonic generation/tombstones.\n'
  );
  process.exitCode = 1;
}
