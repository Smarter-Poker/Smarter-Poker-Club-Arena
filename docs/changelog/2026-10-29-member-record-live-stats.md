# Player record live statistics and independent reads

Member-record invalidations and subscription recovery now read the selected date range and apply measured statistics and downline counts in place. The existing record revision refreshes the Win/Loss cards. Identity, wallet reconciliation, notes drafts, editor state and downline rows retain their existing owners. Authority-only boundary events continue to withdraw permissions without reloading the workspace.

Late responses are fenced by the subscription effect, account/club/member ownership, exact range, explicit-read generation and the existing denial epoch. A record renders as soon as its authorized detail is available instead of waiting for its independent downline section. A failed viewer-role lookup closes role controls and reports that lookup without replacing an already verified member with a member-load failure.

Mounted regressions reproduce stale statistics, downline blocking and role-failure blanking against the prior source. Focused checks also cover drafts, access withdrawal, delayed explicit-range replies, reconnect and burst coalescing. No polling, timers, financial writes, transport flags or database changes are introduced. Local qualification is separate from protected delivery and live verification.
