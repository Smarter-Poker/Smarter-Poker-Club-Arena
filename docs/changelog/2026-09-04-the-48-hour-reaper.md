# Nothing unfinished sits longer than 48 hours

## What the queue looked like

165 open pull requests in Club Arena on 2026-09-04:

| time since last update | PRs    |
| ---------------------- | ------ |
| under 1 hour           | 9      |
| 1-6 hours              | 5      |
| 6-24 hours             | 27     |
| 1-3 days               | 30     |
| **over 3 days**        | **94** |

World Hub, same agents and the same rules: **6 open, median age 12 minutes,
zero conflicts.** That contrast is the whole diagnosis. Conflicts were not
concentrated on any hot file - main takes ~125 merges a week, so a branch that
sits for a day is racing forty of them. A pull request that merges in ten
minutes cannot conflict with anything.

## Why the existing sweep could not keep up

`stale.yml` ran **weekly**, marked a PR stale after **14 days** and closed it
**7 days** after that. Against roughly 24 new pull requests a day, a
three-week fuse that lights once a week is not a sweep, it is a gesture.

## The rule

Dan, 2026-09-04: _"I WILL NEVER LEAVE ANYTHING UNFINISHED FOR MORE THAN 48
HOURS. ANYTHING OLDER THEN 48 HOURS IS TRASH."_

So: labelled `stale` at **24 hours**, closed at **48**. Swept every six hours
rather than weekly, so the label actually appears while the work is still
fresh in someone's mind, and there is a full day of visible warning before
anything closes. `pinned` and `do-not-close` still exempt a PR entirely.

## Nothing is destroyed

Closing a pull request does **not** delete its branch. The commits stay on
`refs/heads/<branch>` and a new PR from that branch merges in minutes instead
of fighting days of drift. Anything in this estate that later prunes branches
archives them to `refs/archive/` first.

## The one-off cleanup that came with it

The 165 were triaged by content, not by age, because Dan hands work off - a
branch can be dead precisely because a SECOND agent finished the job:

- **48 SUPERSEDED** - `git cherry` matched every commit as already upstream by
  **patch id**, so the work had landed under a different SHA. Closed with the
  evidence in each comment. Three of them were only 20 hours old, so an
  age-only rule would have kept work that was already shipped.
- **53 OLD-WORK** - over 48h with genuinely unmerged content. Closed under the
  rule above, each archived first, each comment saying plainly that this is
  housekeeping and not a judgement on the work.
- **3 kept by name** at Dan's instruction: #2564, #2559, #2534 - substantial
  and only 50-53 hours old.

165 open became 64.
