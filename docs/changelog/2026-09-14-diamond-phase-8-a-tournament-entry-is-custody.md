# Diamond Phase 8: A Tournament Entry Is Custody

Status: Phase 8 In Progress. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet.

## What A Diamond Tournament Could Not Do Until Now

Every Diamond tournament door existed and refused. `fn_poker_diamond_reserve` knew how to price a `tournament_entry` custody row that nothing had ever written; the registration core debited `club_members.chip_balance`, which the arena structure guard holds at zero forever; the rebuy core debited the same wallet; the unregistration and cancellation authorities proved their refunds against `chip_ledger` rails a Diamond entry would never write; and the roster gate asked `club_members` for a membership the arena refuses to create. Every one of those was found by rehearsing the lifecycle against production inside a transaction that ends in a deliberate error, thirteen times, until the run reported `REHEARSAL OK` and nothing had leaked.

## The Shape

A Diamond entry is a custody row, exactly as a Diamond cash seat is. The registration core, behind `fn_ca_tournament_unit_cents = 100`, calls the estate's own reserve door to move settled Diamonds out of the wallet into `poker_diamond_custody` (purpose `tournament_entry`, one open row per player per event) and activates the row the moment it is paid, which is the contract the seat guards set on 2026-09-13 (P0810-P0812: a Diamond tournament seat is admitted by an ACTIVE entry, never by its stack). An add-on, rebuy or re-entry adds to that same row through the same lot and journal mechanics the cash top-up uses, minus the seat. A refund releases it whole through `fn_poker_diamond_release`, which now refuses a tournament entry for anyone but the refund authority - the service role included - and the refund authority opens only for an unregistration before the start or a cancellation before the start.

The custody rows ARE the event's escrow, so the supply meter learns nothing new: the trial balance already counts every custody row once, and the rehearsal proved the basis and the mint register unmoved through three entries, a withdrawal, a re-entry, an add-on and a cancellation. What is new is the ledger, `poker_diamond_tournament_ledger`, one append-only row per movement naming the prize, bounty and fee parts, so `fn_ca_tournament_escrow` and `fn_ca_escrow_can_pay` answer a Diamond event in the chip shape, enforced, and a refund can prove its parts. The chip escrow body keeps its text under `fn_ca_tournament_escrow_chips`; the old name routes by asset and carries the old grants.

## The Chip Path Is Proved Unchanged

Every chip function edited here is edited in place: its live text is read, its md5 pinned, exactly one clause replaced (four in the registration core, six in the rebuy core), the result re-created, and the reverse substitution proved to give back the pinned text. The clause added is behind the unit, which is 1 for every chip event. The chip debit (`atomic_deduct_wallet_and_log`), the chip fee rail (`rake_records`), the chip receipt (`wallet_transactions`) and the chip cancellation body (`fn_settle_tournament_refund_exact`) are asserted present at the end.

## What The Rehearsal Found, And What Changed Because Of It

Three things the design could not have known without running the real doors as real clients:

1. **The wallet guard.** `profiles.diamonds` is server-managed and admits a change only in a service context or from a door named on its stack. Every Diamond cash move so far ran from the engine; a tournament entry is a client door. The guard now names the two internal money steps, `fn_poker_diamond_tournament_charge` and `fn_poker_diamond_tournament_refund`, the same way it names the arena deposit and withdraw doors. Both steps are owner-only.
2. **The arena structure guard.** Phase 1 made every write to a Diamond game row platform-operations-only, which is right for the structure and wrong for the counters a player's own entry moves. The guard now admits an UPDATE under a player's session only when the row is unchanged outside `current_players`, `prize_pool`, `bounty_pool`, `total_rake`, `entry_contract_locked` and `updated_at` (tables: `current_players`, `updated_at`). Everything structural is still staff-only.
3. **A started event is never voided.** The first draft of the Diamond cancellation refunded a running event. The chip rule says a started event is resumed or settled, never cancelled, and the deferred constraint "CANCELLED needs its exact receipt" demands a receipt the chip verifier proves against chip rails. The Diamond cancellation now keeps the chip rule word for word, writes the same immutable receipt row marked `asset: diamonds`, and the receipt reader hands a Diamond event to a Diamond verifier that proves every refund line against the ledger, the released custody row, the `arena_withdraw` journal row, the release movement and the settled obligation. The receipts table itself is not altered: it is read under the settlement lane by every hand settlement, and the one rehearsal that altered it deadlocked twice against live play.

The launch was rehearsed through the estate's own protocol (lease, begin, table, `fn_assign_tournament_player_seat_atomic` three times, complete): three seats admitted against three active entries, no custody row bound to any seat, custody unmoved.

## What Is Deliberately Not Here

Prize, fee and bounty settlement out of the custody rows is the next migration (the payer). Bounties, PKO, mystery bounties, satellites, spins, guarantees and house-funded horse entries are Phase 9 and the creation door refuses them by name. A rebuy needs a committed knockout hand, which only the engine deals, so the rehearsal proved the add-on path and the rebuy core's Diamond branch by text.

## Evidence

- Applied to kuklfnapbkmacvwxktbh as `20260914024241 a_diamond_tournament_entry_is_custody`; the stored statement text is byte-identical to the repo file (md5 `547853d924d234727d5cbead8bda5ec7`).
- Final rehearsal report: `REHEARSAL OK: create=ok(99+11) closed-door=refused entries=3(330 in custody) unregister=refunded110,idempotent,re-entered launch=RUNNING(3 seats,no custody) addon=110(custody 220),idempotent cancel-after-start=refused cancel=refunded110(2 players),receipted,idempotent | ledger_rows=10 custody_rows=6`, then rolled back; production checked afterwards carried none of it.
- After apply: 13 functions and the ledger present, `tournaments_enabled` false, zero `tournament_entry` custody rows, every watched guard on its baseline, `fn_poker_diamond_release` declared to the watcher by this migration.

Law: a-diamond-tournament-entry-is-custody.
