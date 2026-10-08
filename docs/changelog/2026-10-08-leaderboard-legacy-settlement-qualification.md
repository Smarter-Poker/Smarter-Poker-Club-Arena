# Existing-Club Legacy Settlement Qualification

The prospective historical qualification fixture now prepares a separate unpaid
canonical monthly round using the original program contract before installing
the consolidated candidate. It checks both existing-club legacy cutoffs and
then executes a new candidate settlement, rather than only replaying a batch
paid by the original implementation.

Expected ranking and awards are derived independently from fixed synthetic
counters and original terms. Assertions cover the explicitly incomplete legacy
basis receipt, Promo-only funding, unchanged Club Bank and seed, wallet credit,
idempotency, journal legs, original paid history, same-round replay, and exact
rollback. This is a disposable-fixture change only: production financial SQL,
terms, balances, and immutable history are unchanged.

Source-contract checks are not actual current-schema, Auth, payout, or worker
qualification. Those remain distinct required runtime steps before installation
and launch closeout.
