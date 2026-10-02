# tests/a-person-can-review-a-diamond-incident.law.test.ts

Platform staff can read and answer Diamond incidents, and only platform staff.
Four doors (`fn_ca_diamond_incident_board`, `_trail`, `_review`,
`_resolve_family`) ask `fn_is_platform_admin()` themselves, are granted to
`authenticated` and never to `anon`, and refuse every other signed-in account
by name; the review and family doors also refuse a call with no person behind
it. Every act (acknowledge, comment, resolve with a written reason of at least
10 characters, reopen with one, close a whole rule family in one act) names
its reviewer on the row and in `ca_diamond_incident_events`, an append-only
trail with no foreign key, so it outlives the row when the prune deletes it.

A person's answer and the watches never fight. The health and trial balance
watches close only open rows (every closing UPDATE carries `resolved_at IS
NULL`), write "auto: ..." as they always did, and never name a person, so a
row a person resolved is never closed a second time. A trigger on
`ca_diamond_incidents` skips any update outside the review doors that would
rewrite or re-open a person's resolution, or close a row a person reopened;
it skips rather than raises, because a raise would abort a watch's whole
tick. The migration changes no function it did not create, reviews no
incident and opens no switch.
