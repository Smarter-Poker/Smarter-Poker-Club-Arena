# tests/the-fee-cutover-cannot-strand-a-game.law.test.ts

The accounting fee cutover may not be armed at an instant that would strand a
live tournament. On 2026-09-17 `accounting_tournament_fee_cutover.starts_at`
was set to 18:24:02.831517+00 while games were in flight; from that instant
every entry fee needed contributor evidence, the capture path refuses any
contributor charged before the cutover, and the events that had already
charged their fees could never produce a batch. The plan refused them,
`fn_settle_tournament_rake` turned the refusal fatal, and 550 events froze
with their winners unpaid and 1,901 horse entries seated in games that could
not end. Nothing in the schema had ever checked the instant before it was
chosen. `20260918064540` adds `fn_ca_fee_cutover_stranded_by(timestamptz)`,
which answers how many live tournaments a proposed instant would strand, and
the BEFORE INSERT trigger `ca_fee_cutover_is_drained`, which refuses to arm
one that would strand any. This pins the trigger to INSERT and nothing wider,
because `accounting_tournament_fee_cutover_immutable` and its no-truncate
sibling already hold every other operation and a precondition asserts that
pair is still all there is; the observer's live-status list; STABLE rather
than IMMUTABLE, since it reads rows that change; both REVOKEs; that the
refusal names the tournament count, the fee count and the oldest offender so
it says what to drain; each postcondition proof, including that the refusal
is read back and matched so the test cannot pass on a primary key violation;
one transaction; and that the rollback never deletes the cutover row.
