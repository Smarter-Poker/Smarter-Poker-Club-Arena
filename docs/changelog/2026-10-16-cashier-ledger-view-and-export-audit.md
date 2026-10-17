# Cashier ledger view and file handoff audit

The Club Bank and Promo Wallet ledger retained old rows, reversal controls and export while a different filter/account was loading. First-page reads now clear those rows and figures, retain the filter directory, and disable export until the replacement response arrives. Load More retains its current page and the existing newest-request guards.

Ledger export previously ignored a false download result and announced success before native sharing completed. It now awaits the guarded shared downloader, reports refusal/rejection, blocks duplicate handoffs and cancels stale account/view exports. CSV escaping, exact columns, BOM, CRLF and the 200-row visible-record cap remain unchanged.

Pending money commands now disable amount/reason edits, recipient and wallet changes, tabs, mint and competing reversal/claim controls until the owning request answers. Existing durable intent keys, authorization and server money commands are unchanged.

Five rendered regressions fail against the preimage. Seven final rendered cases cover delayed bank filters, promo source changes, unavailable/rejected/pending file handoffs, view invalidation, duplicate export and pending-send controls. The focused connected suite passed 248 tests. Baseline full client/contracts passed 37,517 tests in 2,798 files with one existing skipped case; baseline client compilation passed. Repository scans found no unresolved literal route/event/schema references or stranded client-read tables against the maintained manifests. These scans do not certify every runtime path, dynamic reference or allowlisted exception.

The prior Send Out artwork, amount commas and source/amount frame clipping remain in place. The Club Bank Transaction Ledger is retained. No database migration, financial write or engine replacement is part of this correction. Publication and live verification are recorded separately in the task checkpoint.
