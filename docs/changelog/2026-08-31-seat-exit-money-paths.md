# 2026-08-31 — Three money paths that ended a seat without a matchable credit

Three separate ways a stack could leave the felt without the ledger being able
to prove where it went. None of them was theoretical; two were running daily.

## 1. The boot sweep credited an aggregate and then DELETEd the seats

`GameServer.cleanupStaleData` cashed out every stale cash seat by summing each
player's stacks into ONE `atomic_credit_wallet_and_log` call, keyed
`startup-cashout:{userId}:{sorted seat ids}`, and then bulk-DELETEing the seat
rows.

The credit and the delete were two separate round trips. A boot that died in
between paid the chips and left the seats occupied — and the next boot read the
identical seat-id set, rebuilt the IDENTICAL idempotency key, and
`atomic_credit_wallet_and_log` correctly deduped it, writing NO fresh ledger
row. The seats were deleted anyway.

Measured in production: 3,405 DELETEs of active cash seats a day (1.27M chips),
of which roughly 1,033 exits a day (~432K chips) reached
`fn_unaccounted_seat_exits` with no wallet credit inside its matching window.
Each one filed as CRITICAL in `ledger_reconcile_log`, indistinguishable from
chips actually being destroyed. A reconciliation alarm that cries wolf a
thousand times a day is not a reconciliation alarm.

It is also the shape CLAUDE.md 11.5 forbids outright: a seat that ends by DELETE
ends outside the refund path.

**Fixed:** one `atomic_seat_cashout_locked` per seat, in batches of 10. That RPC
reads the stack under `FOR UPDATE`, credits, and stamps `left_at` in the SAME
transaction, deriving its key from the row it locked. There is no window to die
in, every seat produces its own matchable ledger row, and a failure rolls credit
and vacate back together — so the seat keeps its stack for the next pass, which
is what the old `failedUserIds` bookkeeping was trying to approximate.

**The DELETE is gone entirely.** A vacated seat (`left_at` set) is the audit
trail, and `atomic_table_buyin` already clears the rathole rows it needs to
reuse a seat number.

HORSES ARE PLAYERS (10.5): the sweep still only looks at horse seats, because a
human's seat must never be reaped by a boot sweep — but the chips now travel the
IDENTICAL path a human's do. Same RPC, same lock, same ledger row, same club
wallet.

## 2. `remove_horse` — a DELETE with no refund at all, still live

`public.remove_horse` has been SECURITY DEFINER in production since
`008_hydra_horse_fleet.sql`. It reads the stack, writes it to `horse_sessions`
as history, and DELETEs the seat. It never credits anything. Every chip on that
seat is destroyed.

Retired by `20260831120000_retire_remove_horse_the_delete_that_refunds_nothing.sql`,
which replaces it with a tombstone that raises
`retired: use atomic_seat_cashout_locked`. Replacing rather than dropping so a
future caller reads the rule instead of a "function does not exist" that invites
someone to recreate it from 008.

**No live caller** — verified across the whole repo. `server/src/**` has no
reference; `HydraService.removeHorse()` goes through `atomic_table_cashout` and
only mentions the string in an event source label. Tier 3, so the migration
carries pre-flight assertions, post-apply assertions (including one that
actually calls it and checks it refuses) and a pasted ROLLBACK.

## 3. Bomb award-unit writes retried three times and then gave up forever

The `bomb_pot_award_units` write in `ServerTableEngineSettlement` is
fire-and-forget by design — the ledger narrates money `logHandHistory` has
already recorded, so it must never be able to fail a hand. It retries three
times and reports. Nothing ever came back for the row, so a blip that outlasted
the third attempt left a permanent hole: ~17 `bomb_award_ledger_gap` criticals a
day, closable only by a human running a backfill.

A retry that gives up is not durability. Added `startBombLedgerRepairSweep()` —
hourly, same best-effort construction as the fee reconciler and lease reaper —
calling the existing `fn_backfill_bomb_pot_award_units(500, false)`. That
function reproduces the engine's own pot/board/rake arithmetic from columns
already stored on the hand, and deliberately rebuilds SINGLE-WINNER hands only:
`hand_history.winners` is merged per user and does not record which board each
winner took, so multi-winner hands stay missing and stay visible in the gap
report. An incomplete ledger that says so beats a complete-looking one that is
partly fiction.

Also added the guard the condition was silent about: a bomb hand that settles
with winners but an EMPTY per-pot award array now calls `reportError`. Without
it that hole looks exactly like a transport loss, and the repair sweep chases it
forever — the units were never computed, so no backfill can reconstruct them.

## Tests

`server/src/seatExitMoneyPaths.test.ts` pins: the sweep cashes out through
`atomic_seat_cashout_locked` per seat; `GameServer.ts` never issues a
`table_seats` DELETE; the aggregate `startup-cashout:` key is gone; the repair
sweep is armed on start, cleared on stop, and calls the backfill with
`p_dry_run: false`; the empty-awards guard exists; the retirement migration
exists and carries a rollback section.

`tests/config/walletCreditIntegrity.test.ts` had two pins on the replaced
behaviour, both moved in this commit rather than deleted:

- the block asserting `startup-cashout:` sits next to an
  `atomic_credit_wallet_and_log` call now asserts the locked RPC instead, plus
  the absence of both the old key and any seat DELETE;
- the credit-site floor drops 10 -> 9. That is a credit site REMOVED, not a
  regex that rotted — the boot sweep no longer credits a wallet in TypeScript at
  all.

## Migrations committed, not applied

- `supabase/migrations/20260831120000_retire_remove_horse_the_delete_that_refunds_nothing.sql`

No new migration was needed for the bomb repair: `fn_backfill_bomb_pot_award_units`
already exists from `20260829_backfill_bomb_award_units_by_arithmetic.sql`, and
the sweep just calls it on a schedule.
