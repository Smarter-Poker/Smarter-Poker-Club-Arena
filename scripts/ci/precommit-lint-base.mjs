import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// A protected-main merge must not reformat retained upstream evidence. Lint
// every candidate difference from that incoming revision, including conflicts.
// Ordinary commits and merges from other branches keep the normal staged scope.
export function lintBase(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ok = (...args) => spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
  if (!ok('rev-parse', '--verify', 'MERGE_HEAD')) return null;
  const incoming = git('rev-parse', 'MERGE_HEAD');
  if (!/^[0-9a-f]{40}$/.test(incoming) || !ok('merge-base', '--is-ancestor', incoming, 'refs/remotes/origin/main')) return null;
  if (git('ls-files', '-u')) throw new Error('Resolve every merge conflict before pre-commit validation.');
  // --diff disables lint-staged's partial-staging stash. Refuse partial staging
  // instead of validating or staging bytes the author did not intend to commit.
  if (!ok('diff', '--quiet')) throw new Error('Stage the intended merge resolution before pre-commit validation; unstaged tracked changes remain.');
  return incoming;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(lintBase() ?? ''); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
