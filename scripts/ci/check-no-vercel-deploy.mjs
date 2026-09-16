#!/usr/bin/env node
/**
 * CLUB ARENA MUST NOT DEPLOY TO VERCEL.
 * The existing trusted publisher also accepts World Hub requests through
 * publish-world-hub.yml. That maintained module publishes only World Hub's
 * fixed project and prebuilt output; its contracts run in required CI.
 * ─────────────────────────────────────────────────────────────────────────
 * CLAUDE.md 1.3 has said this since March:
 *
 *   Never run `vercel deploy` or `vercel --prod` in the Club Arena directory
 *   Never push to or test on `club-arena.vercel.app`
 *
 * Club Arena publishes exactly one way: a gated merge to main causes
 * publish-club-arena.yml to build the bundle and rsync it directly to Club
 * Arena's Hetzner static origin.
 * `vercel.json` here even carries `git.deploymentEnabled: false`.
 *
 * And yet, until 2026-08-22, two things in this repo did exactly what the rule
 * forbids, both with inviting names:
 *
 *   deploy-production.sh          `vercel --prod --yes` here, then
 *                                 `vercel --prod --force` in World Hub. At the
 *                                 repo root, with a comment calling itself
 *                                 "the deployment script".
 *   .github/workflows/manual-deploy.yml
 *                                 workflow_dispatch -> npm i -g vercel ->
 *                                 `vercel --prod`. Dispatched three times on
 *                                 2026-08-21. All three failed, which is why
 *                                 the repository page showed a red Production
 *                                 badge for a day.
 *
 * A rule in a document loses to a script with a plausible filename every time.
 * Both are deleted; this stops them coming back.
 *
 * A red badge on a repo that is not supposed to deploy is worse than it looks:
 * it teaches everyone that red on this repo means nothing, and the next red
 * badge is the one that mattered.
 *
 * Usage: node scripts/ci/check-no-vercel-deploy.mjs
 * Exit:  0 clean · 1 something can deploy · 2 script error
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', 'dist', '.git', '.next', 'playwright-report',
                      'test-results', '_to_delete', 'coverage', '.venv']);
const EXTS = /\.(sh|ya?ml|mjs|cjs|js|ts|json|command)$/;

/* The forbidden thing is INVOKING a deploy, not historical prose or a
   read-only API query. Match executable deployment forms only. */
const PATTERNS = [
  [/\bvercel\s+(--prod|deploy\b)/, 'invokes `vercel --prod` / `vercel deploy`'],
  [/\bnpx\s+vercel\s+(--prod|deploy\b)/, 'invokes `npx vercel --prod`'],
  [/api\.vercel\.com\/v\d+\/deployments['"`\s]*,?\s*\{[^}]*method:\s*['"`]POST/i,
   'POSTs to the Vercel deployments API'],
  [/vercel\.com\/v\d+\/integrations\/deploy\//, 'calls a Vercel deploy hook URL'],
];

const findings = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXTS.test(e.name)) continue;
    if (statSync(p).size > 512 * 1024) continue;
    const rel = relative(ROOT, p);
    // This file describes the patterns it bans; so does the playbook.
    if (rel === 'scripts/ci/check-no-vercel-deploy.mjs' || rel === 'AGENT-PLAYBOOK.md') continue;
    const src = readFileSync(p, 'utf8');
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#') || t.startsWith('//') || t.startsWith('*')) continue; // comments explain, they do not run
      for (const [re, why] of PATTERNS) if (re.test(line)) findings.push([rel, why, t.slice(0, 100)]);
    }
  }
})(ROOT);

if (findings.length === 0) {
  console.log('check-no-vercel-deploy: OK — no Club Arena source deployment to Vercel.');
  process.exit(0);
}

console.error('\nSOMETHING IN THIS REPO CAN DEPLOY TO VERCEL, AND NOTHING HERE MAY:\n');
for (const [file, why, line] of findings) console.error(`  ${file}\n    ${why}\n    ${line}`);
console.error(
  '\nClub Arena publishes ONE way: push a branch -> gated merge ->' +
    '\npublish-club-arena.yml -> Hetzner origin. A direct Vercel deploy here produces' +
    '\nclub-arena.vercel.app, which CLAUDE.md 1.3 says never to push to or test' +
    '\non, and leaves a red Production badge on a repo that is not supposed to' +
    '\ndeploy at all — which teaches everyone that red here means nothing.' +
    '\n\nRead-only provenance checks are fine and are not what this matches.' +
    '\nINVOKING a Vercel deployment is not.'
);
process.exit(1);
