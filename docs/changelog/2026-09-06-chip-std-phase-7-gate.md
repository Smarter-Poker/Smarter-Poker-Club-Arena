# 2026-09-06 - chip standard: the Phase 7 gate (the replay's first judged run found the replay)

**Branch** `fix/union-to-club-money-declares-itself`. Two migrations, probed, applied, mirrored byte-exact: `20260906003739_the_replay_keys_an_account_by_what_owns_the_chips` (00:41 UTC) and `20260906004441_the_replay_reads_the_balances_and_the_journal_at_one_instant` (00:45 UTC). Law test extended (LAW 1b, 1c, 1d). Every figure read from production between 00:33 and 00:50 UTC.

## The headline: the replay's first judged run filed 159 findings, and every one was the replay's fault

The nightly job's first real pass was due at 06:40. Rather than wait for it to run unattended, the gate ran it by hand at 00:33 against the 2,030 baselines written an hour earlier: **1,861 accounts checked, 159 disagreements, worst -627.98**. Read one by one against the rows, all three causes are mine.

1. **An account is not keyed by the club on the leg.** The key carried `club_id` for every type, so ONE union bank appeared as two accounts (one per club that happened to be on its legs), each reading the same 56,641.84 and each seeing only its own subset of legs: -242.50 unexplained, twice, on a wallet that had not lost a chip. The same split hit both BBJ pools. And for player wallets the club on the leg is the club of the EVENT, which is not always the club of the wallet that moved (a player in one club entering another club's union event) - the -200.00 and -190.00 findings are exactly that. The account is now the OWNER of the chips: the user, the union, the pool. A player's account is their whole balance across every club they are in.
2. **The felt is one pool, not one account per table.** 145 of the 159 were cash tables inside a cluster, where `fn_cash_seat_move_execute` carries a stack from one table to another with no journal leg - correctly, because the felt total does not change and no wallet is touched (the Phase 5 gate registered those doors on exactly that reasoning). A per-table replay reads a move as a loss at one table and a gain at another. The felt is now one account, defined exactly as the supply meter defines it.
3. **A balance that does not exist is not zero.** The reader summed `club_members` for a (user, club) pair and returned 0 when the pair had no row, so an account keyed on a club the player is not in was judged against a fabricated zero. It returns NULL now, and the replay skips what it cannot read.

After the correction, the same window: **1,009 accounts checked, 9 disagreements, worst -20.00** - and the nine are the window's edge, not chips. The residues read `two intervals 0.00` on every large one, which is the two-interval rule cancelling a leg that committed between the window end and the balance read. What persists is the felt at 3.38 on a movement of 534.32 and a BBJ promo bank at 0.13.

Then the edge itself was closed: the nightly job now runs the replay inside one `REPEATABLE READ` transaction, so the balances and the journal come from the same instant by construction. Anything calling it by hand gets the old behaviour plus the two-interval rule, which is correct and noisier, and the function's comment says so.

**This is what a phase gate is for.** A new detector gets to be wrong once, in front of the person who built it, before it runs unattended and teaches everyone to ignore it. The 159 findings and the nine that followed are resolved with the migrations that corrected them.

## Everything else in Phase 7, verified

- **7.2 live**: 6 horse funding legs since the door changed, 5 of them naming their player (the sixth predates the apply by seconds); 0 ledger write failures; 0 alerts naming the horse doors; the dropped 3-argument and 4-argument shapes broke no caller (PostgREST resolves the named-argument call to the defaulted shape).
- **The switch**: the live body carries the verdict path and does not touch `ca_payout_freeze`; every meter ran clean since (the one "failed" cron in the window was a job still running when it was counted).
- **The meters**: supply -0.02 at 23:05 and +0.31 at 00:05; Mint register difference 10.85; escrow drift 0; rpc drift 0; no undeclared money triggers; R3 in refuse mode with no violations since the flip.
- **Mirrors**: every Phase 7 migration byte-exact against `schema_migrations` (5 of 5 checked).
- **Tests**: the full suite green (1,030 files, 14,221 tests) at the Phase 6 gate; the Phase 7 law tests green at 197.

## Named

- 579 legs a day still cannot be keyed to a column (a union wallet has six, an agent two, and the counterparty side of a leg carries no label). They are counted every run and reported as `unkeyable`; naming them is the next cut of the replay.
- The nightly job's own first unattended run is 06:40 UTC; it will re-baseline under the new keys and judge from the run after.
