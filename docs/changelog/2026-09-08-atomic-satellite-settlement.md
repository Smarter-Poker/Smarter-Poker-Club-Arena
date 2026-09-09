# Atomic Satellite Settlement

## What Was Wrong

Satellite completion was split across process memory and repeated database
calls. TypeScript calculated a seat count, invoked a per-winner seat RPC,
sometimes substituted cash, paid a remainder through another path, stamped
presentation fields, settled rake and finally closed the event. A failure
between those steps could leave a seat without its pool transfer, money without
complete evidence, or prize-pool chips retained for a later repair. The old
remainder fallback could also pay a ticket winner instead of the one player who
actually bubbled.

## Root Repair

The atomic satellite migration installs one service-facing database door:
`fn_settle_satellite_tournament(tournament_id, observed_winner_id)`.

- It locks the source, surviving target, both rosters and escrow accounts, and
  requires the source prize pool to be finalized.
- The locked source pool, not the house bank, is decomposed into
  `floor(pool / ticket_cost)` complete ticket awards and
  `pool mod ticket_cost` residual chips.
- Every complete ticket is an immutable per-place line. A provably available
  target receives an actual registration plus its exact pool-transfer and fee
  evidence. A locked closed or full target, or an independently held target
  seat, receives an exact-price cash substitute. A missing target aborts the
  whole transaction because an absent row cannot be locked against recreation.
  Every immutable header also holds a delete-restricting target foreign key,
  so a cash-only receipt cannot lose the target contract it replays against.
  Ambiguous admission or seat provenance aborts the transaction.
- When the residual is positive, exactly one next finisher at
  `ticket_award_count + 1` receives all of it. The residual is never split,
  retained, funded by the house, or redirected to a ticket winner.
- Every residual has its own immutable evidence line. New rows bind the Bubble
  place, obligation, payout and wallet claim to the canonical place key. This
  makes the residual a stored receipt fact instead of a reconstruction from
  mutable prize caches.
- Advertised guarantees remain promises: the existing lock-time funding rail
  must have placed enough money in the finalized source pool to cover them.
  Settlement checks that fact and refuses an unfunded guarantee rather than
  minting it again.
- Registration, wallet credits, payout and obligation evidence, target pool
  transfer, target fee attribution, prize caches, source escrow drain, rake and
  `COMPLETING -> COMPLETED` are one transaction. A malformed terminal receipt
  is not success.
- Every actual target seat is checked against an escrow snapshot captured
  before delivery. The committed target roster, prize pool, rake total,
  satellite principal, satellite fee, prize balance and fee balance must move
  by exactly that seat's buy-in and fee while every unrelated escrow component
  remains unchanged. A missing, disabled, replica-only or misbound escrow
  trigger therefore aborts the whole delivery instead of leaving a receipt
  over a stale target bank.
- Target capacity and target live occupancy remain separate facts. Historical
  target entries still count toward the admission cap. Before play starts,
  `current_players` must equal the registered/playing roster. Once a target is
  `RUNNING`, that cache must equal its total entrant roster and must not shrink
  when someone is eliminated. A delivered seat increments the applicable
  prelocked counter exactly once. The target pool and rake caches must also
  equal their prize and fee escrow balances. Settlement refuses stale counters
  or banks instead of preserving divergence.
- Bounty, PKO, mystery-bounty and Spin targets are refused before any write.
  Those formats require a separately receipted prize, fee and bounty split;
  treating their complete buy-in as ordinary prize escrow is not permitted.
  Non-bounty target escrow must be solvent, finite, nonnegative and whole-cent
  across every persisted component before a seat can be delivered. Both source
  and target escrow must also be open, with no earlier terminal marker or note.
- Before taking any row lock, both cash and satellite terminal authorities take
  the same transaction-scoped settlement lock. Concurrent events that pay the
  same wallets therefore cannot invert recipient locks and deadlock each other.
- Source seats are released before the tournament becomes terminal, and source
  tables close immediately after it becomes terminal. That parent-before-child
  order prevents the existing live-table guard from misclassifying a legitimate
  settlement close as an accidental close under a live tournament.
- Before any payer runs, the authority locks and freezes every source table and
  source seat identity in deterministic order. After the ticket, Bubble, rake
  and escrow work, it releases every live source seat and closes every source
  table with `status = closed`, `lifecycle = closed` and
  `current_players = 0`. Those exact identities and counts are stored in the
  immutable receipt. Replay refuses any missing, added, revived or reopened
  source row.
