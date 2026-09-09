# Every Tournament Payout Names Its Source

Band-aid register item #10 is fixed at the write boundary.

Production contained 32 `tournament_payouts` rows totalling 161.30 chips whose
source was `unclassified`. All 32 were the 2026-09-01 vacant-place correction:
each payout exactly matched its `tourney:<id>:vacantplace:<user>:<place>` key,
its position-repair row, and its wallet idempotency claim. The shared key
classifier did not understand that one grammar, and the credit funnel silently
substituted `unclassified`.

`every_tournament_payout_names_its_source` makes the classification closed:

- `fn_tournament_payout_shape` now identifies that exact grammar as
  `finish_position_correction` and reads the corrected place from the key.
- `fn_credit_and_log` rejects an unresolved or undeclared source before it
  calls the wallet-credit primitive.
- `tournament_payouts.source` has no default, remains `NOT NULL`, and has a
  validated `CHECK` containing every supported payout class, including the
  atomic satellite sources in this release.
- The 32 old labels are corrected only after an exact cohort digest and
  wallet-evidence proof pass. Each correction has an immutable receipt in
  `tournament_payout_source_corrections`.

This changes provenance only. The same 32 wallet claims total 161.30 before
and after the correction; no wallet, escrow or chip-ledger value is written.
There is no fallback, watcher, reconciler or scheduled cleanup path.
