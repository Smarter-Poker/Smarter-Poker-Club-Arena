# 2026-09-05 - The community sub pages, the union gate, and two pieces of broken chrome

Dan, five items: do the `/community` and `/friends` sub pages, hide `/unions`
from everyone except him, fix the broken headers, and fix the distorted footer.

---

## 4 + 5 first, because they were on every page

### The rail drew a three-sided box

Both section rails (`ArenaSectionRail`, `ClubOperationsRail`) set
`overflow: hidden` and `padding: 8px <horizontal> 0`. Measured on production:
the chassis's bottom edge and the rail's clipping boundary were **the same y to
the pixel**. Everything the chassis paints at or below that line was cut away -
the bottom border, both 8px clip-path corner bevels, the `0 8px 24px` drop
shadow, and the blue `::after` underline with its 10px glow. What reached the
player was a box with a top, a left and a right, and then nothing.

The fix is the bottom padding the rail always needed to show its own edge.
Verified against the live signed-in DOM at 1204x900: room below the chassis
**0px -> 8px**.

### The footer was distorted at every width, in both directions

`--bottom-nav-height: clamp(44px, 13.72vw, 132px)`.

Measured from the approved asset (`club-arena-footer-v2.webp`): a 1916x256
canvas whose opaque frame is the rect x=25 y=14 **1866x230**, aspect
**8.113:1**. An undistorted full-bleed footer is therefore `100 / 8.113 =
12.326vw` tall. The constant said 13.72vw, so:

- below the ceiling the art was stretched **11.3% too tall**;
- above it - every desktop - the 132px cap squashed it the other way, measured
  **11.7%** at a 1204px viewport where the frame's own shape asks for 147.4px.

The 132px ceiling is not the bug and has not changed; Dan approved it and the
263px ceiling before it "covered the lobby". The bug is that only the HEIGHT
stopped growing. `.artwork` now takes its shape from the asset
(`aspect-ratio: 1866 / 230`) and stops its WIDTH at the same moment
(132 x 8.113 = 1070.9px), centring the bar. Proportional and full-bleed through
phones and tablets, a centred bar of the approved height on desktop, correct on
both sides of the ceiling.

Verified against the live signed-in DOM at 1204x900: frame aspect
**9.0614 -> 8.1146** against a true 8.113, distortion **11.69% -> 0.02%**,
footer height still **132px**.

Pinned by `tests/the-section-rail-shows-its-own-edge.law.test.ts` (rail) and
the existing `tests/footer-clearance.test.ts`, whose `.artwork` pin was MOVED
to the new mechanism in this commit rather than weakened: it now states the
ratio, so a future edit cannot reintroduce a free-floating height.

---

## 3. The union directory is hidden to everyone except Dan

The allowlist already existed. `public.union_creators` was created 2026-09-04
for "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS EXCEPT FOR
MINE" and holds exactly one row. Rather than invent a second list that can
drift out of step, `fn_can_i_operate_the_union_network()` reads the same table -
creating a union and operating its directory are the same audience.

Hiding a page is all three of these or it is none of them:

- the route (`UnionNetworkGuard` on `/unions`, fails closed while checking and
  on any error);
- the section rail (no Unions entry, and no Directory entry on the deeper union
  rails, without an explicit yes);
- the Community Center card (not built, not merely hidden).

`UnionCreationGuard` used to bounce a refusal to `/unions`; that would now
bounce again, so it goes to `/community`.

**What this deliberately does not do:** narrow the `unions_public_browse` RLS
policy. TablePage, CashierPage, ChipMintModal, BadBeatJackpotPage, HomePage,
UnionGamesPage, SettlementPage and the tournament Unions tab all read `unions`
for a name or an owner, several of them on money paths. Dan asked for the page
to be hidden; the route and the navigation are where a page lives.

---

## 2. /friends

### 3,990 friendships pointed at accounts that do not exist

`public.friendships` had **no foreign key on either column** - the only social
table in this schema without one. `social_connections`, `union_admins`,
`page_followers` and thirty others all carry
`REFERENCES auth.users(id) ON DELETE CASCADE`. So every account deletion left
its edges behind, and 3,990 of 17,440 rows (23%) referenced uuids with no
`auth.users` row and no `profiles` row. Those ids appear nowhere else on the
platform - zero club memberships, seats, chip transactions or tournament
entries - so they are not horses (10.5: a horse has all three).

Dan's account rendered **"3743 Relationships Need Profile Repair"** above a
list of rows that can never resolve, each with Message and Challenge suppressed
and only Remove offered, one at a time, forever. 37 live accounts carried at
least one.

