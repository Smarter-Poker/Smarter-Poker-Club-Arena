# Rakeback accrues with its source

Status: implemented and rehearsed locally; not applied to production.

## Root cause

`RakebackSettlerService` preserves its composite cursor until every downstream
projection succeeds. The bottleneck was the projection RPC, not the cursor.
Every 1,000-row page called `fn_rakeback_recompute_periods` for each touched
club/week. That RPC walked all seven days, and the changing live day caused
`fn_rakeback_recompute_day` to delete and rebuild that entire day from the
growing source ledger repeatedly.

Production evidence captured before this change:

- 1,305 period-recompute calls consumed 4,384,317.824 ms of database time;
- mean execution was 3,359.631 ms and the maximum was 69,895.507 ms;
- the durable cursor was more than eleven hours behind the newest rake row;
- `rake_records` held about 2.33 million rows and occupied about 1.7 GB.

The cost therefore grew with all ledger history rather than with the few
players affected by one source transaction.

## Root fix

The `rakeback_accrues_atomically_with_its_source` migration makes the
`rake_records` transaction the authoritative rakeback accounting boundary. It
remains a `.sql.pending` artifact until Supabase assigns its live ledger
version; the source is then renamed to that exact version without changing a
byte.

For every attributable positive source, that same transaction now:

1. runs the canonical integer-cent allocator;
2. proves all player shares equal the source rake exactly;
3. appends one immutable source header and immutable per-player lines;
4. increments the exact daily basis and row witness; and
5. refreshes only those players' pending projection from at most seven indexed
   daily rows.

Positive tournament fees historically arrive without `player_contributions`.
The migration therefore pins both the audited tournament-attribution function
and its enabled `BEFORE INSERT` trigger by production definition hash. The
cutover aborts if that dependency drifted or is disabled, and the PostgreSQL 17
probe verifies that the player is named before the rakeback `AFTER INSERT`
trigger accounts the fee.

An exact replay validates the stored fingerprint and changes nothing. A replay
of a UUID whose source was reversed is rejected. Fingerprints cover the full
rakeback provenance, including hand, table, global hand number, tournament,
tournament flag, source-record primary key, source, metadata, contributions,
allocation and a timezone-independent epoch microsecond timestamp. Both source
identity fields are immutable after a financial basis exists, so a reconciler
cannot mistake a renamed source for a new unbanked hand.

The only permitted source mutation is the existing one-time `NULL` hand-id to
canonical hand-id relink. It must pass through the audited relink RPC and now
appends immutable before/after fingerprints, including for pre-epoch history.
All other provenance or amount changes fail in the source transaction.

Pending period identity is now `(player, club, week)`. The legacy key included
`period_end`, which allowed duplicate pending balances when an old one-day row
and the canonical seven-day row coexisted. The cutover preserves every paid
row exactly, consolidates only duplicate pending projections, canonicalizes
their end date, and installs a partial unique index for `status = 'pending'`.
This permits a new negative receivable beside immutable paid history without
ever merging balances across clubs.

## Refund parity

Every refund uses source compensation at the moment the source transaction is
written; there is no special satellite repair path.

- `fn_unregister_from_tournament`, `atomic_cancel_tournament` and the
  GameServer/tournament-recovery cancellation shape identify the exact
  registration/player sources.
- Spin cancellation identifies its exact aggregate source record.
- The leave-seat path's source `DELETE` appends the same exact reversal header
  and player lines.

Negative refund records remain present as immutable transaction evidence. Each
must link to whole, unreversed original receipts whose cents equal the refund
exactly; ambiguity, double reversal or a partial match aborts the entire source
transaction. A lawful pre-start refund therefore returns chips and records its
rakeback compensation atomically.

If the original period is pending, the exact original shares leave that daily
basis. If it is already paid or expired, the closed row is never rewritten:
immutable offset lines move the exact negative basis into the first current or
future open period. Closing a net-negative period appends an immutable carry to
the next open period, so refund debt cannot silently disappear.

