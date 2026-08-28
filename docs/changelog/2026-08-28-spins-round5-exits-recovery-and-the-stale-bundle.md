# 2026-08-28 — Spins round 5: exits, recovery, honest money, and the stale bundle

A full line-by-line audit of the spin system (client and server, in parallel)
after rounds 1–4 had fixed why spins would not start. Round 5 is what that
audit found. Several of these produce symptoms _indistinguishable_ from the
bugs already fixed, which is why they are worth naming individually.

## The one that hid every other fix

**The service worker posts `SHELL_UPDATED` and nothing has ever listened.**

`public/sw-bus.js` serves the app shell cache-first — a deliberate, well
argued trade that removes an HTML round trip from every entry — and its own
safety argument is: _"clients are told, so the app can refresh itself at a
moment of its own choosing rather than mid-hand (see SHELL_UPDATED)."_ The
worker holds up its end and posts the message. No handler existed anywhere in
`src/`, so "the app can refresh itself" described code that did not exist, and
a cached shell — plus the exact hashed chunks it names, all pinned cache-first
— was served for the life of the session.

Observed on production while verifying round 4: `build-info.json` reported
ca*sha `4474ef1b` while that very tab was executing `TablePage-CUTgsJU*-v6.js`
from an older build. **Every fix shipped in between was invisible to that
session.** This is the most likely reason a player reports a bug that has
already been fixed and deployed.

`src/hooks/useShellUpdateGate.ts` is the missing half. It applies the update
only when the moment is boring by construction — not at a table, tab visible,
after a short settle during which both remain true — so a player at a table
keeps the old bundle until they leave, which is exactly what the worker
promised. Two independent anti-loop guards (a `sessionStorage` cooldown and a
once-per-mount disarm), and it degrades to "no worse than before" if storage
is blocked.

## Money and dead ends (client)

1. **The discoverable exit could only fail.** The menu's Leave Table and the
   felt's leave button both route to `tableService.leaveTable`, which starts
   by asking the ENGINE to release the seat — and a pre-start Spin/Heads-Up
   has no engine game by design. So it always failed with "your chips were not
   moved, please try again", forever. Had it succeeded it would have been
   worse: the tournament branch only writes `sitting_out` — no refund, no
   `left_at`, so the seat still counts toward the fill — while the page books
   a full-buy-in loss. Both doors now reach `fn_leave_seat_and_refund`, the
   seat-first exit ("IF THEY LEAVE THE SEAT THEY ARE FULLY REFUNDED").

2. **The Leave Seat button was hidden from the player who had just paid.**
   `commitSeatFirstBuyIn` sets `heroSeat` and nothing else; `players[]` catches
   up only on the roster round-trip. In that window the "no hero in players"
   branch matched first and rendered a bare **"Spectating"** — with no way to
   release the seat. If the roster read then failed, permanent for the session.

3. **`pendingSeat` was never cleared on the seat-first paths.** Only the cash
   buy-in modal ever cleared it. Left set after a refund it does two visible
   wrongs: `canSit` turns **every seat into an inert EMPTY plate**, and
   `isHeroReservedSeat` keeps the refunded chair reading **YOUR SEAT** while
   the database has it vacated. Both exits clear it now.

