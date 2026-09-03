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

| Repo                        | required check                    | note                                                                                     |
| --------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| smarter-poker-workers       | `Typecheck + Lint + Test + Build` |                                                                                          |
| Smarter-Poker-Diamond-Arena | `Production Build`                | see below                                                                                |
| PepNationLab                | `verify`                          |                                                                                          |
| smarter-poker-commander     | `build`                           | its `ci.yml` parses fine; the earlier "would not parse" was the YAML `on:` -> `True` key |
| commander-shared            | `Package Integrity`               | new; see below                                                                           |
| Smarter-Poker-World-Hub     | none, deliberately                | a `pull_request` rule blocks the `build-for-world-hub.yml` push and stops publishing     |

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

## Task 2 — DONE, and verified end to end

`GH_PAT` expires **2026-11-19 20:14:28 UTC**, 89 days from this session, and
nothing was watching for it. Autopilot no longer depends on it.

The workflow side is shipped in all 7 repos and is byte-identical across them:
`agent-autopilot.yml` mints a GitHub App installation token via
`actions/create-github-app-token@v1`, gated on `vars.AUTOPILOT_APP_ID`.
Precedence is App token -> `GH_PAT` -> `GITHUB_TOKEN` with a warning.
`GITHUB_TOKEN` stays last for the reason it always was: a merge made with it
does not trigger downstream workflows, so the commit lands and never publishes.

With no App configured the mint step is `skipped` and behaviour is exactly what
it was — confirmed in the Club Arena run right after that merge: step skipped,
`token OK`, sweep normal. That property is why the App could be dropped in
later the same day with no second deploy and no half-migrated window.

`shipped-invariants` pins the precedence, because putting `GITHUB_TOKEN` first
is a one-character edit whose only symptom is that things stop publishing days
later.

**Dan created the App the same day.** `Smarter-Poker-Autopilot`, App id
`4680372`, installed on every repo in the account.
`vars.AUTOPILOT_APP_ID` and `secrets.AUTOPILOT_APP_PRIVATE_KEY` are set in all
7 repos and read back to confirm, not assumed from an exit code.

**The evidence, in the order it actually proves something:**

1. `Mint a GitHub App installation token` reports `success` in all 7 repos —
   it was `skipped` an hour earlier, so the step is genuinely running.
2. `check-token.sh` prints `token OK` and **no longer prints
   `GH_PAT expires in 89 days`**. That absence is the proof the token in
   `GH_TOKEN` is the App's: an installation token has no user, so `gh api user`
   403s and the expiry probe returns nothing. A run that starts printing an
   expiry again has silently fallen back to the PAT.
3. PR #215's auto-merge was enabled by **`app/smarter-poker-autopilot`**, not
   by a user. That is identity, not configuration.
4. #215 merged as `64b9b566` and **`build-for-world-hub.yml` fired on it** —
   the exact thing a `GITHUB_TOKEN` merge would not have done. World Hub `main`
   took `3f346eaa chore(club-arena): sync build 64b9b566` at 08:00:25 UTC and
   `https://smarter.poker/hub/club-arena/build-info.json` served
   `ca_sha: 64b9b566` at 08:03 UTC.

Steps 1 and 2 say the credential works. Only steps 3 and 4 say the credential
**publishes**, and publishing is the half that has failed silently here before.

`GH_PAT` is now unused by Autopilot but still present as the middle rung of the
`||` chain. Leave it until 2026-11-19 as a fallback; after that date it is dead
weight and can be deleted from all 7 repos.

#215 also corrected `check-token.sh`, whose remediation messages still told you
to rotate a PAT. They now name the three things that can actually break an App
credential — uninstalled, `AUTOPILOT_APP_ID` unset, PEM regenerated — in that
order, the last being likeliest because generating a new key invalidates the
old one instantly and silently.

**On Checks: Read**, which the App has and the old PAT did not: the PAT cannot
read check runs on commander-shared — `gh pr checks` returns 403 there — so the
one command for asking "did the gate actually run" did not work in the repo
where it was most needed during this session. Verification had to go through
`gh run list` and the jobs API instead. That should now work directly.
