# tests/a-queued-pull-request-is-not-stale.law.test.ts

Dan's 48-hour rule stays; this narrows what "unfinished" means. On 2026-09-04
the close took six finished, green pull requests - the horse-identity
programme - because they were waiting on a merge queue rather than on an
author, and recovering them cost most of a session: `main` had moved ~800
pull requests, so every branch needed a new base, a re-run against three
guards that had landed meanwhile, and a re-review. A pull request is STALE
when it needs its author (red, conflicted, nothing pushed) and QUEUED when it
needs nobody (every required check green, ahead of `main`, not a draft).
`stale.yml` labels the second kind `queued` before it closes anything and
exempts that label; the label is recomputed every run and removed the moment
a pull request stops qualifying, so it cannot become armour. The law drives
the script against a stub GitHub API and proves all three outcomes for real -
including that a 403 on check-runs leaves the labels untouched rather than
reading as "not green", which is the trap in 10.86 - and that the workflow
grants `checks: read`, without which the whole exemption is inert while still
looking like it works.
