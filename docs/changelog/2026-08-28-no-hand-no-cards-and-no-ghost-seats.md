# 2026-08-28 — No hand, no cards; and a finished game keeps no seats

Fourth and final pass on Dan's spin report. The first three fixed why spins
did not work (#1602 live pre-start roster + engine fast start, #1618 the
client horse loader's invented stack, #1642 seat-first lobby routing). This
one closes the two gaps that sweep found and deliberately left open, so
nothing is carried forward.

## 1. A table with no hand no longer shows hands

Seated players at a Spin that is still selling its third seat were each drawn
holding a fan of face-down cards, before a single card had been dealt. The
villain fan renders for any seat whose status is `active` — which every
seated player is from the moment they sit — so the cards were furniture, and
the table read as mid-hand while it was plainly waiting for a player.

`SeatSlot` grows `handInPlay`, defaulted TRUE so every other caller (SimPage)
is unchanged, and TablePage feeds it `isHandInProgress || handNumber > 0`.

The gate is deliberately permissive and that is the point: delivered cards,
an all-in, a deal animating, a fold or a muck flying out all still draw
regardless of it. The animation law (CLAUDE.md 10.6) says every animation
plays every time it is owed — a gate that could swallow a deal or a muck
would be a regression of that law wearing a bug fix's clothes. Pinned by
`tests/unit/prestartTableHasNoHand.test.ts`, including each escape hatch.

## 2. A finished game keeps no live seats

Found while auditing the seat-first money paths: **26 live seat rows on
COMPLETED/CANCELLED tournaments holding 191,176 chips**, thirteen of them
spins. Every one was stamped between 0.216s and 2.805s **after** its
tournament's own `ended_at`.

So `trg_clear_seats_on_game_end` (20260823280000) is not broken — it fires
once, at the transition, and cannot see a seat written a second later. Several
writers can land in that window (the table-balancer's seat reuse/insert, the
late-registration sweep, a final-stack persist), and fixing them one at a time
leaves the next one free to do it again.

`20260828g_no_live_seat_on_a_finished_game.sql` (applied to production via the
Supabase MCP) repairs the INVARIANT instead: a BEFORE INSERT OR UPDATE trigger
on `table_seats` stamps `left_at` on any row that would be live on a finished
game. It **never refuses a write** — a guard that can refuse a seat write can
strand a player mid-hand (rule 11.5's lesson, and why `ca_seat_stack_exits`
reports rather than blocks) — the write succeeds, the seat is simply not live.
On INSERT the exit-watch never fires for it, which is correct: nothing exited.

Nobody was short a payout — prize money comes from `tournament_payouts`, never
from a seat row — but `table_seats.stack` is one of the two pools
`fn_club_chip_circulation` counts as "on the felt", and the reconciliation
surface added on 2026-08-25 exists so that number means something.

**Verified in production, before and after:**

|                               | before | after            |
| ----------------------------- | ------ | ---------------- |
| live seats on finished games  | 26     | **0**            |
| seats on RUNNING tournaments  | 208    | 205 (live churn) |
| seats on REGISTERING          | 32     | 32               |
| cash-table seats              | 93     | 93               |
| `fn_unaccounted_seat_exits()` | 0      | 0                |

The migration carries its own post-apply assertions, including one that fails
if no seated player remains on any RUNNING tournament — the blast radius of a
too-wide predicate here is "every player at every running table stands up", so
it is asserted rather than assumed.

## Still open, and still Dan's call

Full removal of the client-side Hydra horse path on CASH tables (browser-side
`table_seats` INSERT/DELETE, fabricated 100bb display stacks, client
TURN_CHANGE horse actions). The server fleet owns horses everywhere now and
this module is pre-migration legacy; #1642 fenced it out of tournaments at the
service level, so it can no longer touch a spin. Ripping it out of cash games
touches live money flows and deserves its own change with its own
verification.
