# Keep the first player read and certify the correct settings response

The hosted browser run 38944316551 exposed two verification blockers. Club Data could keep showing Loading Players when repeated background refreshes replaced an unfinished first player read. The Auto Time Bank persistence test could capture the other settings owner's partial-column read, which does not select Auto Time Bank, and fail before checking the real persisted value.

Club Data now joins its bounded first read instead of replacing its ownership. Manual refresh waits for that read's actual result. Deliberate sort and club changes still replace the query, and late responses cannot clear the new club's loading state or rows. First-load failures retain the existing bounded request diagnostics for both player RPCs.

The settings test now accepts only a read that selects the asserted column. Its saved-value and rendered-control assertions are unchanged. A focused regression rejects the competing partial projection while accepting full and explicit Auto Time Bank reads.

The component regression failed before the repair (eight RPCs instead of two) and passed afterward; all 73 affected Club Data tests passed. The settings matcher regression failed before and all three contract tests passed afterward. The corrected Auto Time Bank browser case passed against production with an isolated zero-funded account. Protected checks, publication, complete hosted coverage, and final live acceptance remain delivery requirements.
