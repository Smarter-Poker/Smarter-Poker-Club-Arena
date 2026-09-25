# An absent guard is not an empty one, and Club Arena was not the stale one

2026-09-23. `Estate Integrity` (run 35820278279, main `2217f17b89`) was red with
**21 problems**. Two of them were false, one of them was actively dangerous, and
the two files Club Arena was said to be stale in turned out to be the two files
Club Arena is deliberately and correctly different in. This records what was
measured, what was fixed here, and who owns the rest.

## 1. The check was calling a deleted file an empty one

`read_shared_file`'s ancestor did this:

```bash
C=$(gh api "repos/Smarter-Poker/$r/contents/$f" --jq '.content')
if [ -z "$C" ]; then MISSING="$MISSING $r"; continue; fi
```

`gh api ... --jq .content` does **not** go quiet on a 404. Measured against
production on 2026-09-23, it exits 1 and prints the error body on **stdout**:

```
{"message":"Not Found","documentation_url":"...","status":"404"}
```

127 bytes. So `[ -z "$C" ]` was false, the repo counted as PRESENT, `base64 -d`
refused that text and wrote nothing, and the digest came out `e3b0c44298fc` -
the sha256 of the empty string. The audit then announced:

> `.github/workflows/agent-open-pr.yml` in **Smarter-Poker-Diamond-Arena** is a
> ZERO-BYTE FILE.

It is not a zero-byte file. **It does not exist.** Neither does
`agent-autopilot.yml`. Both were deleted, on purpose, by that repository's own
PR **#64** (`d70fcbcd1928`, 2026-09-18T18:32:49Z, "ci: retire release agents and
redundant parked-app publisher"), which in the same commit added
`tests/deployment-controls.test.mjs` **there** to reject both files returning.
Restoring them would turn that repo's own test red.

This is CLAUDE.md 10.86 rule 2 exactly: an unreadable answer coerced into an
empty one. Deleted-on-purpose, emptied-by-accident and could-not-ask are three
facts with three owners and three opposite repairs, and they had one name.

## 2. The worse half: the deletion won the "newest" ranking

`commits?path=` still returns a date for a deleted path - the date of the
deletion. So the absent sentinel entered the "most recently committed" ranking
carrying 2026-09-18, and **won it** for `agent-open-pr.yml`:

> Most recently committed: **Smarter-Poker-Diamond-Arena** (2026-09-18T18:32:49Z,
> `e3b0c44298fc`). Carrying something else: Smarter-Poker-Club-Arena
> Smarter-Poker-World-Hub smarter-poker-commander commander-shared
> smarter-poker-workers PepNationLab

Read plainly, that line said the newest authoritative copy of the estate's
pull-request opener is **nothing at all**, and named the six repositories that
actually have a working one as the ones that are behind. An agent carrying out
that instruction would have deleted the PR opener from six repositories. A
report improved to be more actionable had become actionably wrong.

## 3. Club Arena's own two files: deliberate, not stale

The previous measurement was that Club Arena holds the newest copy of nine of
the eleven drifted files and something else in two. Both of those two were read
before anything was copied. **Neither is staleness.**

### `.husky/reference-transaction`

| repo                                                                                  | digest         | committed  |
| ------------------------------------------------------------------------------------- | -------------- | ---------- |
| Smarter-Poker-Club-Arena                                                              | `aaa958f81304` | 2026-09-11 |
| smarter-poker-commander                                                               | `aaa958f81304` | 2026-09-20 |
| Smarter-Poker-World-Hub                                                               | `8a140481be16` | 2026-09-21 |
| commander-shared / smarter-poker-workers / Smarter-Poker-Diamond-Arena / PepNationLab | `781e343266a5` | 2026-08-24 |

World Hub's is newest by date and **must not be copied here**. It writes the
about-to-be-orphaned commits to `refs/wip/orphan-guard/<stamp>` and adds an
`AGENT_REF_GUARD_OK=1` escape hatch. Club Arena's copy says in its own header
that it "does not stash, snapshot, create rescue refs, reconcile state, or
repair an operation after the fact", and two written rules hold it there:

- **CLAUDE.md 10.12** - a compensating write or recovery pass is not allowed to
  exist as the fix;
- **CLAUDE.md 12 rule 3** - "Do not create a bypass variable for a rebase or
  force-push."

And it is pinned in code: `tests/unit/resetGuardCannotSaveTheWorktree.test.ts`
asserts `expect(code).not.toMatch(/git\s+(?:stash|update-ref|...)/)` and
`expect(code).not.toMatch(/refs\/wip/)`. Adopting the newer file would have
shipped a red test and a banned band-aid in one commit. **Club Arena is correct
and stays as it is.**

### `.github/workflows/agent-open-pr.yml`

Club Arena's copy (4,129 bytes) is not an old version of the others (~14,000
bytes). It is a different design, landed in PR **#4189** (2026-09-11): an
unprivileged `Agent Branch Proposal` signal plus this trusted `workflow_run`
consumer that mints a short-lived **GitHub App** token and never holds a PAT.
Its companion `agent-branch-proposal.yml` was added in the same commit. The
other repositories still carry the older `create`/`push` opener with a `GH_PAT`
fallback. Converging means **they adopt this one**, not that Club Arena goes
back. **Club Arena is ahead and stays as it is.**

Both of these are now recorded in the audit itself, so the next reader inherits
the reason instead of re-deriving it or "repairing" the wrong repository.

## 4. What changed here

`.github/scripts/estate-integrity.sh`:

1. **Four outcomes, not one.** `read_shared_file` reads `gh`'s exit status and
   its body: `present`, `present but empty`, `absent` (a real 404) and
   `unreadable` (anything else) each get their own sentence. "I could not tell"
   is never folded into present, absent or empty (10.86 rule 1).
