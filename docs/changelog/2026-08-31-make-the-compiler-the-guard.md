# Make the compiler the guard

**2026-08-31** — third pass on the same file, after Dan said to build the
remaining items and skip anything high risk.

Two earlier passes fixed the tab factories one at a time: the seat rebuild was
missing `kind`, then it was missing `isTournament`. Fixing factories one at a
time is how a bug class survives. This pass replaces that pattern with guards
that cannot rot, and doing so immediately found a third site nobody had looked
at.

## 1. `TableInstance.kind` is required now, and that found the third factory

Changing `kind?:` to `kind:` and running `tsc` took one run to name a site two
audits had missed: the **initial state built from the URL** — the first tab of
any session that lands directly on `/table/:id`, which is a deep link, a
refresh at the table, or the dock going back. It carried no `kind` (so it was
invisible to the stale-seat prune, exactly the bug from pass one) and no
`gameCode` (so the tab strip showed a blank chip until TablePage reported one),
while the route effect twenty lines away builds the same tab from the same URL
_with_ both.

A required field is checked on every build by the compiler. A regex pin is
checked by whoever remembers to keep it accurate. That difference is the whole
point of this change.

## 2. `activeIndexRef` is assigned during render

It was written in a passive effect, so between a `setActiveIndex` and the next
commit the ref still named the PREVIOUS tab. Six readers consult it — the
rebuild's focus restore, the observe slot pick, the tab reorder, both
quick-join reads, and the route cap branch — and every one wants the tab the
player is on NOW. None wants the one they were on a commit ago; each was read
individually to confirm that before anything changed. A bus event landing in
that window (a seat, a balancer move) acted on the wrong tab.

It now matches the idiom this file already uses two lines above for `tablesRef`.

## 3. CI: the changed-file list was silently truncated

`ci.yml` asked the GitHub API for `per_page=300`. The API caps `per_page` at
**100** and does not error — it returns the first 100 filenames. A pull request
over 100 files would have been classified on a truncated list, so a `server/**`
change at position 101 would report `server=false`, the Server Engine job would
be SKIPPED, and a ruleset counts a skipped required check as SATISFIED.

That is the same silent-green failure the surrounding fail-open logic exists to
prevent, arriving through the door beside it. It uses `--paginate` now.

**Latent, not live:** the largest of the last 60 pull requests here touched 19
files. Nothing was ever misclassified. It is closed so the day cannot arrive.

## 4. CLAUDE.md said the CI gap was live. It was not.

Section 1.2.5 told every agent "THE ONE REAL GAP, and it is a live one: a
ruleset counts a skipped required check as satisfied." That described the
2026-08-23 incident, which was fixed the same day by adding

    always() && (needs.changes.result != 'success' || ...)

to `unit`, `server` and `build` — an undetermined diff now RUNS them. The words
outlived the bug and had been telling everyone since that CI could not be
trusted. Verified against `ci.yml` and the live API, then corrected.

## 5. A ratchet on the test weakness that hid all of this

196 of 700 test files (28%) read source as TEXT and never import or render the
unit. That is why the prune sat broken while "covered": the pin matched the
predicate's text and passed for as long as the predicate did nothing.

`scripts/ci/report-source-grep-tests.mjs` prints that inventory on every CI run
and enforces ONE rule: a `src/utils` module may not be pinned by text alone,
because those modules are pure and importable by construction.

**Enforced as a ratchet, not a cliff.** Five files already break that rule.
Failing CI on them would stop every agent in the repo over work none of them
started — the cure worse than the disease — so `--ratchet` fails only when the
count goes UP. Same shape as CHECK 6's cron governance: compare to current
state, never to zero. Proven in both directions before wiring: passes at 5/5,
exits 1 with a planted sixth.

## Not built, deliberately: the bulk test migration

Rewriting the ~196 text-only test files into behavioural ones is the obviously
correct end state and is **high risk** — a very large diff across files other
agents are actively editing, where every rewritten pin is a chance to weaken a
guard that is currently load-bearing. Dan's instruction was to skip anything
high risk. The ratchet stops the number growing; migration should happen file
by file, by whoever owns each area, starting with the five the script names.

## Also: 45 files of other agents' work were one reset away from gone

Not a code change, but the most urgent thing found. `~/Documents/club-arena`
held 28 modified + 17 untracked files, 42 commits behind main, with **5
`reset: moving to origin/main` entries in the last 50 reflog operations** — the
loop CLAUDE.md §13 warns destroys uncommitted work.

Snapshotted to `rescue/worktree-snapshot-20260831-035548` using a temporary
index, so HEAD, the real index and the working tree were never touched (verified
after: same HEAD, same 45 dirty entries). A branch ref survives
`git reset --hard origin/main`, which only moves the checked-out branch.

Recover with `git checkout rescue/worktree-snapshot-20260831-035548 -- <path>`.

Pushing that branch to origin is refused by the pre-push hook, because an
untracked WIP test in the tree (`heldEmptyRotationAndSoleOpen.test.ts`) fails
without `SUPABASE_SERVICE_ROLE_KEY` in the shell. The hook is right to refuse,
and the local ref already defeats the reset loop, so it was left alone rather
than forced.

## Verification

- `npx tsc --noEmit` clean.
- Full client suite in a worktree containing only these files on top of
  `origin/main`.
- The ratchet script exercised in both directions.
