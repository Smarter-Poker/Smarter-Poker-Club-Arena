# Preserve verified arena access after a PostgREST-wrapped abort

The reported King’s Club member route recorded `AbortError: signal is aborted without reason` across member-detail and authority reads at the screenshot time. The surrounding provider window contained successful HTTP 200 arena-context responses, and the stored club identity is valid; these observations do not establish the underlying browser lock/network abort owner.

PostgREST flattens a rejected fetch into an error object containing the original error name as a message prefix. ArenaContextService wraps that object in an ordinary Error. The access classifier recognized a native AbortError name but not its wrapped message, so an unreadable transient check could become Unavailable and remove a previously verified same-account page.

Recognize only the exact AbortError message prefix when no SQL/PostgREST error code exists. Reuse the existing bounded-read recovery and same-account/club generation fence. Initial failures grant no access; genuine sign-out, permission refusal, server failure, malformed identity and membership denial remain enforced. No lock override, synthetic membership, new retry loop, financial mutation or engine change.

Regression fails on the observed wrapped error before the fix; classifier and mounted-boundary tests pin Delayed on initial failure and retention of an already verified draft. Full live recovery and the original browser abort owner remain separate verification requirements.
