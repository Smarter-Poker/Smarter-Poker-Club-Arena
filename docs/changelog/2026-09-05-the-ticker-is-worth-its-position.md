# The live message rail is worth the pixels it owns

2026-09-05. Dan, after a screenshot of the club lobby: _"DO A DEEP DIVE ON THE
TICKER, FULL AUDIT ON IT AND EVERYTHING INSIDE OF IT... HOW IT CAN BE ENHANCED,
IMPROVED, UPGRADED OR OPTIMIZED. AS WELL AS HOW TO MAKE IT BETTER AND MORE
'PREMIUM FEELING'."_ Then: _"GO AHEAD AND FULLY BUILD ALL OF THESE."_

The audit found seventeen things. Fifteen are fixed here in full, one in part
(section 15), and the seventeenth is recorded below as a correction to a promise
the code could never keep.

The engineering under this bar was better than the bar. Somebody thought hard
about when an overlay is real, why a horse's buy-in counts, and why a bare
`<header>` selector was a loose cannon. Then eight message sources, an operator
colour system and a management panel were bolted onto a 34px strip designed for
one sentence, and **every defect below lived in the render** - the one part of
a 951-line component that no test had ever mounted.

## 1. The flag was painted cyan on cyan

`TournamentStartingTicker.tsx:875` set the chip's TEXT colour to the club
accent. `TournamentStartingTicker.css:38` filled the chip's BACKGROUND with a
gradient built from that same default `#00d4ff`.

**Contrast ratio 1.06:1**, on the loudest word the room can say. It is the
first thing you see in Dan's screenshot and the hardest thing on the bar to
read. `validateTickerContrast` enforces 4.5:1 on the message and had never
looked at the flag.

The accent is a **background** now, and the ink is derived from its luminance
in `tickerTheme.ts`. That is a stronger guarantee than another validator, which
a direct RPC call can walk around and which would have had to reject colours
clubs have already saved:

> For any six-digit hex, the better of black and white clears 4.5:1. The worst
> case is a fill at relative luminance 0.179, where both land on 4.58:1.

`tests/unit/tickerTheme.test.ts` sweeps the colour cube and asserts the floor
rather than trusting that paragraph - and it earned its keep on the first run.
The tinted inks the design wanted (`#04121f` / `#f5fbff`) do **not** hold the
floor: a mid-blue like `#2d78d2` tops out at 4.26:1 against them. `readableInk`
prefers the tint and falls back to the pure ends when the tint cannot clear AA.

## 2. The designed gradient had never rendered, once

`.mtt-ticker` declared `linear-gradient(90deg, #0b1a33, #123163, #0b1a33)` from
the first commit. The render set `background` inline from the managed colour,
and an inline single value beats a stylesheet gradient every time. The bar has
been flat since ticker management shipped.

`railBackground()` builds the gradient FROM the managed colour and the render
sets the whole thing inline, so operator branding survives and the depth is
real. The stylesheet declares no background at all now - a second source of
truth that can never win is worse than none.

## 3. Dead rail

The message was duplicated exactly twice and animated to `translateX(-50%)`.
Seamless only while two copies are wider than the strip. On the 2530px track in
the screenshot, with a ~390px announcement, both copies were on screen at once
and ~1,750px of empty bar swept past behind them.

`marqueeMetrics.ts` measures instead. Two answers, and which one applies is
geometry:

- **the message fits** - centre it and hold still. Motion should mean "there is
  more to read"; a lone sentence gliding past an empty bar is a widget, not an
  announcement. This is what the screenshot's geometry now does.
- **it does not fit** - repeat until the content covers the travel plus the
  whole track, and travel exactly one measured copy width.

## 4. The speed was a duration, so the pace was accidental

`--ticker-speed: 24s` for one countdown and 24s for eight joined operational
messages. The same operator setting produced a crawl on one bar and a blur on
the next.

Pace is px/sec now. **`speed_seconds` keeps its stored name, range (8..60) and
direction**, so there is no migration and no operator has to be re-educated;
`pxPerSecondFor` reinterprets it, and the default 24 lands on 55 px/sec.

