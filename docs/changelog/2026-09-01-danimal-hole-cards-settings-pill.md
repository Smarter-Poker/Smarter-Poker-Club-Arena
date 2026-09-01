# 2026-09-01 - Hole cards, the duplicate 9h, the card toggles, and the pill

Four reports from Danimal in one sitting. Three of them turned out to be the
same table; one was an artwork file.

Shipped as PR #2444 (`fix/danimal-hole-cards-settings-pill`), on main as
`9b22210a0`.

## 1. Hole cards not arriving at all

`trim_realtime_publication_hot_unsubscribed` dropped `table_hole_cards` from
`supabase_realtime` at 19:02 UTC on 2026-08-31, on the finding that the table
had "ZERO subscribers."

It has exactly one, and it is the only hole-card delivery path on the platform.
The engine never sends hole cards over the game socket, and every public
snapshot scrubs them, so a player who does not receive the realtime row does
not receive cards. The audit missed the subscriber because the table name is
passed as a `table:` prop into a wrapper hook rather than written literally at a
`postgres_changes` call site, so a grep over the source found nothing.

Danimal was seated 20:18-20:38 UTC, entirely inside the outage. Every hand in
that window fell back to the 0s/2s/5s recovery poll, which is why cards arrived
late, arrived randomly, or did not arrive. The Crazy Pineapple report that the
discarded card "does not disappear" is the same outage seen from a different
seat.

The publication was restored live before the PR. Migration
`20260901000200_restore_table_hole_cards_realtime_publication.sql` makes it
durable: `REPLICA IDENTITY FULL` plus publication membership, both asserted, so
a future trim fails loudly rather than silently blinding every player at every
table.

The subscription had no error handler either, so the failure said nothing for
four hours - no toast, no telemetry, no forced fallback. It reports now, and it
forces the recovery fetch immediately instead of waiting out the poll interval.
Had that been wired, the incident would have self-reported on the first table
load.

## 2. J9h in hand, Kd 9h Qd on the flop

The engine dealt the hand correctly. The client was showing an expired one.

The hero-card hold is fail-open on an unknown hand number by design: a snapshot
with no hero cards means "no news", not "you have none", and the hero seeing
nothing is the worse bug. The cost of failing open is exactly this - a frame
that cannot identify its hand carries the previous hand's cards into the next
one, and the new board then contradicts them. The recovery poll had the same
gap: its stale-row guard cannot fire until the client has seen a `HAND_STARTED`.

Both closed, and the invariant underneath them is now enforced wherever it can
be checked: a hole card that is also on the board is proof the hand expired, so
it is dropped and re-fetched, whatever path produced it. Covers double and
triple boards and both suit spellings the app carries. Pinned by
`tests/unit/heroCardsNeverCollideWithBoard.law.test.ts`.

## 3. Card Slide and Card Squeeze reverting on every login

`useUserTableSettings`'s bus-event handler was missing the "a live edit outranks
a stale broadcast" guard that its own load path (`locallyTouchedRef`) and its
sister hook both enforce, and it mutated `settingsRef` inside a React updater.

Out of sync, this is worse than a flicker. `toggleSetting` computes the next
value from `settingsRef.current`, not from rendered state, so a stale broadcast
that puts `true` back into the ref while the switch renders OFF makes the user's
next tap write `false`. The switch does not move and the default is persisted
again. Tap it ten times and nothing happens, which is the report verbatim.

The `in` check that let a payload named `constructor` write a function into
settings is back-ported from the sister hook in the same pass.

Recorded honestly: this one is a strong diagnosis rather than a reproduced one.
The other three were confirmed.

## 4. The pill behind the 4-square button

Not CSS. `.tile-toggle-btn` has painted `background: transparent` all along.

The plate is inside the artwork. The source render is 1254x1254, RGB, no alpha
channel: a dark rounded plate with the four screens sitting in the middle at
roughly 46% of its width, so `object-fit: contain` in the 40px button faithfully
painted the plate too. Its sibling assets (hamburger, add-screen) are
transparent cutouts, which is why this was the only button wearing one.

Drawn inline instead, the same approach `TableTabBar` already uses for its "+".
If the icon is ever re-exported with a transparent background it goes back to
being an `<img>` in one line; the retired const is documented at its old site.

## Also in the same PR

Main was red on `Client Unit Tests` when this work reached the gate.
`engine-watchdog.sh` had grown a `GRACE_MIN` deadline in #2446 and the pin
beside it asked for the line that reports it, but the quiet path only ever
printed the restart-window reason. The two landed together and disagreed, and
every pull request in the repo failed until someone noticed. Fixed at the
script, not at the pin, because the pin asks for something real: when
`GRACE_DEADLINE` is the later of the two, the restart window has already opened
and the engine has simply not caught up. A reader of a quiet run could not tell
that apart from waiting on a window that has not come round yet.

## Not fixed, worth a ticket

- Hole cards are delivered by writing to Postgres and waiting for a realtime
  echo: roughly 110k WAL writes per stats window, which is what tempted the
  trim in the first place. Sending them as a private frame on the socket the
  player already holds would fix the cost and give a real mid-hand reconnect
  replay.
- `insert_hole_cards` takes `p_hand_number integer` while the column is
  `bigint` on a sequence now at about 4.03M.
