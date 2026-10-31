# Published downline pagination proof

PR #8510 corrected an initial search-debounce timer that could reset an already expanded downline ledger. The existing trusted client-browser Stats suite now exercises the real published component with 620 isolated read-response rows: Show More retains all rows after 300 ms, while changing search resets to the first page only after its debounce expires.

The case uses the lane's existing isolated authentication and real published JavaScript/CSS. Only three read RPC responses are synthetic, and unknown database mutations are blocked during the interaction. Before/after build identity must match LIVE_SHA; unavailable or superseded identity is explicitly UNKNOWN, never a pass. The test restores routes and clock in cleanup. This proves the published component with isolated data, not production ledger contents or role authorization. No engine replacement is required.

The role-gated Rake tab resolves before its clock is paused. The test then advances less than the initial debounce budget through the real outgoing tab animation, so the old timer remains pending when Show More is clicked.
