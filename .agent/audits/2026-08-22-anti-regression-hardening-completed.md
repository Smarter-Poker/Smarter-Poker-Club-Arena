# Anti-regression hardening — what shipped, what did not

**Date:** 2026-08-22
**Scope:** all 7 active repos
**Predecessor:** `.agent/handoffs/2026-08-22-finish-the-anti-regression-hardening.md`

Three of the four handed-off tasks are done and verified by outcome. One is
blocked on a credential only Dan can create, and the code side of it is
already shipped and inert.

---

## Task 1 — PR #178, landed as `c8ee0518c`

Conflicts were in `tests/e2e/live-animations.spec.ts` only, two hunks, both
resolved to main's side: #195 injects the halo `<svg>` into `.sw__seg--winner`
rather than reparsing the whole disc, and the other hunk was an assertion
message, not behaviour. That file is now byte-identical to main.

`tests/e2e/hero-card-row.spec.ts` was rebuilt from main plus the parts of #178
that were genuinely stronger:

- an UPPER bound on `rowLeft - seatRight`. "At or past the seat" alone passes
  for a row that has floated off its owner entirely.
- `rowCentreY` inside the seat's vertical span, replacing span-overlap. A row
  clipping the plate by one pixel satisfied the overlap form.
- the `HOLDEM` map proves itself: every height is `round(width x 1.4)`.

Kept from main against #178: the verbatim item-11 rationale and the 1px
subpixel tolerance. Dropped from #178: a duplicate `seatRight` key in the
`measure()` object literal.

**The finding that mattered more than the diff:** `hero-card-row.spec.ts` was
run by NO workflow. 40 assertions gating bug list item 11, never once executed
by CI — which is how a PR about them could sit 39 commits behind while
everything reported green. It needs no server and runs in 2.5s, so it is now
inside the required `CSS Beat E2E` gate. The job went from 20 tests to 60 on
the merge commit. `tests/shipped-invariants.test.ts` pins that it stays there,
verified by removing it and watching the guard fail.

---

## Task 3 — required checks in the other repos

| Repo | required check | note |
|---|---|---|
| smarter-poker-workers | `Typecheck + Lint + Test + Build` | |
| Smarter-Poker-Diamond-Arena | `Production Build` | see below |
| PepNationLab | `verify` | |
| smarter-poker-commander | `build` | its `ci.yml` parses fine; the earlier "would not parse" was the YAML `on:` -> `True` key |
| commander-shared | `Package Integrity` | new; see below |
| Smarter-Poker-World-Hub | none, deliberately | a `pull_request` rule blocks the `build-for-world-hub.yml` push and stops publishing |

Every ruleset: `pull_request` + `required_status_checks`, squash only, 0
approvals, `require_extra_approval_for_unattributed_changes: false`,
**`bypass_actors: []`**.

**Diamond-Arena does NOT require `TypeScript Check`.** That job carries
`continue-on-error: true` and is failing with **63 real errors** — wrong-case
`Suit` literals, `TS2367` comparisons that can never be true, a duplicate
identifier, missing `vite/client` types. Requiring it today would block every
PR in the repo. Written up as Diamond-Arena issue #12 with the order of
operations to close it.

**commander-shared had no CI at all,** and the obvious fix would have been
worse than nothing: its `npm test` is `echo 'no tests yet' && exit 0`. Instead
`scripts/ci/package-integrity.mjs` checks the ways this package has actually
broken its consumers — CommonJS in a `"type": "module"` package, relative
imports that resolve to nothing, `exports` subpaths pointing at nothing. Zero
dependencies, because the repo has no lockfile. The three existing CommonJS
files are frozen in an allowlist that may only shrink rather than fixed:
converting them changes what World Hub and Commander receive at runtime, which
needs those consumers tested, not a drive-by edit inside a CI patch.

**Found while there:** `Publish package` had failed on every push since at
least 2026-08-20 — ten consecutive runs — with `401 unauthenticated`. The job
set `NODE_AUTH_TOKEN`, but the repo's own root `.npmrc` reads `${NPM_TOKEN}`,
and a project `.npmrc` beats the user-level file `setup-node` writes. What
made it survive ten runs is that the guard above it treated ANY non-zero
`npm view` as "this version is new" — and `npm view` 401s too. Fail to read
the registry, conclude there is work to do, fail to authenticate, repeat.
Fixed both halves; the job is green and correctly reports `0.1.2 is already on
the registry`.

