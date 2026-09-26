# server/src/tournament/aBreakExclusionParksTheTable.law.test.ts

A Table Excluded By Its Own Break Waits For The Break, Not The Dealer: on
2026-09-26 the balancer requested a break of table 715aee14 (tournament
21f9013b, `f06_operations` row cbf00eca, `park_requested`) at 03:41:11.98,
0.7 s into hand #14633520, so the one-second park probe missed. The engine
parked at the hand boundary (03:42:03), no scheduler slot reached that manager
within fifteen seconds, and the unclaimed-park expiry released the pause.
While a break row names a table as its source the database refuses every hand
there (`fn_f06_hand_number_state` answers `source_excluded`), so the released
dealer failed nine hand-number allocations until the zombie watchdog stopped
it at 03:45:39 with four players seated; they stayed stranded until the next
release adopted the event and moved them at 04:16:14. This pins three facts
with a real ServerTableEngine and the real TournamentManager break path: a
park backed by a durable break stays parked past the expiry and past the
two-minute pause safety timeout, never asks for a hand, and its park edge wakes
the Manager's sweep, which claims it and begins the break; a restart with the
row still open and no custody starts the table movement-only and the break
still begins; and a dealer that meets `source_excluded` with nothing armed
reports `f06_source_excluded_by_break`, is fenced for the break, wakes the
sweep, and the break begins.
