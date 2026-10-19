# A verified club page stays mounted while its access is re-checked

2026-10-19

## What went wrong

Post-Deploy E2E failed three times in one morning on the production Shark
Club Players page (runs 39197316124, 39207700170, 39212954477). Each time the
probe counted one aborted `ca_club_members_page` read. The request timelines
in the failure reports all had the same shape:

| read | starts | what started it      |
| ---- | ------ | -------------------- |
| 1    | ~1.9 s | the page opening     |
| 2    | ~3.2 s | nothing the user did |
| 3    | ~4.5 s | nothing the user did |

Reads 2 and 3 each carried a fresh summary request as well, which only a new
instance of the page makes (the summary is otherwise reused for 30 seconds).
The page was being thrown away and built again. Whichever read was still in
flight when the viewer clicked a player, typed a search or changed a filter
was the one that got aborted, which is why the failing case moved between
the Player Record case and the search/filter case from run to run.

## The cause

`ClubWorkspaceContext` re-verifies club access on a CLUB_UPDATED,
MEMBER_ROLE_CHANGED or GAME_MANAGEMENT_ACCESS_CHANGED bus event, when the auth
hook finishes its own hydration, and when the browser comes back online.
Every one of those re-checks began with `setStatus('loading')`. The member
guard renders a skeleton for `loading`, so every guarded club page - the
roster, the cashier, every operations surface - was unmounted and mounted
again for a check that almost always returned the same answer. A player lost
the page's scroll, drafts and in-flight reads each time.

What fired it on production: the E2E account is a member of three clubs, and
during a Post-Deploy E2E run its `club_members` row in each of them was
updated within five seconds (read from the rows: 11:39:45, 11:39:48 and
11:39:50 UTC on 2026-10-19, during run 39245711984). `PostgresSyncHooks`
emits CLUB_UPDATED the first time it sees each of those rows, and the
workspace re-checked on every one of them, whichever club it named - so a page
in one club was rebuilt twice by row updates in the other two.

The banner-save regression (`tests/unit/clubBannerSaveContinuity.test.tsx`)
had pinned the page being hidden while a CLUB_UPDATED re-check was pending.
It now pins the page staying mounted during the re-check and the revocation
landing when the answer arrives, which is the part that test exists for.

## The fix

The workspace remembers which club and account it has verified as a member.
A re-check of that same pair keeps the verified answer on screen until the
new answer arrives. A cold load (no verified answer yet for this club and
account) still shows `loading`. A revocation still lands immediately when the
re-check answers `denied`, and the server's own RPCs keep refusing an
unauthorised read in the meantime, exactly as they did before.

Pinned by
`tests/unit/aVerifiedClubPageStaysMountedWhileItsAccessIsRechecked.test.tsx`,
which failed on the old code (`['ready', 'loading', 'ready']`) for both the
bus re-check and the auth-hydration case.

The production E2E's zero-aborts assertion is unchanged. It was right: the
aborted read was a real wasted query against the roster's most expensive RPC.