4. **Refund refusals were swallowed.** The buy-in path was hardened for this
   on 2026-08-25 ("the next unknown refusal is a searchable event instead of a
   dead end"); the refund half never was. `not_seated`, `table_not_found`, an
   RLS denial and a 500 all collapsed into one generic toast. Now reported.

5. **Seat-first could only ever turn OFF.** It is written once, in the
   mount effect, and the only other writer clears it. One unlucky read — RLS,
   network, or a table that exists a heartbeat before its tournament flips to
   REGISTERING — left it null for the whole session: inert seats and a
   "Spectating" footer at a table plainly selling seats, recoverable only by a
   manual reload. The realtime channel that would notice is itself gated on
   seat-first being truthy, so it could only ever watch the door close. A
   bounded recovery (a few reads, then it stops for good either way) is the
   other direction.

6. **A missing cap read as a heads-up.** `max_players ?? 0` with `<= 2` called
   every uncapped tournament a two-seat game — the same mistake
   `classifyTournament` was explicitly fixed for.

7. **An unknown wallet balance read as an empty one.** `accountBalance` began
   at `0` and is written only on a successful read, so one transient failure
   left a funded player at a permanently disabled button reading **"Not Enough
   Chips"** on a page with no refresh path. It is `number | null` now; the RPC
   remains the authority that actually refuses an underfunded entry.

8. **The game-lobby panel sent 6-max and 9-max SNGs down the seat-first
   path**, where the RPC answers `not_a_seat_first_game` — a CTA whose only
   effect was to relocate the player, with no reachable entry path to a
   multi-seat SNG at all. Only heads-up (2 seats) is seat-first, matching
   every other surface and the database.

9. `already_seated` returns no counts, so the re-seat toast said **"Waiting
   For 0 More Players"**. It falls back to the known cap and live roster.

## Money and deadlocks (server)

10. **The spin paid-gate silently disabled itself.** It discarded the error on
    its roster read; on failure the roster is empty, the debits query falls to
    its sentinel UUID, and the gate **passes having verified zero payments** —
    reopening exactly the hole it exists to close. The adjacent read already
    treated unreadable evidence as a stand-down; these two had opposite
    failure policies.

11. **House rake and reserve contribution were computed from a counter the
    codebase refuses to trust.** `p_seats` (and the settle call) read
    `current_players` — of which GameServer says _"it drifts badly: the live
    lobby was carrying spins reading 3/3 with two seats actually sold, and
    others reading 0/3 with three sold."_ `collected = seats × buy_in`, so a
    drifted counter mis-books the rake and the pool contribution while the
    prize stays correct — the two halves of the pool identity disagreeing by
    the drift. A spin has three seats by definition.

12. **The paid-gate removed registrations but left the seats**, and fill is
    counted from seat rows. The game still read 3/3 sold with 2 registrations,
    so: the fast lane force-starts it, `start()` fails the field check above
    the gate and stands down, `topUpWithHorses` sees no shortfall, and the
    stall watchdog is gated on `paid < seats` and stays silent. A 5-second
    loop, forever, with money taken and one `console.log` as the only trace.
    The seats are released and the counters resynced now.

13. **`creditSeatStacks` discarded its read error**, and its failure answer
    was byte-identical to "nothing to do". It is the only thing that turns a
    spin's zero-chip reservations into real stacks, so a failure across that
    window leaves every seat at 0 and the dealing loop parked at
    `idle_not_enough_players` until the process restarts.

14. **Seats split across duplicate live tables counted as the max, not the
    sum.** These games are created with two `waiting` tables ~0.6s apart, so a
    3-seat spin can land 2+1 — and then the main gate, the fast lane _and_ the
    stall watchdog are all blind to it simultaneously. Three paid seats, no
    game, no telemetry. Counted in full now (the primary table still decides
    where to seat), with a warning when a split is seen.

15. **Two more silent zeroes in the seat-first horse fill**, the exact shape
    this file's own post-mortem blames for a 20-hour unnoticed outage.

## Pinned

`tests/unit/seatFirstExitAndRecovery.test.ts` — both exits reach the refund
RPC and clear every claim, the footer cannot shadow a paid seat, seat-first
can turn back on, a missing cap is not a heads-up, an unknown balance is not
an empty one, and only heads-up SNGs are seat-first in the panel.

## Deliberately not done

- Removal of the legacy client Hydra horse path on **cash** tables (browser
  writes to `table_seats`, fabricated 100bb display stacks). It can no longer
  touch a tournament; ripping it out of cash games is its own change.
- `spin_chips` / `spin_button` are emitted by the engine with no client
  handler (beats 2 and 3 of the reveal). The engine still holds the deal for
  animations nobody plays. Worth building the animations, not deleting the
  events — a feature gap, not a bug, and Dan's call.
- `SPIN_FREQ_DENOMINATOR` is stale by 99 against the table's own summed
  frequency; latent (no server consumer) but wrong.
