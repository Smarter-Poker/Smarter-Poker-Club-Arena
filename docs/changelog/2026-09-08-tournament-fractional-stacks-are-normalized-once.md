# Tournament fractional stacks are normalized once

The legacy tournament allocator could leave `table_seats.stack` fractional
while its `tournament_players.chips` mirror had already been truncated. The
whole-chip engine must not inherit those balances. The timestamped migration
ending in `_tournament_fractional_stacks_are_normalized_once.sql` is a
single transactional cutover plus permanent ingress hardening; it is not a
recurring repair job.

## Cutover contract

The checked-in migration intentionally refuses a live estate because all nine
operator literals are sentinels. After the exact allocator and exact-seat
settlement migrations are staged as the sole engine build, the operator must:

1. Enter an enforced `counting_down` maintenance break declared by that exact
   eight-character engine SHA.
2. Stop that process and independently prove there is no other engine process.
3. Wait until leader, table, and tournament authority heartbeats are all older
   than 30 seconds. Historical old-build lease rows last authoritative before
   the break announcement are inert and do not block; a fresh row always
   blocks, and a wrong build/protocol observed since the announcement blocks.
4. With at least 210 seconds still remaining in the break, render the locked
   nonterminal cohort into one private mode-0600 artifact and receipt.
5. In the earlier prerequisite window, install and byte-seal the DB-first atomic
   seat-move migration while roster chips are still integer; only then publish
   its application caller. In the later normalization window, verify the
   artifact bytes and pristine one-shot ledger name, apply those exact bytes
   through Supabase `apply_migration`, and restart the same exact build only
   after the ledger and checked-in postcondition verifiers pass. Seal the real
   normalization ledger version into source afterward; never patch the staging
   template first.

The migration takes `realtime.subscription` first, then every lease, lifecycle,
seat, roster, hand and settlement authority in a fixed NOWAIT order. It refuses
source/cohort/identity drift, nonintegral aggregate supply, any fresh authority,
an incomplete hand, an in-flight settlement/post-commit, a partial trigger
result, or a different postimage. Largest-remainder allocation uses stable
table/seat/generation/user ordering and conserves each tournament exactly. Only
the pinned active nonterminal seat generations and their exact roster mirrors
are changed; wallets and completed/cancelled history are not rewritten.

Applying after a nominal break boundary is safe only if the engine remains
stopped **and** the authoritative row still satisfies `counting_down` with more
than 45 seconds left. The renderer's stricter 210-second floor reserves the
time needed to verify and apply. Stopping the process alone does not bypass
that guard; the operator must establish a new valid window rather than
weakening the migration.

## Permanent boundary

Write-time guards reject future fractional/nonnegative-invalid tournament
starting, rebuy, add-on, blind, bomb-pot, table and active-seat values while
preserving cash-table cents and immutable terminal testimony. The service-role
chip RPC validates its complete JSON batch before PostgreSQL's integer cast.
The live-seat wrapper locks relevant roster rows then active seat rows, reads a
fresh snapshot, and updates only exact identities.

Any identity with other than exactly one active seat (including unequal
generations with one uniquely newest row), an active-seat/roster pointer
mismatch, or a playing roster row with no active seat is returned as an
explicit quarantine.
`TournamentManagerEliminations` strictly validates the response, unions both
quarantine classes, and removes those identities before all-zero, rebuy, bust,
placement and elimination work. Healthy exact identities continue to sync and
be processed; winner, final-table deal, bubble and tournament-finish inference
remain closed until a fresh exact snapshot clears the quarantine. There is no
cron, watchlist, manual reconciliation, or guessed stack.

`tournament_players.chips` is widened to PostgreSQL `bigint`, as is the legacy
`tournament_flights.bagged_chips` source. Both now cover the complete whole-chip
range already admitted by `table_seats.stack` (`0..9,999,999,999,999`) instead
of failing at the former 32-bit ceiling. Fraction rejection still happens in
the numeric input RPCs before the BIGINT cast; the write-time trigger enforces
the shared nonnegative upper bound. The prerequisite atomic seat-move migration
already uses the same BIGINT request/receipt contract end to end while remaining
catalog-compatible with both the pre-cutover integer and post-cutover bigint
roster column.

The exact stopped-engine, byte-verification, ledger-application, restart, and
source-sealing sequence is canonicalized in
`docs/runbooks/tournament-fractional-stack-cutover.md`.

## Proof

Run:

```sh
bash scripts/dev/probe-tournament-fractional-stack-normalization-pg17.sh
cd server
npm test -- --run src/tournament/TournamentLiveSeatQuarantine.test.ts src/engine/TournamentFractionalStackNormalization.guard.test.ts
npm run build
```

The PostgreSQL 17 rehearsal covers checked-in sentinel refusal, clean replay,
exact apply/reapply, aggregate conservation, rollback on every cutover guard,
cash-cent preservation, malformed/duplicate/unknown strict-RPC batches,
seatless-playing and equal-generation quarantine with healthy-user progress,
hand-settlement and atomic-elimination lock races, stale historical lease
acceptance, fresh/causal wrong-build refusal, terminal-history close/reopen, and
all permanent chip/config ingress paths.