---

## Task 4 — the worktree rule is enforced, not advised

`.husky/pre-commit` in all 7 repos runs `scripts/guard-shared-clone.sh`, which
refuses a commit whose `--git-dir` equals its `--git-common-dir`. That equality
IS the shared clone; a linked worktree's git dir lives under
`<common>/worktrees/<name>`.

It refuses and stops. It never stashes, never checks out, never moves anyone —
moving an agent off its own uncommitted work is the precise destruction being
prevented. The message prints the exact `agent-workspace.sh` line, filled in
with agent name and branch.

Escape hatch is explicit at the call site: `AGENT_SHARED_CLONE_OK=1`, exported
by `git-safe-push.sh`. CI is exempt on its own — a runner's checkout is a
throwaway clone with one consumer.

Verified in all four directions before rolling out, and the commit that shipped
it was itself made in a worktree through the hook.

Also added `scripts/agent-trees-audit.sh`. A per-agent tree stops agents
overwriting each other; it does nothing about an agent leaving work where the
Antigravity `git reset --hard origin/main` loop will delete it. **Its first run
found `~/Documents/club-arena-2` holding 28 uncommitted files on
`fix/members-loop-and-union-wallet`, newest edit 3h 43m old.** Left untouched,
by design — see World Hub issue #625's sibling note. Somebody should land it.

**World Hub caveat, recorded so a merged PR is not mistaken for a working
guard:** its `package.json` `prepare` runs `git config --unset core.hooksPath`,
so git uses `.git/hooks/` and `.husky/pre-commit` does not execute there. The
two pre-commit files have diverged in BOTH directions — `.git/hooks/` has the
Club Arena build guard (CHECK A) that `.husky/` lacks, `.husky/` has the
`transpilePackages` guard that `.git/hooks/` lacks — so flipping `hooksPath`
today would silently drop a live check. Written up as World Hub issue #625 with
the union-first order of operations.

---

## Task 2 — NOT DONE, and it is the one with a date on it

`GH_PAT` expires **2026-11-19 20:14:28 UTC** — 89 days from this session.

The workflow side is shipped in all 7 repos and is byte-identical across them:
`agent-autopilot.yml` mints a GitHub App installation token via
`actions/create-github-app-token@v1`, gated on `vars.AUTOPILOT_APP_ID`.
Precedence is App token -> `GH_PAT` -> `GITHUB_TOKEN` with a warning.
`GITHUB_TOKEN` stays last for the reason it always was: a merge made with it
does not trigger downstream workflows, so the commit lands and never publishes.

With no App configured the mint step is `skipped` and behaviour is exactly what
it was — confirmed in the Club Arena run after the merge: step skipped,
`token OK`, sweep normal. So the App can be created at any time with no second
deploy.

`shipped-invariants` pins the precedence, because putting `GITHUB_TOKEN` first
is a one-character edit whose only symptom is that things stop publishing days
later.

**What is left, and it needs Dan** (a credential — one of the few legitimate
human exceptions in RULE 0):

1. Create a GitHub App on the `Smarter-Poker` account with **Contents: R/W,
   Pull requests: R/W, Workflows: R/W, Metadata: Read, Checks: Read**.
2. Install it on all 7 repos.
3. Generate a private key.
4. Then, per repo:
   `gh variable set AUTOPILOT_APP_ID --repo Smarter-Poker/<r> --body <id>`
   `gh secret set AUTOPILOT_APP_PRIVATE_KEY --repo Smarter-Poker/<r> < key.pem`
5. Verify the mint step reports `success` rather than `skipped`, and that
   `token OK — can read <repo>` still appears.

**Checks: Read is not decoration.** The current fine-grained PAT cannot read
check runs on commander-shared — `gh pr checks` returns 403 there — so the one
command for asking "did the gate actually run" does not work in the repo where
it was most needed today.
