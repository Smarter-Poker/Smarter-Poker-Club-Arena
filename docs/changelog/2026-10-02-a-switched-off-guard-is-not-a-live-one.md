# A switched-off guard is not a live one

2026-10-02. `Estate Integrity` was red on `main` with **19 problems** (run
37062781308, main `8e44c785309662`). Three of them were false in every clause,
and they were false for the same reason the previous repair in this file was
written: a workflow that cannot run keeps reporting its last run for ever.
After this, the count is **16**, the audit still exits 1, and nothing was
relaxed.

## 1. The three findings that were not true

Each of these stood on every run for sixteen days:

> **commander-shared** - Agent Autopilot's last run is `completed/failure`.
> While it is red, pull requests stop being queued and the failure is silent
> from the outside.

with the same sentence for `smarter-poker-workers` and `PepNationLab`. Measured
2026-10-02 against the live API:

| repo                                             | last autopilot run     | workflow state      | state set at         |
| ------------------------------------------------ | ---------------------- | ------------------- | -------------------- |
| commander-shared                                 | 2026-09-16T04:35:16Z F | `disabled_manually` | 2026-09-16T05:38:57Z |
| smarter-poker-workers                            | 2026-09-16T04:06:18Z F | `disabled_manually` | 2026-09-16T05:28:55Z |
| PepNationLab                                     | 2026-09-16T05:24:02Z F | `disabled_manually` | 2026-09-16T05:39:06Z |
| Smarter-Poker-Club-Arena / World Hub / commander | success                | `active`            | -                    |

All three were switched off about an hour **after** the red run, within eleven
minutes of each other. That is one deliberate, coordinated retirement, not three
silent failures - and the September 17 owner instruction then wrote it down:
retired autopilot "remain[s] inactive" and is a prerequisite for nothing
(CLAUDE.md 1.1, 1.2.5, 10.8 rule 3). So the red run is not what stopped that
queue, nothing is waiting on it, and there was nothing to ask three other
repositories to repair. The report was sending readers after a non-defect in
repos Club Arena has no authority over (CLAUDE.md 1.2).

## 2. It is the same trap, one level up

On 2026-09-23 this script learned that **a deleted workflow is not a live one**:
`gh run list` happily returns the last historical run of a file that no longer
exists, so Diamond-Arena read `autopilot completed/success` for days after its
own PR #64 deleted the workflow. The repair was correct and it stopped exactly
there - at deletion. A workflow that is merely **switched off** reports its last
run in precisely the same way, and nothing read the state.

CLAUDE.md 10.86 rule 4, verbatim: "A fix that leaves the same trap one level up
has not landed. When you fix something, ask what the next person will reach for,
and check that it works."

## 3. What changed

`.github/scripts/estate-integrity.sh`, section 3 only. The workflow's **state**
is now read before any run conclusion is allowed to mean anything, and the
answers stay separate rather than collapsing into on/off:

- `active` - judged on its last run exactly as before, including Club Arena's
  own. Nothing here is softer for the home repo.
- `disabled_manually` - GitHub records that at the moment a person does it, so
  it is evidence read rather than assumed. A note, naming the state, claiming no
  liveness. No problem is raised, because there is no repair.
- `disabled_inactivity` - **nobody chose that.** GitHub switches a scheduled
  workflow off by itself after 60 idle days, which is drift, so it is raised.
- absent, with no `RETIRED_PATHS` record - section 2 already raises the missing
  shared file with the digest table that says which repos have it; saying it
  twice teaches people to skim. Section 3 notes it and claims no liveness.
- the state could not be read, or reads as something this audit does not
  recognise - **COULD NOT TELL**, its own sentence, never folded into on, off or
  green (10.86 rule 1). A 403 prints its body on stdout, which is how the
  original zero-byte bug got in; the state read checks the exit status first.

The surviving red-autopilot sentence now opens "Agent Autopilot **is enabled**
and its last run is", so the claim carries the fact it depends on.

## 4. Pinned

`tests/a-switched-off-guard-is-not-a-live-one.law.test.ts`, registered at
`docs/laws.d/tests-a-switched-off-guard-is-not-a-live-one.md`. Its fake `gh`
gives every repo a **red last run** and a different state, so every pass has to
come from the state read and not from the conclusion. It runs the real `jq` over
real workflow-list JSON carrying a decoy entry with the opposite state, because
picking the wrong workflow out of that list would read something else's state
and still look right. The two existing estate fixtures answer the new endpoint
in the same commit.

## 5. The 16 that remain, and whose they are

Every one is in a repository Club Arena has no authority over (CLAUDE.md 1.2).
Nothing here is Club Arena's content to change.

**11 content drifts.** Club Arena holds the most recently committed copy of
`AGENT-PLAYBOOK.md` (`975463192714`) and `scripts/agent-workspace.sh`
(`6427bc19f727`); `smarter-poker-commander` holds a copy identical to Club
Arena's for `.agents/rules/00-agent-playbook.md`, `.github/scripts/check-token.sh`,
`.github/scripts/queue-pr.sh`, `.github/workflows/agent-autopilot.yml`,
`scripts/guard-shared-clone.sh`, `scripts/check-unpushed-work.sh` and
`scripts/check-canonical-clone.sh`. The two remaining are Club Arena's recorded
deliberate variants and must not be "synced": `.github/workflows/agent-open-pr.yml`
(the split-privilege App-token design from PR #4189) and `.husky/reference-transaction`
(preventive on purpose; the newer World Hub copy writes rescue refs and adds a
bypass variable, both of which CLAUDE.md 10.12 and 12 rule 3 forbid here, and
`tests/unit/resetGuardCannotSaveTheWorktree.test.ts` fails on them).

**5 file-mode mismatches** - World Hub (3 files), commander-shared (8),
smarter-poker-workers (6), Diamond-Arena (8), PepNationLab (7). Fixed in each
repo with `bash scripts/ensure-hooks.sh`. The per-file table is in issue #3931,
which the audit rewrites every run.

## 6. What was deliberately not done

**No sync job, mirror cron or repair sweep** (CLAUDE.md 10.11, 10.12). Seven
repositories agreeing is not something a scheduled job may enforce from here;
the audit is the reader (10.86 rule 3) and each correction belongs to the
repository that owns the file.

**Nothing was pushed into another repository, and no autopilot was re-enabled.**
Switching a workflow back on in a repo Club Arena does not own, to make this
audit quieter, would be reaching into somebody else's decision - the shape of
the revert loop CLAUDE.md 10.7 describes.

**The check was not weakened.** The count fell by exactly the three statements
that were untrue; the audit raises every remaining drift and still fails.
