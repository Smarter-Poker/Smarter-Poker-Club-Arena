# 2026-08-28 — Reopen the seat-first front door

**Symptom (Dan, 2026-08-28):** tapping any seat on a Spin/Heads-Up table and
confirming the buy-in showed "Could Not Take That Seat, Please Try Again".
Every attempt, every table.

**Root cause:** the 2026-08-27 money-path audit added a seat-first guard to
`fn_register_for_tournament` (refuse registration into spin/sng — a direct
registration debits the player for a seat that is never allocated). Correct
rule, wrong door: `fn_take_seat_and_buy_in`, the one legitimate seat-first
entry path, registers the player by calling that same function internally. The
guard refused its own internal caller, so the RPC answered HTTP 200 with
`{ok:false, reason:'seat_first_variant'}` — a reason the client's toast
mapping does not know — and every human seat purchase failed silently into the
generic toast. Verified in production: zero human seat-first joins between the
guard landing (02:35 UTC) and the fix.

**Second regression, same guard:** it blocked `variant IN ('spin','sng')` —
ALL sngs. Only heads-up (max_players <= 2) sngs are seat-first; 6-max and
9-max SNGs register through the lobby. They were left with NO entry path:
registration refused (`seat_first_variant`), seat path refused
(`not_a_seat_first_game`).

**Fix (migration `20260828_reopen_the_seat_first_front_door.sql`, applied to
production via Supabase MCP):**

1. `fn_register_for_tournament` grows `p_seat_first_internal boolean DEFAULT
false`. The guard fires only when false, and its predicate is now the
   canonical seat-first test (`variant = 'spin' OR max_players <= 2`),
   matching `fn_take_seat_and_buy_in` and `fn_sync_seat_first_player_count`.
   The old 1-arg function is DROPPED (an overload beside a defaulted twin is
   PGRST203-ambiguous); grants restated. Note: this project's ALTER DEFAULT
   PRIVILEGES hands `anon` a direct EXECUTE grant on every new function —
   revoking PUBLIC alone leaves anon in. The migration's own post-assertion
   caught that on the first apply; the revoke now names both.
2. `fn_take_seat_and_buy_in` passes `true`.

**Verified** (probes inside rolled-back transactions, per rule 11.5):
seat purchase as Dan's real account returns `ok:true, cost:20,
seat_reserved:true`; direct lobby registration into a spin still returns
`seat_first_variant`. Cash-game `atomic_table_buyin` was never broken
(10.9k successful buy-ins in 24h; its 400s are the four-table-limit guard).

**Client hardening (this PR):** an `ok:false` reason that no toast branch
recognizes is now sent to error reporting with the raw reason string
(`TablePage.seat_first_buy_in_refused`) before the generic toast shows, so
the next unknown refusal is a searchable event instead of a day-long silent
outage.
