# 2026-09-03 - The orphan watchdog can finally see a conflicted pull request

**Dan:** "fix any and all issues so nothing gets orphaned."

`orphan-work-watchdog.sh` exists because of Dan's 2026-09-01 instruction that no
work is ever lost, orphaned or unpublished. Its own header names three ways work
gets stranded. **Case 2 had never once fired**, and it is the case that matters
most.

## What was wrong

The pass asked `gh pr list` for `mergeable` and compared it to `CONFLICTING`.
GitHub does not compute mergeability for a **list** query - it computes it
lazily, when a single pull request is fetched - so the field comes back
`UNKNOWN` (REST: `null`) for every row, every time.

Measured on this repo, 2026-09-03:

| Query | Result |
| --- | --- |
| `GET /pulls?state=open` (100 PRs) | `mergeable_state: null` for **all 100** |
| `GET /pulls/2548` | `dirty` - conflicted and stranded since 2026-09-02 |
| `GET /pulls/2842`, `/2838` | `dirty` - both since that morning |

So the watchdog's last run reported **428 stranded branches and zero stranded
pull requests**. Running the corrected pass against the live repo, probing only
the 25 oldest, found **31**: 25 conflicted and 6 stale drafts, including the
engine restart programme phase 3, the notifications popup, the ToS gate and
Diamond phase 2. Finished work, one rebase from shipping, invisible to the
thing built to see it.

A second defect compounded it. There is one detail cap for GitHub's 65,536-char
issue body (`MAX_DETAIL=40`), the branch pass runs first, and this repo has 428
stranded branches - most of them April `sentry-autofix/*` and August `rescue/*`.
Even if case 2 had fired, its findings were appended after the branches and
truncated away.

## What changed

1. **Mergeability is resolved per pull request**, which is what forces GitHub to
   compute it. One API call per open PR past the cutoff, bounded by
   `MAX_PR_PROBES` (default 80) so this pass can never be the reason the job is
   killed the way the branch walk was on 2026-09-02. A `null` answer means
   GitHub is still thinking, so it is retried once after a short pause rather
   than read as "fine". Only `dirty` counts as stranded: `blocked`, `behind`,
   `unstable` and `clean` are autopilot's job.
2. **Drafts skip the probe** - autopilot ignores a draft whatever its
   mergeability, so no API call is needed to know it is stuck.
3. **The two findings streams no longer share a queue.** Pull requests are
   listed first and in full; branches take the detail room that is left, with a
   floor of five. The issue body now leads with the actionable half and states
   both counts.
4. **`ci-marker/` is exempt.** That namespace is not work: it is where
   `agent-open-pr.yml` force-pushes its own result log as an orphan commit. It
   is ahead of main by construction, forever, and reporting it crowded out
   findings a human would act on.

## Verification

The corrected pull-request pass was run against the live repository before this
was committed - the 31 findings above are its real output, not a projection.
`bash -n` clean.
