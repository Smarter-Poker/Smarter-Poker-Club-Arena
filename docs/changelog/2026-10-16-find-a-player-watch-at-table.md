# Find A Player trimmed, and Watch At Table (2026-10-16)

Dan, with screenshots of the Find A Player popup and a Player Record showing
"At A Table":

> CLEAN UP THE "FIND A PLAYER" TOO MUCH TEXT THAT ISN'T NEEDED. AND THERE
> SHOULD BE AN "WATCH AT TABLE" BUTTON WHEN THEY ARE PLAYING TO EASILY WATCH
> THEM. 2, WHEN YOU ARE INSIDE OF PLAYER MANAGEMENT, AND THE PLAYER IS "AT A
> TABLE" THERE SHOULD BE A BUTTON TO EASILY CLICK TO BE REDIRECTED AND WATCH
> THEM.

## Find A Player

Removed: the Network Locator eyebrow, the idle "Live" pill, the field label
above the search box, the idle prompt, the relationship word (Friend / Public),
an @handle that repeats the name, the Clubs and Unions headings with a row and
status word per entry, the union code, and per live game a heading, a type
label, a details line and a gate sentence. "Authorized Account Data (1)" is
"Account Data".

A result is now: name, Playing / Online / Offline, one quiet line of clubs and
unions, a gold "Apply To Join <Club>" / "Join <Club>" word only for a club the
viewer could join that has no live game shown, and one Watch At Table control
per live game.

## Watch At Table

`src/components/club/WatchAtTableButton.tsx` prints into the approved painted
action shell (`action-primary-shell`, the same art as Join The Waiting List):
socket = Cash / MTT, eyebrow = table (and stakes, unless the name already has
them), title = Watch At Table, Return To Seat, or the one thing a non-member
must do first in gold (Apply To Join, Join Club To Watch, Request Pending,
Observers Off). The locator's click path is unchanged: access is revalidated by
`fn_get_table_watch_access` before routing to `/table/:id?observer=1`.

## Player Record

`src/components/club/MemberWatchAtTable.tsx`: when `presence.is_seated` is
true, it reads the member's open seat in this club (`table_seats`, left_at
null, waiting/running, not deleted; RLS limits it to tables the viewer can
read) and shows Watch At Table in place of the credential caption. A tap
revalidates with `fn_get_table_watch_access(table, member)` and routes to the
observer view; if the player has left, it says so and falls back to the
caption. No schema change.

## Note on the screenshots

At 03:16 UTC the locator reported Dinodollars Offline while the record said At
A Table. By 03:23 UTC he held no seat rows at all, so the disagreement could not
be reproduced. The two reads differ in one place worth knowing: the record's
seat check (`ca_club_member_detail`) does not exclude deleted tables, while the
locator does. The new record button filters deleted tables, so it never offers
a table nobody can watch.

Tests: `tests/components/FindPlayerLocator.test.tsx` (updated),
`tests/components/MemberWatchAtTable.test.tsx` (new).