That rule also covers a future tournament bought before this migration whose
fee week was already paid but whose lawful unregister happens afterward. Such a
source is deliberately outside the open cutover set; the refund transaction
materializes its exact historical player lines, links the negative row, and
posts the open-period offset atomically. It does not require a refund to have
already existed at cutover. The tournament fee `DELETE` used by the leave-seat
unregister route follows the identical paid-history/offset rule.

That comparison is made over positive-cent receipt lines, not the allocator's
row count. The canonical allocator retains zero-cent player lines when there
are fewer cents than players; those lines remain immutable provenance but can
never suppress the offset owed for the positive-cent recipients.

A refund offset also creates a pending receivable period when the player's
current policy rate resolves to zero (for example, their deal changed after the
paid source week). Closing that zero-rate negative period still carries the
full basis forward; a later policy state cannot strand or erase the debt.

## Null-hand compatibility writers

Legacy and staged callers may still write `(table, global hand number)` with a
null hand UUID before the canonical linked source arrives. Both source shapes
take one transaction advisory key. If null wins first, the canonical insert
appends an exact ghost reversal plus a supersession receipt before accruing the
canonical identity. If linked wins first, the later null row is identified as
the excluded twin before it touches basis. Both serial and simultaneous orders
produce one hand of rakeback, never two.

## No-gap cutover

The migration is one database transaction. It takes write-excluding locks on
the source, daily basis and period projection, computes the open basis once
with the canonical allocator, proves every club/day balance, records exact
cutover source membership, snapshots the opening state, and arms all source
triggers before releasing the locks.

Historical negative rows are linked to their exact originals during cutover as
well. This includes an original outside the open-basis epoch whose period was
already paid: the paid record stays unchanged and the exact open-period offset
is created during cutover. A historical refund whose source never had valid
attributions is retained explicitly as non-applied evidence; an ambiguous
attributed refund aborts rather than guessing.

The engine and rakeback settler must be parked before applying the migration.
A ten-second lock timeout fails closed if the park was incomplete. This is a
one-time conversion of existing state, not a cron, watchlist, or repair worker.

## Authorization and records

All fourteen new accounting/snapshot tables have RLS enabled. Public, anon and
authenticated roles have no access; service role has read-only access. Every
table has a fail-closed `UPDATE OR DELETE` immutability trigger, and all helper
and trigger functions are non-callable by application roles. Service role also
loses direct mutation rights on the authoritative daily basis tables.

The existing rakeback service cursor, agent-commission processing and player
stats remain unchanged. The established day/period RPC signatures remain, but
the day RPC is now an O(1) basis read and the period RPC reads only the small
daily table. Neither compatibility RPC reads `rake_records`.

## Verification

`scripts/ci/probes/rakeback-source-accrual/run-pg17.sh` applies the real
migration to isolated PostgreSQL 17 and proves:

- exact no-gap cutover, membership and cent conservation;
- cutover, pre-cutover-future, and runtime paid-origin tournament refunds, open
  offsets and carries;
- parity across unregister, tournament cancel, recovery cancel, spin cancel and
  leave-seat deletion;
- rollback of invalid allocation, provenance mutation, reversed-UUID replay and
  a positive write into a closed period;
- UTC/Chicago fingerprint, relink and deletion equivalence;
- both sequential ghost/canonical orders plus a real two-session race;
- two-session close-versus-accrual and close-versus-refund serialization;
- RLS, least privilege, immutable receipts and production reconstruction; and
- 250 fully receipted source accruals in under five seconds (recent local runs
  were under 80 ms).

Production application follows
`docs/runbooks/rakeback-source-accrual-cutover.md`. Before the apply, the
checked-in read-only preflight and generic migration-ledger verifier must prove
the live dependency/data invariants and a pristine semantic name. After the
apply, the assigned 14-digit version, sole statement, and exact statement bytes
must match the reviewed artifact before `production-readonly.sql` runs. The
latter reconstructs the current basis solely from immutable cutover, accrual,
reversal, offset and carry movements; proves header/line and
compensation/link conservation; checks all source doors; and verifies that
compatibility RPCs cannot read the source ledger. Source control is then sealed
to the ledger-assigned version with those same bytes.
