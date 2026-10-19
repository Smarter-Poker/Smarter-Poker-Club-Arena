# The Players roster stops re-reading itself on every hand

Since #7398 (2026-10-19 02:08 UTC) the post-deploy browser check failed on every run: one roster `ca_club_members_page` read (sometimes with its `summary`) was aborted under a navigation or a search/filter change.

Cause, read from the failing timelines and the code: the private `club-roster:<club>` topic signals on every funded hand, seat, fee, wallet and presence change in the club, so a playing club like Shark Club signals it about once a second. `ClubMembersPage` treated every signal, and the topic's first `SUBSCRIBED`, as a structural change: a full re-read of the loaded window plus the totals 1.2 s later. So the page re-read itself roughly every 1.5 s for as long as the club played. That reload loop also switched the live status line to "Verifying The Live Roster" and set `aria-busy` on each pass, and it left a read in flight under almost every click. When a click navigated away, the in-flight read was aborted.

Fix (`src/pages/ClubMembersPage.tsx`):

- The first join of the roster topic no longer re-reads. It opens beside the initial read, as the membership and audit lanes already do. Only a rejoin after a dropped feed owes a catch-up.
- A record signal owes one re-read, no sooner than `LIVE_RECORD_REFRESH_MS` (15 s) after the previous roster read. Any roster read issued after the signal pays that debt. If a read is already in flight, the owed read waits behind it and does not abort it. Structural changes (joins, roles, status, audit), focus, reconnect and the UTC rollover keep their prompt 1.2 s path.

Tests: `tests/unit/clubRosterReadOwnership.test.tsx` has two new cases. One reproduces the production stream: before the fix there were 4 reads in 4 s, and after it there is 1. The other proves that a newer read settles a pending record change. Three #7398 cases that pinned the 1.2 s record cadence and the first-join re-read now pin the bounded cadence and a real rejoin. No database, engine or money change.
