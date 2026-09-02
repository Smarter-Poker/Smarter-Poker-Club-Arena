# 13 discarded auth requests per page load, down to one a minute

Follow-on from the 2026-08-28 load measurement. With the wallet stampede fixed
(`wallet_transactions` 20 -> 4, `profiles` 11 -> 6, `club_members` 8 -> 2,
`agents` 6 -> 0, total Supabase calls 85 -> 66), the largest remaining
duplicate on a tournament page was **`/auth/v1/user`, 13 calls, up to 492 ms
each, every one discarded**.

## Where they came from

`getAuthUser()` in `src/lib/supabase.ts` is called by nearly every component
that needs to know who is signed in. Its fast path reads the session from
localStorage (instant, correct) and then fired a fire-and-forget
`supabase.auth.getUser()` as a background token refresh — **on every call**.
Thirteen components, thirteen network requests, thirteen results thrown away,
all competing for the same connections as the queries the page actually needed.

The client is constructed with `autoRefreshToken: true`, so the SDK already
refreshes on its own timer. That call was only ever a nudge.

## The fix

`nudgeTokenRefresh()`: at most one refresh a minute, and concurrent nudges
collapse onto a single in-flight promise so the first burst on a cold page
makes one request instead of one per component. The refresh still happens; it
just stops happening thirteen times a second.

One nudge a minute is a nudge. Thirteen in a second is a stampede.

## Still open, measured, not guessed

`training_user_achievements` fires **12 times** on the same page, from the
activity-feed components (`FriendActivityFeed`, `PlayerActivityFeed`) rather
than from `AchievementService`. It looks like one query per friend — an N+1 in
a feed widget — but it is a different component tree from anything touched
here, and it is not something to change blind at the end of a long pass. It is
written down here so the next person starts from the measurement rather than
from scratch.

## Checks

`npx tsc --noEmit` exit 0. `npx vitest run tests/` — 553 files, 8,498 tests,
all passing.
