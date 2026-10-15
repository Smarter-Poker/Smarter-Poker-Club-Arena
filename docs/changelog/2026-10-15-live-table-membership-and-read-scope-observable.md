# A Membership No-Op And A Skipped Branch No Longer Look The Same

## What Was Wrong

Two separate silences cost an hour of archaeology on runs 38656420977 and
38672391424, and neither could be settled from the recorded evidence.

`ensureClubMembership` logs only when it clicks Join. When the account is
already a member it returns quietly, so "already a member" and "this branch
never ran" produced byte-identical setup logs. After the union read scope was
added in #6894, the live-table job's log still showed nothing between the Terms
acceptance and the saved session, and there was no way to tell whether the
union join had happened, been a no-op, or been skipped.

`boardFacts` had the same problem one layer down. `public.tables` carries a
RESTRICTIVE policy, so a table this account may not read comes back as no row
at all: HTTP 200, an empty array and no error. Those candidates classified
`unknown`, exactly like a board whose tournament genuinely cannot be read. The
two runs above recorded 30 and 22 indistinguishable `unknown`s while the engine
was offering healthy boards, and settling which it was took a row-by-row RLS
evaluation against production.

## The Change

Global setup now names the outcome of every membership it ensures, for the
assigned club and for the union-scope club, and says so explicitly when
`E2E_UNION_CLUB_ID` is absent.

`boardFacts` now compares the ids it asked for against the rows it got back and
names the difference: how many of the requested tables returned no row for this
account, and the first few ids. A read-scope miss and an unreadable tournament
now read differently in one line.

Neither change alters a verdict. No assertion is relaxed, no candidate becomes
selectable that was not selectable before, and a board still has to prove it is
running before a case will watch it. This is evidence only.