Deleted (probed first in a transaction that aborted itself: before 17,440,
dangling 3,990, after 13,450, still dangling 0) and both foreign keys added, so
it cannot recur. **Live now: 0 unresolvable rows, no banner.**

### The page was losing 36 real friends to its own pagination

Found while checking that count. The page paged `friendships` with
`.order('created_at', desc).range(from, to)` at 500 rows. `created_at` is not
unique here: 1,309 accepted rows carry **485 distinct timestamps, largest tie
group 214**. Tied rows have no defined order among themselves, so Postgres may
resolve a tie differently for each OFFSET window - rows get duplicated into one
page and skipped from another.

Simulated against production with the exact windows the client uses:

| ordering                   | rows fetched | distinct  | lost   |
| -------------------------- | ------------ | --------- | ------ |
| `created_at desc`          | 1,309        | **1,273** | **36** |
| `created_at desc, id desc` | 1,309        | **1,309** | 0      |

The live page showed **1,274** friends against a true 1,309, and a different
set went missing on each load with nothing reporting it. Every paged read here
now ends its ordering with `id`.

`fetchAllRows`'s header already warned "ORDER YOUR QUERY"; it now also says
ORDER IT BY SOMETHING UNIQUE, because `assertOrdered` can see that an order
exists and not that it is total. Pinned by
`tests/a-complete-read-is-ordered-by-something-unique.law.test.ts`.

### The tab panels were being painted as floating dialogs

`.friends-panel` is in the `:where(...)` popup-shell inventory in
`src/styles/metallic-popups.css`, which is imported globally and applies with
`!important`. That entry is correct for the `FriendsList` drawer it was written
for. FriendsPage uses the same name for its four inline tab panels, so the
friends list rendered as a **1114 x 3835 pixel "popup"** - 16px radius, 2px
bright top border, inset blue rail, `0 34px 80px` drop shadow - nested inside a
panel that already had its own border. Renamed to `.friends-tabpanel`; the page
owns its own class names.

### Five more defects, each one shipped

- **A five-second timer faked a finished load.** A mount-only unconditional
  `setTimeout(() => setLoading(false), 5000)` replaced the skeleton with the
  "Build Your Poker Circle" empty state while the queries were still in flight -
  and `retryFetch` alone can spend 1s + 2s of backoff. It told a person with
  1,309 friends that they had none.
- **A failed load looked identical to an empty account** - same empty state,
  same "Find Players" button. There is now an error state that says the
  connections could not be reached and offers Try Again.
- **Accounts with zero friends refetched forever.** `hasDataRef` was set to
  `nextFriends.length > 0`, and the reload guard only skips when it is true, so
  every presence `sync` re-ran all three paged queries. It now means "this page
  has an answer".
- **Realtime saw only INSERT** and toasted "New friend request received!" for
  every one - including the row written when somebody accepts you. An UPDATE or
  DELETE never arrived at all, so the list kept showing people who had removed
  you. Now `event: '*'`, and only a genuinely pending row announces itself.
- **Remove deleted one of two rows.** Every friendship is stored reciprocally;
  the list dedupes to one entry, so `removeTarget.id` was whichever row was seen
  first and the mirror survived - the friend came back on the next load. It now
  deletes the pair.
- Plus: the activity feed built one unchunked `.in('user_id', ...)` over the
  complete friends array - 1,309 uuids, a ~48KB query string - so it failed for
  exactly the accounts with the most activity, reporting only "Live friend
  activity could not be reached". Chunked at 100, same `.limit(10)` contract.
- And "1 Relationship Need Profile Repair" now reads "Needs".

---

## 1. /community

Seven static links and no numbers - nothing on the page knew whether a
connection request was waiting. `fn_community_overview()` supplies friends,
online, requests, challenges, clubs and (for the allowlisted account only)
unions in one server-side call: 156ms measured, against six client round trips
and a profile pull to count presence in the browser.

Two rules it follows. A count that could not be read renders as a dash, never
as zero - telling somebody with 1,309 friends they have none is exactly the
failure /friends shipped. And requests and challenges become "Waiting For You"
rows only when they are non-zero, so the section disappears when there is
nothing to do.

**Deliberately absent: unread messages.** `/messages` is a redirect out of Club
Arena into the World Hub messenger, whose conversation tables this app does not
own. A number from the wrong table is worse than no number.

---

## Still open

`/friends` still fetches every friendship and every profile before it renders,
then slices client-side at 40. That is 1,309 rows plus 14 chunked profile
requests on the founder's account. A server-side `fn_friends_page(...)` is the
right fix and is a larger piece of work than this pull request; it is named
here rather than half-done. Nothing above depends on it.
