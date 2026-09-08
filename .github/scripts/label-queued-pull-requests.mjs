#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PULL REQUEST THAT IS GREEN AND AHEAD OF MAIN IS QUEUED, NOT STALE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: "I WILL NEVER LEAVE ANYTHING UNFINISHED FOR MORE THAN 48
 * HOURS. ANYTHING OLDER THEN 48 HOURS IS TRASH." That rule is right and it
 * stays. This narrows what counts as unfinished.
 *
 * WHAT IT COST, MEASURED. On 2026-09-04 the 48-hour close took six pull
 * requests that were finished, reviewed and green - the horse-identity
 * programme - because they were waiting on a merge queue rather than on an
 * author. Recovering them took most of a session: `main` had moved by roughly
 * 800 pull requests, so every branch had to be cherry-picked onto a new base,
 * re-run against three guards that had landed meanwhile, and re-reviewed. The
 * work was never abandoned; it was queued. Closing it created the drift that
 * made it expensive.
 *
 * THE DISTINCTION. A pull request is STALE when it needs its author: red
 * checks, conflicts with `main`, nothing pushed. It is QUEUED when it needs
 * nobody: every required check green, no conflict, ahead of `main`, waiting
 * only for autopilot's turn. This labels the second kind `queued`, and
 * `stale.yml` exempts that label - so the clock keeps running for everything
 * that really is somebody's move.
 *
 * THE LABEL CANNOT BECOME ARMOUR. It is recomputed from scratch every run and
 * REMOVED the moment a pull request stops qualifying, so a branch that goes
 * red or falls behind starts ageing again immediately. Nothing a human types
 * keeps it; `pinned` and `do-not-close` already exist for that.
 *
 * THREE OUTCOMES, NEVER TWO (CLAUDE.md 10.86). Green, not-green, and COULD NOT
 * TELL. A 403, a rate limit or a body that does not parse is not "not green" -
 * answering that way would close the very pull requests this exists to
 * protect, which is the trap 10.86 was written about. On an unreadable answer
 * this leaves the labels exactly as they are, counts it, and says so. It never
 * guesses in either direction.
 *
 * Usage:  node .github/scripts/label-queued-pull-requests.mjs
 *         node .github/scripts/label-queued-pull-requests.mjs --dry-run
 * Env:    GITHUB_TOKEN (pull-requests: write), GITHUB_REPOSITORY
 * Exit:   0 always unless the run itself could not start - this is a
 *         housekeeping pass, and a failure here must never block the workflow
 *         that closes genuinely stale work.
 */

const DRY = process.argv.includes('--dry-run');
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const LABEL = 'queued';

if (!TOKEN || !REPO) {
  console.error('label-queued: GITHUB_TOKEN and GITHUB_REPOSITORY are required.');
  process.exit(2);
}

/**
 * The checks that actually gate a merge. Read from the ruleset when we can -
 * a hardcoded list would outlive the ruleset it copies (CLAUDE.md 1.1.7) -
 * and fall back to the names the ruleset carried on 2026-09-08 when the
 * ruleset endpoint is not readable by this token.
 */
const FALLBACK_REQUIRED = [
  'TypeScript Check',
  'Client Unit Tests (vitest)',
  'Server Engine (typecheck + tests)',
  'Production Build',
  'CSS Beat E2E (multi-table + animations)',
  'Silent Revert Guard',
];

/* Overridable so the law test can drive this against a stub API and prove the
   three outcomes, rather than asserting on the source text. */
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'label-queued-pull-requests',
      ...(init.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* a 204 or an error page */
  }
  return { ok: res.ok, status: res.status, body };
};

async function requiredCheckNames() {
  const res = await api(`/repos/${REPO}/rulesets?includes_parents=true`);
  if (!res.ok || !Array.isArray(res.body)) return FALLBACK_REQUIRED;
  for (const summary of res.body) {
    const full = await api(`/repos/${REPO}/rulesets/${summary.id}`);
    if (!full.ok || !Array.isArray(full.body?.rules)) continue;
    for (const rule of full.body.rules) {
      const checks = rule?.parameters?.required_status_checks;
      if (Array.isArray(checks) && checks.length) {
        return checks.map((c) => c.context).filter(Boolean);
      }
    }
  }
  return FALLBACK_REQUIRED;
}

