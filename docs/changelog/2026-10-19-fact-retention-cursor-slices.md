# Fact-card retention commits bounded source slices

The October18 digest's overdue incident49c04e6e was the existing hourly
`prune-ca-hand-facts` operation. Its October18 bounded-source correction still
materialized200000 certificate identities and their receipt range before
selecting at most250 pending hands. On October19 it hit the120s statement
limit at09:17UTC, rolling back its cursor; the14:17 success took112.5s.

A read-only live250-identity indexed anti-join took101ms, including171 cold
blocks. The maintained retention function now scans that unit and checks a10s
work budget between units, committing useful cursor progress normally. The
original200000 scan ceiling,250 compaction ceiling, eight-day policy, original
compactor custody/refusal authority, transactional rollback and wrap remain.
There is no additional job or timeout increase. A single unexpectedly slow
slice can exceed10s; the budget is checked between slices rather than claiming
to interrupt a SQL statement. Errors still roll back and propagate.

The existing required accounting shard2 native qualification executes the new
migration. A million historical receipts with three sparse pending hands proves
all three compact, totals remain37.02, the cursor wraps, freeze is inert and
compactor failures preserve cursor. A slow compactor fixture proves the old
implementation scans200000 before yielding and the correction commits250 with
`more=true`. Local TypeScript app compilation passes. Hosted checks, exact
migration installation and post-install operation readback are required before
claiming live completion.
