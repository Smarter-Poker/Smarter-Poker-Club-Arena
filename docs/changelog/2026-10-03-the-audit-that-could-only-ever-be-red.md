# The audit that could only ever be red

2026-10-03. `Schema Integrity Audit` had two red jobs on `main`. Neither was
reporting a defect in the thing it watches. One was reporting that nobody had
committed a file for a fortnight, and it had been unable to say so until the
fourteenth day; the other was asking a question that cannot be answered yes in
this repository, and had answered no on every single run it ever completed.

Run with the two findings: **37110065144** (2026-10-03T08:32:46Z).

## 1. The ledger attestation was fourteen days behind, and nothing said so

`ca_ledger_day_manifests` hashes each day of `chip_ledger` and keeps the sha in
the same database as the journal it hashes, so it proves nothing to anybody who
does not already trust that database. `docs/attestation/chip-ledger-days.tsv` is
where git carries the same history, which is the entire point of the file.

It stopped at **2026-09-18**. Fourteen days - 2026-09-19 through 2026-10-02,
3,104,522 ledger rows - had been attested by the database and anchored nowhere
else. Every one of the 48 days the file already carried still hashed exactly the
same, so this was never the incident the job exists to catch.

**Settled:** the fourteen days are appended, read out of
`ca_ledger_day_manifests` directly and byte-identical to what
`anchor-ledger-days.mjs` produced in the run above.

**The cause, and the fix.** The 2026-09-19 change separated the two verdicts -
"a day already anchored now hashes differently" is the incident, "the file has
not caught up" is a backlog - and that was right. It then gave the backlog **no
reader** (CLAUDE.md 10.86 rule 3). Its only output was a `::warning` in a
scheduled run, which nothing reads, so the first thing a person could see was
the job going red once the backlog crossed fourteen days - arriving through
`check-main-is-green` as "Schema Integrity Audit has been red", shaped exactly
like the incident and masked outright by any open issue naming this workflow.
That is precisely the failure the two issue steps in this job were written to
prevent in the first place; the backlog did not copy them.

So the backlog now has its own reader: its own issue, its own title, filed at
**three days behind** and closed when git catches up. The threshold is derived,
not guessed (CLAUDE.md 10.84): when the anchoring was being done it was one
line a day - `ea1bf545e4` (2026-09-08), `241e3a2e65` (09-09), `97ae9bfe56`
(09-10), `1a0cdc3eed` (09-11), each +1 - and a day is attested the morning
after it closes, so 0 or 1 behind is the normal state and must never file
anything, while three means at least two consecutive days were missed. Eleven
days of warning remain before the fourteen-day hard bound, which is unchanged.
The incident's issue and the backlog's issue cannot close one another.

`tests/the-anchor-backlog-is-not-the-incident.law.test.ts` pins all of it.

## 2. `refresh` asked a question that cannot be answered yes

The last step of the `refresh` job was `git diff --quiet -- scripts/ci/` after
regenerating the manifests from live production: any difference at all failed
the job, with "regenerate it in a reviewed change".

**It never passed.** The job is skipped on the hourly cron and runs only on the
daily cron, a dispatch or a manual run. Measured across the last 100 runs of the
workflow, it **ran sixteen times** between 2026-09-13 and 2026-10-02 and
**failed all sixteen**.

Nothing was wrong on any of them. In the last one production carried 1,541
tables and 4,306 functions against the committed base's 1,321 and 3,572 - about
960 names ahead - and `prune-schema-fragments.mjs` in the same run reported
`445 absorbed, 10 trimmed, 10 still landing, 0 stale`. The fragment mechanism
was working exactly as designed.

**The cause is two written rules in conflict, and the later one wins**
(CLAUDE.md 10.8). `scripts/ci/schema-manifest.mjs` (2026-09-22) made the base
snapshot **read-only to agents**, because it was the most-changed file on main -
25 commits in 24 hours - and any two branches touching it conflicted by
construction. An agent declares a new name in its own fragment instead. So the
only act that satisfies a byte-diff of the base is the one the fragment system
exists to forbid. The same file states what the nightly refresh is for: it
"goes red when a promised addition is absent or a promised removal is still
live". That is `prune-schema-fragments.mjs`, which judges fragments - and
nothing had ever judged the base.

**The fix** is `scripts/ci/check-schema-contract.mjs`, which replaces the
byte-diff and separates the two harms it conflated:

- **PHANTOM (fails):** the committed contract names a table, view, function,
  column or required column that live production does not have, and no fragment
  tombstone retires it. The phantom-reference gates read that contract, so they
  are blessing a reference runtime will refuse - the one direction nothing in
  this repository ever checked, because prune only ever judged fragments.
- **BEHIND (reported):** production has names the contract does not. That is the
  documented steady state here, and a branch that needs a name declares it in a
  fragment. Reported with its count so the drift stays visible and a base
  regeneration can be judged as due. It is no longer a failure: it was one for
  sixteen consecutive runs and all it did was bury the check above it.
- **COULD NOT TELL (fails distinctly, exit 2):** a missing, unparseable or
  implausibly empty live snapshot, or a fragment that will not parse. Never
  reported as clean, and never as a thousand phantoms (10.86 rules 1 and 2).

Two details that are load-bearing. The step runs only when the regeneration
step succeeded: without that, the "live" files on disk are the committed ones
straight out of the checkout, and the comparison would be the contract against
itself and report clean having measured nothing. And the committed side is read
out of `HEAD`, not from disk, so `prune`'s deletions in the same job cannot move
the verdict - which lets this step and the stale-fragment step both run on
`always()` without either masking the other.

The audit is still read-only: it writes nothing, commits nothing, pushes
nothing. `tests/unit/theSchemaManifestIsNotAMergeQueue.test.ts` moves its pin
from the removed command to the new one.

## What this did NOT touch

Both security jobs - `No unaccounted DEFINER writer is reachable from a browser`
and `The second writer agrees with the register` - are green and were not
touched. No grant, no definer body, no baseline.

The 470 fragments on `main` and the ~960 names the base is behind are real debt
and are now reported with a number on every run. They are not repaired here: a
base regeneration is a reviewed change that needs the service-role key, and
doing it inside this audit is the thing its own header forbids.

## One thing this broke on the way, and what stops it twice

The new behavioural test builds a throwaway git repository in `$TMPDIR` and runs
the real script against it. `.husky/pre-push` runs the suite, and git exports
`GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` to its hooks, so on the first
push the fixture's `git init` and `git config user.*` landed on the SHARED
config of `~/Documents/club-arena`: `core.bare = true`, which made the canonical
clone and every worktree on this machine refuse any work-tree operation, and a
`[user]` identity of `ci@example.invalid`, which would have authored every later
commit in the estate.

The pre-push hook refused the push, which is how it was found within a minute.
Both keys were repaired by hand - `core.bare` back to `false`, the identity back
to the one every commit made on this machine already carries and the one the
global config supplies - and the canonical clone and the worktree were confirmed
healthy afterwards. Three test files in a full suite run that overlapped the
window failed with `git ... status 128` for the same reason and pass now.

The fixture now inherits **no** `GIT_` variable at all, and the first assertion
in the file is that it does not, so a refactor that drops the scrub fails in that
file rather than in somebody else's clone.
