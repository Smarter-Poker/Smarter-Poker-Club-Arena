# Two board rows: a spliced guard, and a departure that waited a hand

2026-09-21. Closing the two drift-board rows that were not blocked on the
engine. One needed an owner for a guard redefinition; the other needed somebody
to actually read whether a critical alert had cost a player anything. It had
not, and the figure is 0.00.

## 718898db - `fn_ca_guard_defs_watch`, info, 2026-09-21 03:25Z

**The condition.** `fn_club_members_ledger_writer` - the trigger that journals
every move of `club_members.chip_balance` - changed from `e7cae5f2` to
`d9b0429e` (history 14204 -> 18625) with nobody declaring it. The watcher did
what it exists to do: moved the baseline itself and opened a notice.

**Why it was harder than the usual case, twice over.**

1. _The ref was stale, not absent._ `ca_guard_defs.declared_ref` was NOT NULL.
   It still named `20260917230925`, declared on 2026-09-18 by `20260918014359`.
   `fn_ca_guard_defs_watch` moves `def_hash` and `updated_at` and never clears
   `declared_ref`, so a ref survives a redefinition it does not own and reads
   exactly like a current one. Only `declared_at` - three days older than the
   baseline it appeared to vouch for - gave it away. Same shape as the
   `fn_poker_diamond_tournament_unregister` case in `20260921022420`.

2. _The owning migration contains no `CREATE OR REPLACE` for it._
   `20260921030445_rakeback_payouts_carry_their_document_and_run_identity`
   (03:04:45Z, inside the 02:25-03:25 window the 03:25 notice covers) is
   SOURCE SURGERY: it reads `pg_get_functiondef`, splices a rakeback refusal
   block in after a named needle, and `EXECUTE`s the result. So the live
   `prosrc` appears verbatim nowhere in the migration text, and the usual
   substring proof is unavailable.

**The proof is arithmetic instead, and it is stronger.** Applying that
migration's own documented edit - its needle plus its 1,313-character `$r$`
fragment, both read out of the INSTALLED text rather than copied - to the
predecessor baseline reproduces the live definition exactly,
md5 `d9b0429e6c88b7a2dc4e732edab6ed10`, with nothing left over. A substring
match says "this migration could have written this". Reconstructing the whole
body says "this migration wrote ALL of it and no other edit survives", which is
what ownership actually means. It is also the only migration in the entire
installed history carrying either needle.

**Declared by** `20260921035446_declare_the_installed_rakeback_journal_writer_guard`.
It carries NO DDL, so the break-window event triggers do not apply and it
reloads no schema cache; it asserts installed-history digest, live definition
md5, owner, ACL, trigger binding and the stale `declared_ref` PRE-STATE before
it writes, and it reads the needle and fragment out of production rather than
duplicating them, so it cannot drift from the text it vouches for. Probed first
in a rolled-back transaction (CLAUDE.md 11.5) - the probe passed every
assertion and left nothing behind.

## 8221713d - `postHandTasks.leave_pending_failed`, critical, 14 occurrences

**What `leave_pending` is.** The cash-game post-hand step that cashes departing
seats out through `atomic_seat_cashout_locked` and lands announced seat moves.
It is money-critical, which is why a throw raises a critical alert.

**What it means that it threw while later steps continued.** Less than it
sounds. Only `table_unlock` runs after it, and that moves no chips. More
importantly **a refusal KEEPS the seat** - the departing player's stack stays
on the felt, nothing is destroyed - and the step's first act at the next hand
boundary is to re-read which seats still carry `leave_pending = true`. So the
failure defers a cash-out by a hand or two. It cannot lose one.

**Whose fault, and the shape of it.** A transient Supabase client timeout (the
flat 15s deadline in `server/src/services/supabase/client.ts`). These were
fleet-wide database stalls, not per-table faults: eleven of the fourteen landed
across eleven DIFFERENT tables inside seven seconds on 2026-09-14 00:18:28-35Z,
and five across five tables inside fifteen seconds on 2026-09-11.

**Money: 0.00 outstanding.** Read from rows, not assumed:

| measurement                                                | result                              |
| ---------------------------------------------------------- | ----------------------------------- |
| seat-stack exits from the 14 tables in the incident window | 484                                 |
| of those, unaccounted (`fn_unaccounted_seat_exits`)        | **0**                               |
| unaccounted platform-wide, 30 days                         | **0** (0.00 chips)                  |
| open seats anywhere still carrying `leave_pending`         | **0**                               |
| seats still open on those 14 felts                         | 8, holding 1,021.83, none departing |

The 7-day default on `fn_unaccounted_seat_exits` does not reach 2026-09-12, so
it was widened to 30 days deliberately; the 7-day answer would have been true
and irrelevant.

**Membership was established exactly, not assumed.** The dedupe key predates
the producer's current per-table branch, so this row is a shape-fold: 23 alerts
share the shape, the incident opened at the 10th, and alerts 10-23 are its 14 -
the first and last match `detected_at` and `last_seen_at` to the microsecond.

**Not closed on silence** (law 10.86). `leave_pending` runs at every cash-hand
boundary; 677,992 cash hands have settled since the last occurrence with zero
recurrence, and the alerting channel is demonstrably alive across that window -
2,446 other `postHandTasks.*` alerts fired in it. An unread stream and a
re-measured all-clear are different things, and this is the second.
`closure_basis = 'verified_remeasured'`.

**No repair job was built** (laws 10.11, 10.12), because none is needed: the
live path corrects itself at the next boundary by construction. The root
mitigation already shipped - `STEP_RETRY.leave_pending = 2` with 250ms/1s
backoff in `ServerTableEngineSettlement.ts`, sound precisely because a seat that
already left is no longer in the step's answer, so a retry cannot pay anyone
twice.

**Honest limit.** These fourteen carry `attempts = 1` and predate the
`leave_pending_diagnostic_v1` evidence field, so WHY the retry did not engage on
those particular attempts cannot be read from rows. The likeliest reason is
`lifecycleCanMutate()` correctly denying a retry to a generation that lost the
table during the stall - intended behaviour, not a defect - but that is
inference, and it is recorded here as inference.

The 14 underlying `financial_alerts` rows were resolved with the same finding,
completing the record (10.9). The other 41 unresolved `leave_pending_failed`
alerts are different error shapes (`SEAT_MOVE_GAME_SCOPE_MISMATCH`, the
`cash_player_session_one_open` duplicate key, the "after 2 attempts" variants)
belonging to other incidents; they were left alone.

## Board after this

3 open, all critical, all `fn_ca_conservation_sweep:*` and all genuinely
blocked on the frozen engine: `28f5660c` orphaned running tournaments,
`546d9098` tables that cannot deal, `7ab0dcbe` absent tournament players.
