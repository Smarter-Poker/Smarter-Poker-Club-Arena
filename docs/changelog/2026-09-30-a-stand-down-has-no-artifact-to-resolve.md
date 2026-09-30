# A Stand-Down Has No Artifact To Resolve

2026-09-30, found the same hour the two harness fixes in
[`2026-09-30-an-absent-subject-is-not-a-broken-one.md`](./2026-09-30-an-absent-subject-is-not-a-broken-one.md)
were merged and published.

`publish-club-arena` cancels in progress when a newer merge arrives. A run
cancelled while still QUEUED produces zero jobs and zero artifacts. The
publication gate already knows that: "a publisher that never published is not a
defect on production" stands the certificate down without writing `should_run`,
so every downstream job skips and the run occupies no production lock.

The very next step did not know it. `Resolve the exact client artifact selected
by this publisher` was conditioned only on `github.event_name == 'workflow_run'`,
so it ran anyway, asked a run that had produced nothing for its client bundle,
and failed:

```
[production-e2e-provenance] Expected one publisher client artifact, received 0.
```

Run **36763398494**, whose source publisher **36762652944** was cancelled while
queued. The gate stood down correctly and then went red one line later, on a
run where nothing at all had gone wrong. That is CLAUDE.md 10.86 rule 4: a fix
that leaves the same trap one level up has not landed.

**The fix is the condition the step should always have carried.** The artifact
is resolved only when there is a publication to certify. Nothing else moves: a
publisher that really published reaches the step unchanged and its artifact is
still bound to the exact run, trigger SHA and repository id; a renamed or
missing `publish-to-origin` job is still a hard error in the step above; and
the stand-down still writes no `should_run`, so the browser jobs still skip
rather than certifying a release that was never installed.
