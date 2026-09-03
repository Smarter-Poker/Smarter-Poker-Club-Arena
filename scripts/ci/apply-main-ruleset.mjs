#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  apply-main-ruleset — the server-side gate, once GitHub Pro is on
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-21 main was unable to deploy four separate times, every one a red
 * test pushed alongside the feature it was meant to guard, and separately main
 * was force-rewound and four commits already serving in production were dropped
 * from it. `.husky/pre-push` now catches both locally - but a hook is a seatbelt
 * on an unlocked door: `--no-verify` skips it, and a push made through the
 * GitHub API never runs it at all.
 *
 * A ruleset is the lock. It is enforced by GitHub, on the server, for every
 * client, with no way to bypass it from a laptop.
 *
 * Private repos need GitHub Pro for rulesets. Until then the API answers
 * "Upgrade to GitHub Pro or make this repository public to enable this feature."
 *
 * TWO STAGES, because the second one changes how every agent works.
 *
 *   --stage=1   Block force-pushes and deletion of main. Nothing else.
 *               Zero workflow change: agents keep pushing straight to main.
 *               This alone would have prevented the lost-commits incident.
 *
 *   --stage=2   Stage 1, plus: main is reachable only through a pull request,
 *               and only when TypeScript Check and Client Unit Tests (vitest)
 *               have passed. This is the one that makes a red test impossible
 *               to land. It does mean no more direct pushes to main.
 *
 * The two required checks already exist in ci.yml, already run on
 * pull_request, and already use a per-PR concurrency group, so requiring them
 * needs no new workflow and cannot deadlock the way the push-triggered
 * publish workflow did.
 *
 * Usage:
 *   GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=1
 *   GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=2
 *   GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=2 --dry-run
 *
 * The token needs "Administration: Read and write" on the repository. A token
 * that can push code cannot change protection rules - that separation is
 * deliberate, and this script tells you plainly which of the two is missing.
 */

const OWNER = 'Smarter-Poker';
const REPO = 'Smarter-Poker-Club-Arena';
const NAME = 'main protection';

/** The checks that must pass. Job display names from .github/workflows/ci.yml. */
const REQUIRED_CHECKS = ['TypeScript Check', 'Client Unit Tests (vitest)'];

const args = process.argv.slice(2);
const stage = Number((args.find((a) => a.startsWith('--stage=')) || '--stage=1').split('=')[1]);
const dryRun = args.includes('--dry-run');
const token = process.env.GH_PAT || process.env.GITHUB_TOKEN;

if (!token) {
  console.error('No token. Set GH_PAT (it is in the World Hub env file) and re-run.');
  process.exit(1);
}
if (stage !== 1 && stage !== 2) {
  console.error('--stage must be 1 or 2. See the header for what each one does.');
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body is fine on some responses */
  }
  return { status: res.status, body };
};

/** Rules are additive: stage 2 is stage 1 plus the pull-request gate. */
function rules() {
  const base = [
    { type: 'deletion' },
    { type: 'non_fast_forward' }, // blocks force-push, which is how four live commits were lost
  ];
  if (stage === 1) return base;
  return [
    ...base,
    {
      type: 'pull_request',
      parameters: {
        // Solo owner plus a fleet of agents: requiring a human approval would
        // stop everything. The GATE here is the checks, not a reviewer.
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false, // do not force a rebase per push; main moves too fast
        required_status_checks: REQUIRED_CHECKS.map((context) => ({ context })),
      },
    },
  ];
}

const payload = {
  name: NAME,
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
  rules: rules(),
};

const explain = (status, body) => {
  const msg = body?.message || '';
  if (/Upgrade to GitHub Pro/i.test(msg)) {
    console.error('\n  BLOCKED BY PLAN: rulesets need GitHub Pro on a private repo.');
    console.error('  github.com/settings/billing -> Upgrade -> Pro ($4/month), then re-run.\n');
  } else if (status === 403) {
    console.error('\n  BLOCKED BY TOKEN PERMISSION: this token can push code but not change');
    console.error('  protection rules. Add "Administration: Read and write" to the fine-grained');
    console.error('  PAT at github.com/settings/tokens, then re-run.\n');
  } else {
    console.error(`\n  HTTP ${status}: ${msg || JSON.stringify(body)}\n`);
  }
};

const run = async () => {
  console.log(`Ruleset "${NAME}" on ${OWNER}/${REPO}, stage ${stage}:`);
  for (const r of payload.rules) console.log(`  - ${r.type}`);
  if (stage === 2) console.log(`  required checks: ${REQUIRED_CHECKS.join(', ')}`);
  if (dryRun) {
    console.log('\n--dry-run: nothing sent.\n');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const list = await api('/rulesets');
  if (!Array.isArray(list.body)) {
    explain(list.status, list.body);
    process.exit(1);
  }

  const existing = list.body.find((r) => r.name === NAME);
  const res = existing
    ? await api(`/rulesets/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
    : await api('/rulesets', { method: 'POST', body: JSON.stringify(payload) });

  if (res.status >= 200 && res.status < 300) {
    console.log(`\n  ${existing ? 'Updated' : 'Created'} ruleset id ${res.body.id}. main is protected.\n`);
    return;
  }
  explain(res.status, res.body);
  process.exit(1);
};

run().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