- A source seat that departed before settlement keeps its original `left_at`
  evidence, while the terminal authority closes its mutable occupancy state to
  `status = left`, `leave_pending = false`, `is_sitting_out = false` and
  `is_away = false`, with no sit-out timestamp or scheduled leave, in the same
  transaction. The tournament and every table also hold a zero live-player
  cache. Replay requires that exact state for every captured seat. It also
  requires the source escrow close timestamp and canonical close note, not
  only three zero balances.
- The satellite authority creates the durable table terminal marker and stamps
  every new close and both exact historical adoptions directly from the source
  tournament's canonical `ended_at`. Its receipt rejects a NULL, forged or
  mismatched marker. The later terminal migration adds the shared irreversible
  table guard, so a completed satellite table cannot be reopened through a
  delayed table or hand update.

## Satellite-Funded Unregistration

A target-tournament seat won through a satellite is a noncash entitlement.
Before the target's scheduled start, unregistering that seat returns one
`tournament_entry_only` ticket for the exact target entry contract. It never
credits a player wallet. Spending that ticket funds another matching
tournament directly, creates a new immutable ticket-funded entitlement, and
also credits no wallet. If the player unregisters again before that event
starts, the result is another tournament-entry ticket, never chips. Once the
scheduled start is reached, unregistration is refused.

The ticket row cannot be redeemed or cancelled through the Cashier chip RPCs.
Its identity and funding rails are immutable, and deletion is forbidden. The
only permitted `issued -> redeemed` transition consumes one private,
owner-only admission authorization in the same database transaction as roster
creation, ticket-to-pool transfer, fee evidence, escrow movement and the next
refund entitlement. A caller-set session value without that exact private row
is refused, so a forged or stale setting cannot bypass the boundary.

Personally funded entries remain distinct. Their immutable charge
entitlements refund only to the exact club wallet that supplied each debit.
The unregistration response separately reports wallet chips and returned
ticket value so the client cannot describe a noncash ticket as a chip refund.

Horse beneficiaries use the same rail. The service reads one database-owned
candidate hint before lane, bankroll and count filtering, keeps hinted horses
at the front of the admission window, and calls one three-argument atomic door
with explicit per-candidate wallet authority. The database revalidates the
ticket under the terminal and maintenance locks. A new ticket is consumed even
if it appeared after the hint; a hinted ticket that disappeared, or a matching
ticket with corrupt issue evidence, is refused without charging the horse's
wallet. The beneficiary-aware selector and admission cores remain owner-only,
while human wrappers stay bound to `auth.uid()` and the horse door remains
service-role-only.

The former `fn_award_satellite_seat` door is deliberately retired in a separate
stage-two migration, applied only after the new engine build is published and
verified and every old instance has drained. This keeps old instances able to
finish live satellites during a rolling cutover; the cleanup then revokes and
drops the old function with `RESTRICT`, after proving that no database routine
or active schedule still names it. The unused process-side arithmetic and
target-open modules were removed. The game server now requests the exact
whole-settlement receipt and retries only the same idempotent identities. If
all direct responses are lost, a read-only resolver waits behind the same
global terminal lock and then returns either the committed immutable receipt
or a definitive no-receipt `RUNNING`/`COMPLETING` state. Only that definitive
miss reopens the finish guard. An unreadable outcome raises a critical alert,
keeps the finish guard closed, stops every owned engine, and returns without a
second rake or completion path.

The stuck-COMPLETING recovery path now replays that same whole-event RPC from
one durable stored winner and validates the same v2 receipt. It no longer
counts partial payout rows or target seats, infers `already awarded`, or closes
a satellite through a process-side status write. A historical satellite that
is visibly undecided may only compare-and-set back to `RUNNING`; an unreadable
roster, absent durable winner, transport error, SQL refusal or malformed
receipt raises a critical alert and moves no additional money.

## Exact Historical Adoption

The broad authority migration runs only inside the quiet maintenance freeze. It
defines two temporary owner-only exact-event helpers, revokes them from every
runtime role, and deliberately does not execute either helper while its schema
locks are held. The separate post-freeze closeout migration requires the exact
committed `fn_settle_satellite_tournament:v2` cutover version, refuses to run
while entry purchases remain frozen, calls a helper only when its exact event
exists without an immutable settlement receipt, verifies both exact receipts,
and drops both helpers in that same transaction. A mismatch rolls back the
adoption and leaves the helpers available for a reviewed retry; a successful
closeout leaves no callable adoption door behind.

