# Preserve cold lobby click failure evidence

The hosted cold-return journey saved and cold-loaded PLO, then failed its original-tab restoration while waiting for a save request. The concurrent click failure was lost when the request wait rejected first, so the report could not establish the click blocker.

Retain both bounded request and click outcomes before closing the document. Record each original error and isolated tab geometry, state, and center hit target in the existing bounded journal without player text or account data. Keep the same 30-second action/request limits, exact owner/club/tab predicates, HTTP acknowledgement, selected-state assertion, and independent fresh-document readback. No retry, product behavior change, or assertion relaxation.

The regression fails before the repair because the request timeout hides the delayed click error; all 21 existing/focused unit cases pass after. One maintained live cold-return case passed in 9.9 seconds with its original MTT selection seeded through the UI and independently read back after restoration. This focused pass does not explain or certify the previous broad hosted failure.
