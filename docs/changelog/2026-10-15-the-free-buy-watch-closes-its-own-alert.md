# The Free Buy Watch Closes Its Own Alert

## What Was Wrong

`TournamentRecurringService.auditFreeBuyBoardOnce` raises
`TournamentRecurring.freeBuyAudit` when the Free Buy board is wrong, and
nothing ever resolved it. A clean audit only logged "all correct now", and only
when the same engine process had raised the alert, so every episode stayed open
after the board was right again:

- `112bf723` (raised 2026-09-11) stayed open 24 days until migration
  `20261005113407` closed it by hand.
- `f2c43ab2` (raised 2026-10-13 18:01, "Midway Union published no Midday Free
  Buy", caused by the scoped launch floor park that #6885 turned into a
  60-minute lease) was still open on 2026-10-15, although the board had
  published every slot again since 2026-10-14 23:06.

## The Fix

`server/src/services/freeBuyAuditAlert.ts`: `closeFreeBuyBoardAlert` resolves
every open row of this source. The watch calls it on every clean audit, read
from the database rather than from process memory, so an engine restart between
the raise and the clean read cannot strand the row. An unreadable board still
returns before the audit, so it is never read as a correct one.

## Pinned By

`server/src/services/freeBuyAuditAlert.test.ts`: the exact update (source,
open rows only, resolution text), a database error is thrown rather than read
as closed, and the watch's clean branch calls the close before its log.
