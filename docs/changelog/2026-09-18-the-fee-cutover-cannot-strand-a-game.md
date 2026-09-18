# The fee cutover cannot strand a game it did not witness (2026-09-18)

## What went wrong

`accounting_tournament_fee_cutover.starts_at` was armed at 2026-09-17 18:24:02.831517+00 while tournaments were in flight.

From that instant, every tournament entry fee must carry contributor evidence, and `fn_capture_accounting_tournament_fee` refuses any contributor whose `charged_at` precedes the cutover. The tournaments that had already charged their fees could therefore never produce a batch. `fn_accounting_tournament_fee_net_plan` refused them with `tournament_fee_sources_require_reconciliation`, `fn_settle_tournament_rake` turned that refusal fatal because its own net counted the unwitnessed fees, and the events froze: decided by the cards, winners unpaid, 1,901 horse entries seated in games that could not end.

Twelve hours later the engine had logged 1,491 finish refusals, raised a critical money alert for each, and the elimination scheduler was spending its whole budget re-asking a question the database had already answered.

Nothing in the schema stopped any of it. A cutover is a promise that every fee after it can be witnessed. Arming one over games whose fees were already charged makes that promise about the past, which is the one thing it cannot keep.

## Why the hole was exactly here

The row was already well defended in every direction but one. `accounting_tournament_fee_cutover_immutable` refuses UPDATE and DELETE, `accounting_tournament_fee_cutover_no_truncate` refuses TRUNCATE, and PRIMARY KEY (singleton) with CHECK (singleton) allows exactly one row. The instant could never move once chosen, and nothing checked it when it was chosen.

INSERT was the whole unguarded surface, and INSERT is how this happened. That was found the direct way: the first draft of this migration guarded UPDATE too, and its own postcondition failed against the existing immutability trigger.

## What changed

`fn_ca_fee_cutover_stranded_by(timestamptz)` answers, for any proposed instant, how many live tournaments it would strand: those holding a positive entry fee charged before it with no captured batch. It is STABLE and reads live rows on purpose, SECURITY DEFINER so it answers the same way for every writer, and EXECUTE is granted to nobody.

`ca_fee_cutover_is_drained`, a BEFORE INSERT trigger on the cutover row, refuses to arm it at any instant that observer reports as stranding. It guards INSERT alone rather than duplicating the refusals already in place, because a second guard on the same operation only hides which one spoke.

The refusal names the instant, the tournament count, the fee count and the oldest offending tournament with its charge time, so it says what to drain rather than only that something is wrong.

## What this does not do

It does not repair the tournaments already stranded. Their fees are attributable: calling `fn_accounting_earning_contract` on 400 of them produced a complete contract with a real agent chain for 358, just under 90%, because `accounting_agreement_history` begins on 2026-09-14, three days before the cutover. What blocks their capture is the provenance rule alone.

That repair is not in this migration because the functions it would have to change, `fn_capture_accounting_tournament_fee`, `fn_stamp_accounting_tournament_fee`, `fn_accounting_earning_contract` and `fn_accounting_terms_at`, have no definition anywhere in `supabase/migrations`. They exist in production and are fingerprinted in the `scripts/ci/fixtures/mtt-*` authority snapshots, but the repository cannot rebuild them. A migration replacing them would fail on any fresh replay and would make a transcription the source of record for money code with no source in the tree.

## Verified

Dry-run first against production with `COMMIT` replaced by `ROLLBACK`, which reported: trigger installed on INSERT, backlog at the installed cutover of 649 tournaments and 2,673 fees with the oldest charged 2026-09-05, an attempt to arm today's instant refused by this guard rather than by the primary key, an instant nothing precedes stranding nothing, and the cutover unchanged.

Then applied for real and recorded as version `20260918064540`. Readback: the trigger is installed and enabled, both functions exist, and the observer reports that arming the cutover now would strand 669 live tournaments.

Two attempts before that were refused and respected rather than overridden: `fn_ca_break_window_ddl_guard` at 06:52 for being inside the `:50`-`:03` window, and again at 07:03 because an announced engine maintenance thaw was still active. The override exists for emergencies and is recorded in `ca_break_window_migration_overrides`; nothing here was an emergency.

The postconditions in the shipped migration prove the trigger is installed and enabled, that the observer still reports the backlog this migration was written from, that arming over a live backlog is refused **and that the refusal came from this guard** by reading the message back rather than trusting that an INSERT on a single-row table failed for the right reason, that an instant nothing precedes strands nothing so the guard is not merely refusing everything, and that the installed instant is unchanged when verification ends.
