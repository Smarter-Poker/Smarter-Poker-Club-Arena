# Club Arena main "losing commits" — what was actually happening

**Date:** 2026-08-21
**Trigger:** I told Dan main had eaten my work three times and he said "FIX IT THEN."

## The claim I made, and where it was wrong

> "Club Arena main ate my work three times today — the XP purge, the statements
> work, and the presettlement UI were each pushed, then overwritten by a
> force-push or a PR rebased from an older base."

Investigated properly, that is half wrong:

| Evidence | Result |
| --- | --- |
| `PushEvent` with `payload.forced==true` on `refs/heads/main` | **none** in the visible event window |
| merge commits between `abc3656e5` and my re-land | **none** |
| commits touching `UnionStatementsPage.tsx` in that range (`git log -m`) | only my own re-land |
| `abc3656e5` ancestor of main | **yes** |
| `7547a6e45` ancestor of main | **yes** |
| `ae8a7ee94` ancestor of main | no — but its *content* is on main, which is the signature of a **rebase or cherry-pick**, not a deletion |

So two of the three were never lost. One had its SHA rewritten, content intact.

The presettlement "loss" has a mundane explanation I can point at: the commit
message contained backticks, the shell executed them (`presettled: command not
found`), the `&&` chain broke, the rebase conflicted, and the push carried the
*old* tip. I checked, saw my change absent from main, and read that as somebody
else force-pushing over me. It was my own command failing quietly.

That same bug bit again while shipping this very fix: `git push … | tail -3 &&
echo PUSH_OK` printed PUSH_OK on a **rejected** push, because the pipeline's
exit status is `tail`'s. Verify by exit code, never by an echo downstream of a
pipe.

**But a rewind did happen today.** `main-rewind-guard.yml`'s own header records
main rewound to `ada755ab3`, dropping four commits that were live in
production. So the underlying risk is real; I attached it to the wrong commits.

## The real defect

Nothing watched. A genuine regression and a bad diagnosis produced *identical*
evidence — a grep returning 0 — and both cost an hour. The repo had guards for
the *mechanism* (rewind, silent revert) but nothing for the *outcome*: is the
behaviour still there, and is production running something main has lost?

## What was added

### 1. `tests/shipped-invariants.test.ts`

Ten live behaviours that are expensive to lose (role grant matrix,
`ca_club_my_downline` on both cashier screens, statement settle +
presettlement, player breakdown, the `.action-panel` CSS scoping,
`betChipOffsetPx`) and three files deleted on purpose that must not return
(`TipDealer.tsx`, `TipPrompt.tsx`, `tipdealer.ts`).

Anchored on RPC names and paths, not phrasing, so refactors don't churn it.
Asserts its own list is non-empty so it cannot be emptied to go green.

**Verified by mutation, not by watching it pass.** Renaming
`ca_club_my_downline` in `CashierPage.tsx` and restoring `TipPrompt.tsx` each
turned it red with a message naming the lost behaviour.

`build-for-world-hub.yml` runs `npx vitest run tests/` before the bundle
ships, so a regression stops the publish rather than being noticed later.

### 2. Production-drift detection in `main-rewind-guard.yml`

The workflow's issue body already told a human to compare production's `ca_sha`
against main by hand. Nobody does. That comparison is the only thing separating
"a commit was dropped" from "a live feature is about to be deleted by the next
sync" — and drift also occurs with no rewind at all (starved sync, failed
build), so the step runs on **every** push, not only after a rewind.

Fetches `build-info.json` with a cache-buster — the CDN serves a stale copy for
minutes, which would make a drifted production look in sync — then fails if
production's sha is not an ancestor of main, listing what is live but missing.

Confirmed executing in CI, not merely green:

```
production ca_sha: 5ec78200a68c13d784cb90a3ff743e9c1773e036
main tip:          9994d35c2751cb5efdd8932db7fa8c1e0c398c03
In sync: main is 13 commit(s) ahead of production, and contains it.
```

## A cancellation that looks like the old bug and is not

`build-for-world-hub.yml` runs show `cancelled` on intermediate commits even
after `cancel-in-progress: false`. That is correct. GitHub cancels a *pending*
run when a newer one joins the group; `false` only protects the **running**
one. With a 4-minute build and pushes every minute or two, the pending slot
churns to the newest commit and publishes that — which is the stated intent.
Do not "fix" this by changing the concurrency group.

## Not fixed — needs Dan

Branch protection on `main`. Protection is the only thing that *prevents* a
rewind; everything above only makes one impossible to miss. Blocked by two
things an agent cannot route around:

- the PAT is fine-grained without `administration` scope — `403 Resource not
  accessible by personal access token` on the protection endpoint (World Hub
  returns the same);
- the repo is private, so rulesets need GitHub Pro.

Handoff: `.agent/handoffs/2026-08-21-club-arena-branch-protection.md`.

Also stale: World Hub's `CLAUDE.md` §11.4 lists a
`branch-protection-watchdog.yml`. No such workflow exists on main in either
repo. Anyone relying on that line is relying on nothing.
