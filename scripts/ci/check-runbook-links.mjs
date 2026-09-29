#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RUNBOOK LINK LEADS SOMEWHERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The runbook is the first thing read by whoever the page wakes up.
 *
 * `check-monitoring-drift.mjs` has checked repo-relative runbook targets since
 * 2026-09-11, when 23 alerts were found pointing at three changelog files
 * nobody ever wrote. It skips `http(s)` targets deliberately: a build has no
 * business reaching somebody else's server during a pull request. Nothing then
 * checked those, and its summary said "every runbook resolves" regardless.
 *
 * Measured 2026-09-18: 19 alerts point at
 * https://monitor.smarter.poker/runbooks/<slug>. Every one answers 404
 * DEPLOYMENT_NOT_FOUND from Vercel - `*.smarter.poker` is a wildcard to Vercel,
 * no record sends `monitor` to cron-01 where infra/monitoring/Caddyfile expects
 * to serve it, and no document exists behind any of the slugs either.
 * EngineDown, PokerTablesFrozen, SpinPrizeUnpaid and sixteen others carry one.
 *
 * 2026-09-26: the rules now point at documents in this repository instead.
 * Nineteen runbooks were written under docs/runbooks/ from each alert's
 * expression and producer, and all 22 annotations became repo-relative paths.
 * So this command now resolves EVERY runbook target, not only http(s) ones: a
 * repo-relative path must name a file here, an http(s) link into this
 * repository is resolved the same way, and anything else is fetched. A scan
 * that finds no runbook at all is still broken, not clean - but "no http(s)
 * link" is now the healthy state and no longer means that.
 *
 * This is its own command rather than another check inside
 * check-alert-rules-match.mjs, because that one's unit test replaces `curl`
 * with an offline fixture that answers Prometheus and Alertmanager. A second
 * caller with different arguments breaks that contract, and a check that
 * breaks its neighbour's test seam to exist is not worth having.
 *
 * A link INTO THIS REPOSITORY is resolved as a file and never fetched: the
 * repository is private, so an anonymous GET of a blob URL answers 404 whether
 * or not the document exists - and the two here do exist. Fetching them would
 * have produced two confident false reports on the very first run.
 *
 * Usage:
 *   node scripts/ci/check-runbook-links.mjs
 *   ENGINE_MONITORING_SSH=user@host node scripts/ci/check-runbook-links.mjs
 *
 * Exit: 0 every link answers · 1 a link is dead · 2 could not ask
 *       (NEVER silently green)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MON = join(ROOT, 'infra', 'monitoring');

/**
 * The repository path a runbook URL points at, when it points into this
 * repository, and null when it points anywhere else.
 */
export function ownRepoPath(url) {
  const m = /^https?:\/\/github\.com\/Smarter-Poker\/[^/]+\/blob\/[^/]+\/(.+)$/.exec(url);
  return m ? decodeURIComponent(m[1].split('#')[0]) : null;
}

/** Every distinct runbook target declared in the rule files, http(s) or path, with owners. */
export function declaredRunbooks(dir = MON) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    let owner = '(unnamed)';
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const named = /^\s*-\s*(?:alert|record):\s*['"]?([\w:.-]+)/.exec(line);
      if (named) owner = named[1];
      const rb = /^\s*runbook:\s*['"]?([^'"\s]+)/.exec(line);
      if (!rb) continue;
      if (!out.has(rb[1])) out.set(rb[1], []);
      out.get(rb[1]).push(`${f}:${owner}`);
    }
  }
  return out;
}

/** Every distinct http(s) runbook URL declared in the rule files, with owners. */
export function declaredRunbookUrls(dir = MON) {
  return new Map([...declaredRunbooks(dir)].filter(([target]) => /^https?:\/\//.test(target)));
}

/** The status a URL answers with, over the box's network when given an ssh target. */
function statusOf(url) {
  const ssh = process.env.ENGINE_MONITORING_SSH;
  const raw = ssh
    ? execFileSync(
        'ssh',
        ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ssh,
         `curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 '${url}'`],
        { encoding: 'utf8' }
      )
    : execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '20', url], {
        encoding: 'utf8',
      });
  return Number(String(raw).trim());
}

export function main() {
  const runbooks = declaredRunbooks();
  if (runbooks.size === 0) {
    // A scan that matches nothing is broken, not clean. Both of this
    // repository's monitoring checks have been bitten by exactly that.
    console.error('[runbook-links] no runbook found in infra/monitoring - the scan is broken.');
    process.exit(2);
  }

  const dead = [];
  for (const [url, owners] of runbooks) {
    if (!/^https?:\/\//.test(url)) {
      // A repo-relative document: resolved as a file, never fetched.
      if (!existsSync(join(ROOT, url))) dead.push([url, 'no such file in this repo', owners]);
      continue;
    }
    const rel = ownRepoPath(url);
    if (rel) {
      if (!existsSync(join(ROOT, rel))) dead.push([url, 'no such file in this repo', owners]);
      continue;
    }
    let code;
    try {
      code = statusOf(url);
    } catch (err) {
      console.error('[runbook-links] COULD NOT FETCH A RUNBOOK LINK.');
      console.error(`   ${url}: ${err?.message || err}`);
      console.error('   This is not a pass. A link nobody can check is a link nobody can trust.');
      process.exit(2);
    }
    if (!Number.isFinite(code) || code === 0) {
      console.error(`[runbook-links] COULD NOT FETCH ${url} - no status returned.`);
      process.exit(2);
    }
    if (code >= 400) dead.push([url, code, owners]);
  }

  if (dead.length) {
    console.error('');
    console.error(`RUNBOOK LINKS THAT ANSWER NOTHING (${dead.length}):`);
    for (const [url, code, owners] of dead) {
      console.error(`   ${String(code).padEnd(24)} ${url}`);
      console.error(
        `        ${owners.length} rule(s): ${owners.slice(0, 4).join(', ')}${owners.length > 4 ? ', ...' : ''}`
      );
    }
    console.error('');
    console.error('  This is the first thing read by whoever the page wakes up, and it is a 404.');
    console.error('  Point the rule at a document that answers, or make the host serve one.');
    process.exit(1);
  }

  console.log(`[runbook-links] OK - ${runbooks.size} runbook target(s) resolve.`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
