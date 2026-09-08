# The estate drifted because exactly one repo had a bot

2026-09-07. `Estate Integrity` was green at 14:15Z and red at 19:57Z, and I had
spent the day pushing to two of the seven repos, so the first question was
whether I had broken it. I had not, and the way that was settled is worth as
much as the fix.

## What the check said, and where it said it

`estate-integrity: 2 problem(s).` and nothing else. The detail is written to
`$GITHUB_STEP_SUMMARY` and into an issue, never to stdout, so the downloaded job
log shows every visible check passing and then a bare count. The two problems
were in issue #3498:

    .github/workflows/agent-autopilot.yml - 2 different versions across the estate
    .github/workflows/agent-open-pr.yml   - 2 different versions across the estate

Six repos on `fa8676f41e0c` / `8e7baeb2acc9`, PepNationLab alone on
`7454d0eb86d9` / `420cf0e0d915`.

## Root cause

**PepNationLab is the only repo in the estate with a `.github/dependabot.yml`,
and it declares a `github-actions` ecosystem over `directory: "/"`.**

Two files on the `SHARED_FILES` list in `.github/scripts/estate-integrity.sh`
live under `.github/workflows/`. Dependabot cannot be scoped to skip a file
inside an ecosystem's directory, so it edits those two in the one repo that has
it configured, and no other repo moves with it. **The invariant breaks by
construction, on every action release.** It is not a race and not bad luck; it
is guaranteed.

At 17:58Z PR #158 bumped `actions/checkout` 4 to 7 and
`actions/create-github-app-token` 1 to 3 in both files, and
`smarter-poker-autopilot[bot]` merged it. The estate's own autopilot is what
landed the change that broke the estate's own invariant.

## Why the fix converges DOWN, not up

The tempting read is that Dependabot was right and six repos are stale:
`agent-open-pr.yml` is on `checkout@v4` while `agent-autopilot.yml` in the same
repo is already on `v7.0.1`. So why not take the newer versions everywhere?

Because **neither bumped version had ever executed.** Both workflow runs in
PepNationLab after that merge came back `skipped`. The estate had been moved to
majors nothing had run, on the two workflows that open and merge every pull
request in all seven repos - the highest blast radius pair in the estate. A
major bump of `create-github-app-token` on the token path that opens every PR is
exactly the change that must be watched executing before it is trusted, and
rule 10.4 is "verify on real hardware, it compiles is not verification".

So PepNationLab is restored to the sha256 the other six share, and the upgrade
becomes a deliberate estate-wide change with evidence behind it. `checkout@v4`
in `agent-open-pr.yml` is worth raising on its own merits later; it is not worth
raising by accident.

## The recurrence, closed

`.github/dependabot.yml` in PepNationLab now ignores `actions/checkout` and
`actions/create-github-app-token`, with the reasoning in the file and a line
telling the next person to extend the list if a shared workflow gains an action.
`create-github-app-token` appears in no workflow of that repo's own, so that
half costs nothing; `checkout` freezes at v7, which is the current major. Every
other action there still updates on schedule.

**Residual risk, stated plainly:** this is a deny-list, and a deny-list is only
as good as its last edit. The structural fix is for autopilot to refuse to merge
any pull request that touches a `SHARED_FILES` entry unless the change is
landing in all seven repos. That is a change to `agent-autopilot.yml` itself,
which is the single highest blast radius file in the estate and must fail OPEN
the way `guard-merged-branch.sh` does. It is worth doing and it is not worth
doing at the end of a long session on top of an unrelated fix.

## The other lesson: a grep for a name matches the prose about the name

Three times today a verification grep gave a confident wrong answer, in both
directions:

| grep                                                   | what it matched                                                           | truth                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `unless on()`                                          | nothing                                                                   | Prometheus serialises it `unless on ()`; the guards were live and I reported them missing |
| `nextHourBoundary` in `MaintenanceBreak.ts` on main    | two comments describing the deleted function                              | the function was gone                                                                     |
| `padding-top: env(safe-area-inset-top)` in `index.css` | a comment saying it is deliberately absent, plus an `@supports` condition | no declaration on `body`                                                                  |
| `.lt('created_at', zombieCutoff)` in `push-health.js`  | a comment explaining its removal                                          | not in the query                                                                          |

This repo's house style is long explanatory comments naming the thing that was
removed, which is good for the next reader and actively hostile to a substring
check. **Grep for the code shape, not the name** - `private nextHourBoundary(`
and `this.nextHourBoundary()` rather than `nextHourBoundary` - or read the
lines the match came from before believing either answer. Every one of these
was caught only because the match was inspected instead of counted.
