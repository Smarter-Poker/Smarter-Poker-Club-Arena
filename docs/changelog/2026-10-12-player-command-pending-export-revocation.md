# Player Command Pending Export Revocation

A successful same-account, same-club roster summary could confirm that export access had been revoked while an already requested export remained pending. The page hid its controls but did not retire that request, so its late receipt could still start a download.

The original summary consumer now aborts and clears the pending export owner immediately when the successful summary is null or explicitly denies export access. This also clears the busy flag. A summary connection failure retains the prior verified authority rather than inventing a denial. Account, club, unmount and per-request identity checks remain in place. A later restored permission permits a fresh export; the old request cannot finish it.

The existing real-page export clarity tests reproduced both confirmed-denial paths against protected a426015d: two failures, eight passes. After the fix, they verify signal cancellation, no late CSV or success, and a new authorized request after access restoration. A separate connection-failure case preserves the authorized pending export. Final connected export ownership, metric scope and actual response decoder checks passed all 86 cases. The initial post-fix test used a nonexistent denial-page Try Again control; it was corrected to the actual always-present Refresh control without changing assertions.

This client fix adds no SQL, role mutation, financial transaction, retry loop or background repair. The independently fixed export decoder and its before/after regression proof are documented in 2026-10-12-player-command-export-receipt-decoding.md. Protected checks, publication and affected production behavior remain separately recorded in the canonical Player Command checkpoint.
