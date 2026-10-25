# Cashier initial loading preserves the chosen tab

The production history certificate in run 40224925534 failed while waiting for its first feed and summary responses. The history link is available before the initial membership/roster load finishes. That load unconditionally selected Trade for staff, so an early History click was lost before the scoped reads could begin.

Both initial role-resolution paths now retain the current tab. A player still defaults from Trade to Transaction History, and the existing role-scoped tab invariant still removes unavailable tabs. No financial operation, permission, schema or default staff landing page changes.

Two mounted regressions defer either membership or the first roster page, open History before releasing it, and require the history panel plus both club-scoped read contracts after loading. Both fail against the protected predecessor and pass with the repair. The production certificate keeps all six cases and its successful-response, receipt, cursor, scope, search and viewport assertions unchanged. Publication and an actual subsequent hosted certificate remain separate delivery gates.
