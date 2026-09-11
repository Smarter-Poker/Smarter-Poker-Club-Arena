/**
 * THE WORLD HUB'S BYPASS ACTOR HAS OUTLIVED ITS REASON.
 *
 * ── WHAT IT IS ───────────────────────────────────────────────────────────────
 * The World Hub's `main: no rewinds` ruleset carries one bypass actor:
 *
 *     { actor_id: 4680372, actor_type: "Integration", bypass_mode: "always" }
 *
 * That is GitHub App Smarter-Poker-Autopilot. `bypass_mode: always` means the
 * app can push, force-push, delete or merge past every rule in that ruleset -
 * the required checks included.
 *
 * Club Arena's `main protection` has `bypass_actors: []`. Nobody, including a
 * repo admin. The two repos disagree about the most consequential setting they
 * have.
 *
 * ── WHY IT EXISTED, AND WHY THAT IS OVER ─────────────────────────────────────
 * `.github/scripts/estate-integrity.sh` records the reason, and allows exactly
 * this one actor in exactly this one repo:
 *
 *     "World Hub's `main` is written directly by the Club Arena bundle sync,
 *      which authenticates as GitHub App 4680372. That one bypass actor is the
 *      reason the branch can be protected at all."
 *
 * True when it was written on 2026-08-22. **The Club Arena bundle sync was
 * deleted on 2026-09-03.** Club Arena publishes to its own origin now
 * (`ca-static.smarter.poker`) and nothing is committed to the World Hub for it;
 * `public/hub/club-arena/` is gone from `main`, and
 * `tests/club-arena-is-a-rewrite.test.mjs` fails CI if it comes back. Verified
 * 2026-09-06: that path does not exist on `main` and the law that forbids its
 * return does.
 *
 * So the writer this exemption was carved for no longer writes here. What the
 * app still does is squash-merge pull requests - which needs no bypass at all,
 * as Club Arena proves every day with an empty bypass list and the same app.
 *
 * ── WHY IT MATTERS EVEN THOUGH NOTHING ABUSES IT ─────────────────────────────
 * `.github/scripts/queue-pr.sh` is careful: it merges directly only when
 * `mergeStateStatus` is CLEAN, explicitly never UNSTABLE, with a comment
 * explaining that UNSTABLE means a check IS failing. That is good code and it
 * is why nothing has gone wrong.
 *
 * But it means the guarantee rests on a shell script's `case` statement rather
 * than on GitHub refusing. Remove the bypass and the refusal is structural: no
 * edit to any script, no new workflow, and no future agent can land a pull
 * request whose required checks are red. That is what Club Arena already has.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/ci/remove-world-hub-bypass.mjs            # report only
 *   GH_TOKEN=<short-lived administration token> node scripts/ci/remove-world-hub-bypass.mjs --apply
 *
 * The token needs **Administration: Read and write** on Smarter-Poker-World-Hub.
 * A token that can push code cannot change protection rules - the estate's
 * usual GITHUB_TOKEN gets 404 on the PATCH, which is GitHub's way of saying
 * "not permitted" for this endpoint. This script says which of the two you have.
 *
 * It is IDEMPOTENT (already-empty is success), it PRINTS the exact JSON it will
 * send, and it READS THE RULESET BACK afterwards rather than trusting the write.
 */
import process from 'node:process';

const REPO = process.env.BYPASS_REPO || 'Smarter-Poker/Smarter-Poker-World-Hub';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const APPLY = process.argv.includes('--apply');

if (!TOKEN) {
  console.error('No short-lived token with Administration: Read and write was provided.');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'remove-world-hub-bypass',
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, body };
};

const list = await api(`/repos/${REPO}/rulesets`);
if (list.status !== 200 || !Array.isArray(list.json)) {
  console.error(`Cannot read rulesets (${list.status}). The token lacks Administration: Read.`);
  process.exit(2);
}

const branchRuleset = list.json.find((r) => r.target === 'branch') || list.json[0];
if (!branchRuleset) {
  console.error('No branch ruleset on this repo. That is a bigger problem than this script.');
  process.exit(2);
}

const detail = await api(`/repos/${REPO}/rulesets/${branchRuleset.id}`);
if (detail.status !== 200) {
  console.error(`Cannot read ruleset ${branchRuleset.id} (${detail.status}).`);
  process.exit(2);
}

const rs = detail.json;
const actors = rs.bypass_actors || [];

console.log(`${REPO}`);
console.log(`  ruleset : ${rs.name} (id ${rs.id}, enforcement ${rs.enforcement})`);
console.log(`  rules   : ${(rs.rules || []).map((r) => r.type).join(', ')}`);
console.log(`  bypass  : ${actors.length === 0 ? 'none' : JSON.stringify(actors)}`);

if (actors.length === 0) {
  console.log('\nAlready has no bypass actor. Nothing to do.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nWould send:  { "bypass_actors": [] }');
  console.log('Re-run with --apply and a token carrying Administration: Read and write.');
  console.log('\nBefore you do, be sure of these two, which this script cannot check for you:');
  console.log('  1. No workflow pushes directly to main as the app. Checked 2026-09-06:');
  console.log('     neither agent-autopilot nor agent-open-pr does.');
  console.log('  2. Autopilot still merges. Club Arena runs the same app with an empty');
  console.log('     bypass list, so this is evidenced rather than hoped.');
  process.exit(1);
}

const patch = await api(`/repos/${REPO}/rulesets/${rs.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ bypass_actors: [] }),
});

if (patch.status === 404 || patch.status === 403) {
  console.error(
    `\nRefused (${patch.status}). This token can read rulesets but not write them - ` +
      `it needs Administration: Read and write. Nothing was changed.`
  );
  process.exit(2);
}
if (patch.status !== 200) {
  console.error(`\nPATCH failed (${patch.status}): ${patch.body.slice(0, 300)}`);
  process.exit(2);
}

// Read it back. A write that reports success is not evidence that it took.
const after = await api(`/repos/${REPO}/rulesets/${rs.id}`);
const left = (after.json && after.json.bypass_actors) || [];
if (left.length === 0) {
  console.log('\nDone. bypass_actors is now empty, verified by reading the ruleset back.');
  console.log('The World Hub now matches Club Arena: nobody merges around a red check.');
  process.exit(0);
}
console.error(`\nPATCH returned 200 but ${left.length} bypass actor(s) remain: ${JSON.stringify(left)}`);
process.exit(2);
