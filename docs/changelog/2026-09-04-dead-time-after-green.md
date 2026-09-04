# Ten minutes of nothing happening, after everything had already passed

## The measurement

Time between the LAST required check going green and the merge landing, on
this session's own pull requests:

| PR    | dead time   |
| ----- | ----------- |
| #2912 | **9.6 min** |
| #2918 | 3.6 min     |
| #2919 | 1.8 min     |
| #2914 | 1.9 min     |

Nothing is running during that window. Nothing is being decided. Every gate has
already passed.

## The cause, which this repo had already written down

`agent-open-pr.yml` opens the pull request. `agent-autopilot.yml` triggers on
`pull_request: [opened, reopened, ready_for_review]` and arms squash
auto-merge.

**A pull request created with `GITHUB_TOKEN` does not fire `pull_request`
workflows.** GitHub blocks that so a workflow cannot trigger itself. So
autopilot's `opened` job never runs for these, and the pull request waits for
the next `*/30` sweep - an average of **fifteen minutes**.

The file already said so, in its own log line:

    opened with GITHUB_TOKEN (sweep must rescue events)

It falls back `app-token || GH_PAT || GITHUB_TOKEN`, so whether the event fires
at all depends on which credential happens to be available in that run. That is
why the dead time varies from 1.8 to 9.6 minutes rather than being constant.

## The change

`agent-open-pr` now arms squash auto-merge itself, in the same run, immediately
after opening. The dependency on the event disappears: GitHub merges the moment
the required checks pass, which is what auto-merge is for.

The `*/30` sweep stays as the net for anything this misses - a draft, a token
without the scope, a PR opened by some other route.

**No gate is weakened.** Auto-merge still waits for every required check, and a
red check still never merges. The only thing removed is the wait between "all
checks green" and "somebody notices".

## Where Club Arena's time actually goes

For the record, because this was the third guess and only the measurement
settled it:

| stage                      | measured                      |
| -------------------------- | ----------------------------- |
| push -> PR                 | 0.1-7.8 min                   |
| PR -> checks done          | 0.5-30.6 min                  |
| **checks green -> merged** | **1.8-9.6 min (this change)** |
| merge -> live (publish)    | 12.6-22.1 min                 |

The publish half is addressed separately: the tree-hash skip for already-proven
client tests, and `estate-ci-eu-3`, which took Club Arena from 6 runners to 12
and dropped `estate-ci-eu-1` from load 41 to 4.85.

World Hub does not have this shape at all - it merges and Vercel builds once, in
2m33s to 4m27s.