## 5. "It pauses on hover" was a comment, and can never be a rule

The file header promised a hover pause from day one. No `animation-play-state`
was ever written. It is not written now either: `no-hover-effects.law.test.ts`
is binding, and its reasoning applies to this strip more than to most - most of
this room plays on a phone, where a hover pause is a readability feature most
players can never reach. **The first draft of this branch added the hover rules
and the law caught them.**

Readability is delivered where everyone can get it instead: the rail holds
still whenever the message fits, the pace is normalised per pixel, and
`:focus-within` still pauses it for keyboard users - which the law preserves
deliberately. The false promise is deleted rather than left quietly broken.

The same law killed the first draft's hover-revealed "REGISTER" label, which
was precisely the anti-pattern the law was written about. It is painted at all
times above 768px and hidden below it, where the whole strip is the tap target.

## 6. Every countdown on the bar is live now

"Registration Closes In 4:12" was baked into a string at POLL time; only the
starting-soon line was recomposed by the one-second tick. For most of the time
it was on screen the number was wrong, by up to thirty seconds, on the one
message whose entire value is the number.

Items carry `deadlineMs` and the token `{clock}`, substituted at render. Every
source that has a clock shows a live one.

## 7. A close button that did not close

Two of the eight sources persisted a dismissal. The other six filtered a React
state array and the next poll put the message straight back. One store now,
every source, keyed by item id, with a TTL - because a dismissal is "not now",
not "never", and the two old keys had no expiry at all. Both legacy keys are
imported on first read so nobody is re-nagged across the deploy.

## 8. The bar shouted over screen readers

`role="status" aria-live="polite"` around text containing a 1Hz countdown.
Every tick queued another full announcement. The strip is not a live region any
more; the scrolling copy is `aria-hidden`; one visually-hidden polite region
carries the news rounded to the minute, and says "Press To Register", which
nothing on the old bar did.

## 9. "Buy-In 9" on an event called $11

`buy_in_amount` is the prize side; the fee is a separate column. The bar quoted
the smaller number. It uses `formatBuyInShort` now - the same helper the lobby
card and the register button use, so all three quote the same total.

No currency symbol was added, deliberately: `money()` prints bare whole chips
everywhere else in this app and a lone "$" on the ticker would be the only one
on the platform.

## 10. The separator is an object, not a character

Fields were joined with `·`, messages with `•`, and operator-typed tournament
names contain `•` too - one arrived in Dan's screenshot. A drawn pip cannot be
typed into a club's tournament name.

## 11. A broadcast tool that could not broadcast

`TICKER_SETTINGS_CHANGED` is emitted from realtime only on
`GameManagementPage`, and `game_management_events` RLS admits only operators, so
**a player can never be subscribed to it**. A player refetched managed settings
when `location.pathname` changed, and a seated player does not change route for
hours. Publishing an urgent SERVICE NOTICE reached nobody who was playing -
which is the entire purpose of the maintenance and custom sources.

The settings RPC is member-gated, cheap and already authorised for every player
in the club, so it rides the existing 30-second tick. A club's change reaches
every seated player inside half a minute, with **no DDL, no new read surface
and no new RLS policy to get wrong**. The bus event still gives the operator's
own tab an instant update.

## 12. A club pays only for what it switched on

Five queries fired every 30 seconds per seated player. The two operational ones

- a 17-column 80-row read of `tournaments` and a 10-row read of `tables` - were
  unconditional, though three of the four sources they feed are OFF by default.
  Each query is gated on its own source flag now.

## 13. Club scope was cached for the life of the tab

`clubIdsRef` was never invalidated. Join a club and its events stayed silent
until a hard reload; switch accounts and the rail stayed scoped to the previous
user's clubs. It carries the user it was built for, has a five-minute floor, and
is cleared on `AUTH_STATE_CHANGED` and `CLUB_JOINED`.

## 14. Settings failed open

A failed RPC returned `DEFAULT_TICKER_SETTINGS`, which carries `enabled: true`.
A club that had deliberately switched the rail OFF got it back - with a
different mix of sources - during any transient failure. The last authoritative
snapshot per scope is kept and returned instead; defaults are for a cold start.