For production event `b066f432-2aae-4994-85c8-f9bfbfa4cd2f`, the helper proceeds
only if every audited fact is unchanged: a finalized 285-chip source pool,
200-chip target ticket, the fixed source, target, player, table and seat
identities, beer710 at place one with one exact settled 200-chip cash leg,
DETVal at place two, no seat leg, exact wallet transactions, wallet claim,
obligation, journal hashes, rake rows, terminal rake settlement, and every
source escrow component with exactly 85 chips remaining. Under those locked
assertions it writes the immutable ticket line, pays DETVal exactly the missing
85 chips from the source prize pool, and proves 285-chip conservation with zero
source escrow. It never draws from a house bank.

Production event `682045c5-cb07-47ed-ad0e-adbff9cb41af` already paid the correct
200-chip target seat to SadWizard and all 85 residual chips to the single Bubble
finisher, connorford, through the legacy split path. Its helper accepts only the
exact event, players, target registration, two payout rows, obligation, wallet
claim, pool transfer, target fee, both buy-in debits, all five source-linked
journal rows, all rake rows, every escrow component, table and seat identities,
seat stacks and occupancy flags, plus the target's internally consistent
roster, aggregate and escrow state. It moves no money and rewrites no financial
row. It normalizes only the stale pool, prize and felt caches, stores the exact
legacy identifiers in the immutable residual receipt, and must pass the same
whole-pool verifier before either helper can be removed.

This release is data-forward once committed. A statement failure rolls the
whole migration transaction back. After a receipt exists, operators must use a
reviewed forward repair; dropping immutable receipts, reversing the exact cache
normalization or reopening the split per-seat writer is not a safe rollback.

## Verification Contract

`AtomicSatelliteFinish.guard.test.ts` pins pool decomposition, one-bubble
ordinal, guarantee funding, seat/cash classification, unknown-outcome refusal,
serialized lost-response recovery, immutable replay, legacy-door retirement
and server fail-closed wiring. `SatelliteTicketUnregistration.guard.test.ts`
pins the pre-start-only rule, exact wallet-versus-ticket routing, noncash
admission and one-use authorization boundary. Each unregister now commits one
immutable receipt keyed by a caller-generated request UUID, the exact deleted
registration and the locked scheduled-start cutoff. A retry with that same UUID
may read the already committed pre-start outcome after the event begins, but it
cannot perform another unregister; an unkeyed rolling-client retry is refused
after start. Reusing the UUID for another player, event, endpoint or later
registration lifecycle fails closed. The receipt verifier independently proves
the entitlement, exact source wallet, wallet tranche, ticket-issue ledger and
ticket-issue transaction evidence before returning success. The migration and
catalog probe also require all six escrow triggers to be exact origin-capable
event bindings, and prove that every immutable evidence and private
authorization table remains owner-only under RLS with no app-role privilege or
policy.
`satelliteSettlementRpc.test.ts` behavior-tests
identical replay, definitive refusal, commit-after-lost-response recovery,
winner identity binding and unavailable-resolver fail-closed behavior.
`satelliteSettlementReceipt.test.ts` rejects malformed counts, awards,
registrations, UUID evidence, settlement timestamps, non-v2 responses,
winners, terminal state and any award count below `floor(pool / ticket)`.
`aStuckSatelliteGoesSomewhere.law.test.ts` forbids partial-evidence completion
in recovery. The catalog SQL audit is self-aborting. The isolated closeout
rollback probe copies the installed authority into `pg_temp`, rejects a bounty
target and negative target escrow, injects a table close refusal after its
money work, and separately disables the target fee rail. It proves every fault
rolls back the ticket, Bubble credit, rake, both escrows, lifecycle, receipt,
standings, source table and source seats to their exact pre-call state,
including one already departed seat with stale active flags. Its running
late-registration target includes an eliminated historical entrant so the
success path proves the live counter increments from its prelocked value
instead of from all historical rows. It then removes the faults, calls the
installed authority and full receipt verifier, and proves the old departure
timestamp is preserved while every seat closes. NULL and mismatched terminal
markers must each invalidate replay.

`atomic-satellite-ticket-return.sql` runs the complete noncash lifecycle on a
clean production-schema clone: satellite seat to ticket, ticket to tournament
admission and exact replay, post-start unregistration refusal, pre-start return
to another ticket, exact same-request replay before and after start, unkeyed
post-start retry refusal, Cashier redeem and cancel refusal, direct mutation
refusal, forged session-token refusal and zero wallet rows throughout.
`atomic-horse-satellite-ticket-return.sql` repeats the lifecycle for an
auth-backed horse through the service-only admission door, proves exact
lost-response replay, returns the second entry to another ticket, and injects
both a stale hint and corrupt issue proof while asserting an unchanged club
wallet and zero tournament wallet rows.

The final clean PostgreSQL 17 rehearsal, production migration, merge,
publication and served-state certification are release gates. They must be
recorded only after the final migration checksums are frozen and those steps
actually pass.