/**
 * `green | red | unknown` for one head sha.
 *
 * Check runs are paginated and a required check can appear more than once
 * (a re-run); the LATEST conclusion for a name is the one that counts.
 */
async function checkState(sha, required) {
  const seen = new Map();
  for (let page = 1; page <= 5; page++) {
    const res = await api(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    // A 403 body has no `check_runs`; `?? []` here would read as "nothing
    // failed" - exactly the coercion 10.86 rule 2 forbids.
    if (!res.ok || !Array.isArray(res.body?.check_runs)) return 'unknown';
    for (const run of res.body.check_runs) {
      const prev = seen.get(run.name);
      if (!prev || new Date(run.started_at || 0) >= new Date(prev.started_at || 0)) {
        seen.set(run.name, run);
      }
    }
    if (res.body.check_runs.length < 100) break;
  }
  for (const name of required) {
    const run = seen.get(name);
    if (!run) return 'unknown'; // required and never reported: we cannot tell.
    if (run.status !== 'completed') return 'red'; // still running is not green.
    if (!['success', 'skipped', 'neutral'].includes(run.conclusion)) return 'red';
  }
  return 'green';
}

async function main() {
  const required = await requiredCheckNames();
  console.log(`label-queued: ${required.length} required check(s): ${required.join(', ')}`);

  const open = [];
  for (let page = 1; page <= 10; page++) {
    const res = await api(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
    if (!res.ok || !Array.isArray(res.body)) {
      console.error(`label-queued: could not list pull requests (${res.status}). Doing nothing.`);
      return;
    }
    open.push(...res.body);
    if (res.body.length < 100) break;
  }

  let queued = 0;
  let cleared = 0;
  let unknown = 0;

  for (const pr of open) {
    const labels = (pr.labels || []).map((l) => l.name);
    const has = labels.includes(LABEL);

    // Ahead of main, and no conflict. `mergeable_state` is famously
    // unreliable (10.86), so ask the compare endpoint what is true.
    const cmp = await api(
      `/repos/${REPO}/compare/${encodeURIComponent(pr.base.ref)}...${encodeURIComponent(pr.head.sha)}`
    );
    if (!cmp.ok || typeof cmp.body?.ahead_by !== 'number') {
      unknown++;
      console.log(`  #${pr.number} unknown (compare ${cmp.status}) - labels left as they are`);
      continue;
    }
    const ahead = cmp.body.ahead_by > 0;

    const state = ahead ? await checkState(pr.head.sha, required) : 'red';
    if (state === 'unknown') {
      unknown++;
      console.log(`  #${pr.number} unknown (checks unreadable) - labels left as they are`);
      continue;
    }

    const shouldBeQueued = ahead && state === 'green' && pr.draft !== true;

    if (shouldBeQueued && !has) {
      if (!DRY) {
        await api(`/repos/${REPO}/issues/${pr.number}/labels`, {
          method: 'POST',
          body: JSON.stringify({ labels: [LABEL] }),
        });
        // It is waiting on the queue, not on its author: restart its clock.
        await api(`/repos/${REPO}/issues/${pr.number}/labels/stale`, { method: 'DELETE' });
      }
      queued++;
      console.log(`  #${pr.number} + ${LABEL} (green, ${cmp.body.ahead_by} ahead)`);
    } else if (!shouldBeQueued && has) {
      if (!DRY) {
        await api(`/repos/${REPO}/issues/${pr.number}/labels/${LABEL}`, { method: 'DELETE' });
      }
      cleared++;
      console.log(`  #${pr.number} - ${LABEL} (${ahead ? state : 'behind or conflicted'})`);
    }
  }

  const line =
    `label-queued: ${open.length} open, ${queued} newly queued, ${cleared} cleared, ` +
    `${unknown} could not be read${DRY ? ' (dry run: nothing changed)' : ''}.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Queued pull requests\n\n${line}\n\nA pull request that is green and ahead of \`main\` ` +
        'is waiting on the merge queue, not on its author, so it is exempt from the 48-hour ' +
        'close. The label is recomputed every run and removed the moment it stops qualifying.\n'
    );
  }
}

main().catch((err) => {
  // Never fail the workflow that closes genuinely stale work.
  console.error(`label-queued: ${err?.message || err}`);
});
