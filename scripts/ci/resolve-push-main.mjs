#!/usr/bin/env node
// Associate Git's actual push destination with a configured tracking main.
// This does not grant destination authority: guard-merged-branch.sh still checks
// the actual URL and immutable GitHub repository identity before this is called.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CLUB_ARENA_REPOSITORIES } from './repository-identity.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repository(url) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)\/?$/.exec(url);
  if (!match) throw new Error('Push destination repository association is unknown');
  const slug = match[1].replace(/\.git$/, '');
  // Reuse the maintained explicit transfer aliases; arbitrary forks remain distinct.
  return CLUB_ARENA_REPOSITORIES.includes(slug) ? CLUB_ARENA_REPOSITORIES[0] : slug;
}
export function resolvePushMain(remoteArgument, destinationUrl, cwd = process.cwd()) {
  const destination = repository(destinationUrl);
  const remotes = git(['remote'], cwd).split('\n').filter(Boolean);
  const candidates = remotes.includes(remoteArgument) ? [remoteArgument] : remotes;
  const matching = candidates.filter(remote => {
    try {
      // A pushurl pointing at another repository does not make its fetch refs
      // evidence about that destination. Respect effective insteadOf rewrites.
      const fetch = repository(git(['remote', 'get-url', remote], cwd));
      const push = git(['remote', 'get-url', '--push', '--all', remote], cwd).split('\n');
      return fetch === destination && push.length > 0 && push.every(url => repository(url) === destination);
    } catch { return false; }
  });
  if (matching.length === 0) throw new Error('Push destination has no configured tracking main');
  let tips;
  try {
    tips = matching.map(remote => git(['rev-parse', '--verify', `refs/remotes/${remote}/main^{commit}`], cwd));
  } catch { throw new Error('Push destination tracking main is unavailable; fetch its main before pushing'); }
  // origin/upstream aliases with the same commit are one baseline. Divergent
  // tips remain unknown unless the caller explicitly selected a named remote.
  if (new Set(tips).size !== 1) throw new Error('Push destination tracking main tips disagree; select a named remote');
  return tips[0];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected the push remote and destination');
    console.log(resolvePushMain(process.argv[2], process.argv[3]));
  } catch (error) {
    // Never echo a possibly credential-bearing URL or a Git command error.
    console.error(`[push baseline] UNKNOWN: ${error.message}`);
    process.exitCode = 2;
  }
}
