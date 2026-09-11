# Rakeback Claim Readiness

Pending rakeback from an open earning period was labeled Ready To Claim, and the newest pending row could select a club that had no closed period while hiding an eligible older club.

The candidate separates pending earnings from positive closed periods, chooses the first eligible club in display order, refreshes eligibility at UTC midnight, and rechecks the clock on claim. Existing history and the club-scoped claim RPC are preserved. The button says Claim Rakeback, matching its one-club behavior.

Eight focused component tests passed. See `docs/audits/2026-09-11-rakeback-readiness` for input hashes, raw output and proof limits. This UI candidate is preserved on a backup branch for coordinated adoption with the pending server maturity guard; no backend or production capability is activated here.