## 15. Priority was an if/else ladder, and nothing expired (PART OF THIS IS LEFT)

Severity and expiry are fields on the item now. **One ordering change, stated:**
SERVICE NOTICE and CLUB UPDATE moved above the three low-value operational
sources, so a club can be heard over "New PLO Table Open". Everything else keeps
the order it had - an overlay still takes the bar from a countdown, a countdown
still takes it from anything operational, and REGISTRATION CLOSING stays above
the operator's own lines because it only ever appears inside a five-minute
window.

Every item now expires on its own terms, so a finished countdown leaves the bar
whether or not a poll has run.

**NOT built, and both are decisions rather than work.** `starts_at` / `ends_at`
on an operator's own messages needs a column on `game_ticker_settings`, and
per-source click telemetry needs somewhere for the events to land. Until the
second one exists, nobody can answer "is the guarantees source worth its
pixels" with a number, which was the point of asking.

## 16. 951 lines doing eight jobs, and no render test

Split into `tickerTheme`, `tickerMessages`, `tickerDismissals`,
`marqueeMetrics`, `useTopChromeOffset`, `useTickerMarquee` and `TickerRail`.
What is left in the container is the part that genuinely needs the network.

**Five new test files, 92 assertions.** `TickerRail.test.tsx` is the first test
that has ever mounted this bar. Three of the defects above were found by tests
written for this pass rather than by reading: the contrast floor (§1), the
static-vs-scroll geometry (§3), and a close button that answered to the same
accessible name as the bar itself.

## 17. NOT FIXED: the union scope the header promised

The file header said the scope was "a club the player is a member of, **or in a
union one of those clubs belongs to**". The code has never done that, and it
cannot from the client: `tournaments_select` is
`is_club_member(club_id, auth.uid())`, so a sibling club's rows come back empty
however many ids the query passes. Widening the `.in()` list would have looked
like coverage and delivered none.

Reaching a union sibling's event needs either a membership-widening RLS change
or a SECURITY DEFINER feed function. Which of those is right is a product and
security decision, not an implementation detail. **The header is corrected so
the contract and the code agree**, which is the part that was actually broken,
and `tests/unit/tickerReachAndLoad.test.ts` pins the correction.

## Verified

- `npx tsc --noEmit` - clean
- `npx eslint` on every touched file - 0 errors
- `npm run check:title-case`, `npm run check:painted-text` - OK
- `npm run build` - clean, 7.61s
- Ticker suite: `tickerTheme` 18, `tickerMessages` 32, `tickerDismissals` 14,
  `tickerMarqueeMetrics` 14, `TickerRail` 27, `tickerReachAndLoad` 14, plus the
  four pre-existing ticker files - all green.
- Four existing tests pinned behaviour through source text that this pass moved.
  All four were re-anchored to the same guarantee in the same commit, per
  CLAUDE.md section 5 rule 8: `unionSurfacesAreSealed` (the click target),
  `gameManagementArchitecture` (operator controls reach the rail),
  `noFixedSizeSourceWindows` (my own new test used byte windows),
  `no-hover-effects` (the hover draft).

## A note on the suite, corrected

While this branch was in flight I measured `npx vitest run` on the `origin/main`
this branch was cut from (`68f353fa1`) failing 8 to 11 law files with a
different random subset every run, and diagnosed it:
`tests/a-migration-version-is-reserved-not-guessed.law.test.ts` created and
deleted real files inside `supabase/migrations/` while seven other law tests
were reading that directory in parallel.

**It was fixed on main before I could raise it**, in `22f972b89`, by the same
reading of the same evidence - the script takes a `RESERVE_MIGRATION_DIR`
override, the fixtures go to `.tmp-migration-reservation-probe`, and a
`beforeEach` sweep heals a tree that already carries the debris. Verified on
current main here: **1,013 files, 13,983 tests, exit 0, zero ENOENT.**

Recorded rather than deleted, because this branch is cut from before that
commit: if these law files go red on a merge preview, that is why, and the
answer is the merge, not a second fix.
