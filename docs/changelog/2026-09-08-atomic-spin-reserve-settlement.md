# Atomic Spin Reserve Settlement

## What Was Wrong

A completed live Spin moved a 3.00 draw out of `spin_bonus_pools` and wrote its
immutable `jackpot_draw` row, but the matching chip-ledger leg timed out. The
auto-ledger trigger caught the error and allowed the bank update to commit.
Reserve escrow therefore never received the draw and the winner could not be
paid without a later repair path.

The old engine also split entry booking, tier drawing, and draw settlement
across lower-level calls. That left a race in which another event could move
the reserve between draw and settlement, and it could count the current
three-seat contribution twice while evaluating affordability.

## Root Repair

Migration `20260908153223_spin_reserve_settlement_commits_its_journal_or_nothing`
installs one database-owned Spin money boundary:

- The earlier platform-wide strict `fn_ca_autoledger` makes each
  `spin_bonus_pools.balance` write, exact chip-ledger leg, and escrow effect
  commit together or roll back together. This Spin migration pins the exact
  authority installed by `20260908024909` both before and after its work, and
  does not redefine or weaken it.
- Each new three-seat contribution or jackpot draw row requires one exact
  journal leg in the same transaction. Contribution and draw receipts cannot
  later be updated or deleted.
- `fn_spin_draw_and_settle` proves exactly three paid, rostered, active seats;
  requires every live seat and playing roster row to hold exactly the board's
  positive `starting_chips`;
  books the entry; retains the reserve lock; selects only a funded tier;
  settles the immutable draw; stamps the tournament multiplier and prize pool;
  and returns the reserve, journal, escrow, and tournament evidence IDs.
- `TournamentManagerBase` calls only that combined authority, validates the
  complete receipt, and refuses to reveal or enter `RUNNING` when any evidence
  field disagrees. It no longer pre-reads the reserve ledger or calls the
  lower-level draw and settle RPCs from the process.
- The tournament contract must equal its single immutable draw. Once sealed,
  the multiplier, prize pool, and locked tier snapshot cannot drift away from
  that money fact.
- An owner-only cutover record identifies the production incidents that were
  present when the new authority was installed without exposing operational
  evidence to application roles.
- The table-seat guard now rejects every non-positive tournament seat before
  caller authorization and rejects a canonical seat-first stack that differs
  from `tournaments.starting_chips`. The strict AFTER-seat hook propagates a
  failed count or third-seat booking so the seat, roster, debit, and reserve
  boundary roll back together.
- The migration serializes with `credit-stalled-seat-first-stacks`, freezes its
  scheduler row plus five source tables against writers, proves zero exact
  repair candidates and exact seat/roster parity, then unschedules the cron
  and drops its function. It performs no repair writes to make the retirement
  gate pass, and the scheduler lock prevents a matching job from being added
  between the final scan and commit.

## Historical Corrections

The 3x incident `781cc0ee-6a1d-4e31-acaf-4e737661bba1` is corrected only after
its exact three paid seats, reserve contribution, draw, missing journal,
zero-payout state, and expected pool are proven. The migration restores the
already-moved 3.00 journal and escrow evidence, then pays the proven winner
through the owner-only raw cash authority. Any changed or partial shape aborts
the migration.

The 10x incident `6d688095-c3c5-4d40-a5a0-952934667732` already had an exact
10.00 reserve draw and exactly 10.00 of durable payouts: 9.40 to the winner and
0.60 to the runner-up. Its stale 3.00 tournament cache and 10.00 winner
obligation did not justify a clawback or another payment. The migration proves
the payout, wallet, reserve, journal, and escrow evidence, then normalizes only
the winner obligation metadata to its final 9.40 receipt and resolves the
matching incident records. No chips move in this acceptance path.

## Verification Contract

The returned receipt names the selected multiplier, prize pool, entry amount,
draw amount, reserve balance, pool, reserve rows, journal rows, escrow totals,
locked tiers, paid-user count, and owner. The server rejects an incomplete or
inconsistent receipt before a Spin can reveal or deal. Structural guards cover
strict reserve journaling, immutable receipt rows, exact draw-to-contract
parity, one funded three-seat authority, and exact positive starting stacks.
The server's `spin_chips` beat remains as presentation only; launch, resume, and
post-reveal timers have no seat-stack writer or top-up selector.

The recurring GameServer winner-backpay caller and its ten-minute process timer
are removed. Historical money is handled only by the exact asserted corrections
in this migration; new Spins either commit the combined receipt or do not reveal
or deal. The database backpay function remains temporarily installed during the
rolling stage-one deployment, but the staged post-publish cleanup requires a
real non-audited atomic receipt and zero full-history shortfall before it drops
that function and the remaining legacy Spin repair doors. That cleanup first
owns both live repair advisory keys and freezes scheduler membership, then
recreates and proves the exact journal, immutable-receipt, and tournament-
contract trigger bindings before the fallback fleet can disappear.

This stage installs and adopts the atomic authority and retires the independent
seat-stack repair cron. Lower-level Spin money service doors remain a separate
post-publish cutover because the rolling server deployment still requires them.