2. **Only a real variant may be ranked.** An empty file and a deleted path are
   excluded from the "most recently committed" sort, so neither can ever again
   be held up as the copy the estate should converge on.
3. **`RETIRED_PATHS`** records the two deliberate Diamond-Arena deletions with
   the PR that made them - and alarms if either file **comes back**, so the
   record cannot quietly become cover for a revert.
4. **`DELIBERATE_VARIANTS`** records Club Arena's two files with the reason.
   This does **not** suppress the drift finding - the other repos still have to
   agree with each other - it only names the variant that must not be
   "corrected".
5. **A deleted workflow is not a live one.** `gh run list` happily returns the
   last historical run of a workflow file that no longer exists, so
   Diamond-Arena read `autopilot completed/success` on every run after its own
   PR deleted the file. Section 3 now says "retired (recorded)" and claims no
   liveness for it.

Pinned by `tests/an-absent-guard-is-not-an-empty-one.law.test.ts`, whose fake
`gh` reproduces the real failure shape - a 404 printing its body to stdout and
exiting 1 - and gives the zero-byte and deleted entries the **latest** dates, so
the ranking filter is proved rather than assumed.
`tests/estate-integrity-rulesets-fail-closed.law.test.ts`'s fixture was updated
in the same commit to describe the estate as it actually is: Diamond-Arena 404s
those two paths.

Nothing was relaxed. The audit still exits 1, and the count went from 21 to
**19** solely by deleting two statements that were untrue.

## 5. Per-file ownership of what remains

Club Arena carries the most recently committed copy of nine of the eleven
drifted files, and the deliberate variant of the other two. **Every remaining
content repair is in a repository Club Arena has no authority over**
(CLAUDE.md 1.2).

| file                                    | ahead (copy to take)                                                                                                                                              | behind                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `AGENT-PLAYBOOK.md`                     | smarter-poker-commander `74cfc5e57b64` (= Club Arena's)                                                                                                           | World Hub, commander-shared, workers, Diamond-Arena, PepNationLab                                      |
| `.agents/rules/00-agent-playbook.md`    | smarter-poker-commander `0f5097be6ebd` (= Club Arena's)                                                                                                           | World Hub, commander-shared, workers, Diamond-Arena, PepNationLab                                      |
| `.github/scripts/check-token.sh`        | smarter-poker-commander `b92e3953fc85` (= Club Arena's)                                                                                                           | the other five, all at 2026-08-22                                                                      |
| `.github/scripts/queue-pr.sh`           | smarter-poker-commander `084417024a1a` (= Club Arena's)                                                                                                           | the other five, all at 2026-09-04                                                                      |
| `.github/workflows/agent-autopilot.yml` | smarter-poker-commander `ebe4e4365e95` (= Club Arena's)                                                                                                           | World Hub, commander-shared, workers, PepNationLab. Absent from Diamond-Arena **by design**            |
| `.github/workflows/agent-open-pr.yml`   | **Club Arena `84dd0d8a4ac3`** - the App-token design from #4189                                                                                                   | World Hub, commander, commander-shared, workers, PepNationLab. Absent from Diamond-Arena **by design** |
| `scripts/guard-shared-clone.sh`         | smarter-poker-commander `ab056acf01bd` (= Club Arena's)                                                                                                           | the other five, at 2026-08-23/24                                                                       |
| `scripts/check-unpushed-work.sh`        | **Club Arena `8b3e80d688c6`**                                                                                                                                     | the other five, at 2026-08-24                                                                          |
| `scripts/check-canonical-clone.sh`      | **Club Arena `28524b85dc3a`**                                                                                                                                     | the other five, at 2026-08-24                                                                          |
| `scripts/agent-workspace.sh`            | **Club Arena `67433cac5390`** (2026-09-21)                                                                                                                        | all six                                                                                                |
| `.husky/reference-transaction`          | **no single winner** - Club Arena + commander hold the preventive copy required here; World Hub holds a snapshotting copy banned here; four repos hold 2026-08-24 | see section 3                                                                                          |

Identical in all seven and needing nothing: `scripts/guard-commit-identity.sh`,
`scripts/ensure-hooks.sh`, `scripts/agent-trees-audit.sh`.

Non-content findings, all in other repos:

- **Agent Autopilot last run `completed/failure`** - commander-shared,
  smarter-poker-workers, PepNationLab. While it is red those repos queue no
  pull requests and nothing outside says so.
- **Shared file mode mismatches** (guards committed `100644` are silently
  skipped by git) - World Hub (3 files), commander-shared (8),
  smarter-poker-workers (6), Diamond-Arena (8), PepNationLab (7). Each is fixed
  in that repo with `bash scripts/ensure-hooks.sh`.

## 6. What was deliberately not done

**No issue was raised in `Smarter-Poker-Diamond-Arena` asking for the two
workflows back.** The premise that they were accidentally emptied is false: the
owning repository deleted them in its own reviewed PR and added a test to keep
them retired. Asking for a restore would be asking that repo to revert an
owner-merged decision and break its own required check - the revert loop
CLAUDE.md 10.7 describes, started from the other side. What is true is recorded
in the audit and in issue #3931 instead: Diamond-Arena is parked, has no
automatic PR opener or autopilot **by design**, and still has an active branch
ruleset with a required check, so merges there are not unguarded - they are
manual.

**No sync job, mirror cron or repair sweep was written** (10.11, 10.12). Files
agreeing across repositories is not something a scheduled job may enforce here;
the estate audit is the reader (10.86 rule 3) and the content correction belongs
to each owning repository.

**Nothing was copied into Club Arena** on the strength of a newer date. The date
orders variants; it does not certify one, and in both Club Arena cases the
newer-dated file was the wrong file.
