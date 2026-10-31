# Terminal recovery reads the complete entrant field

The terminal recovery preflight read only the first PostgREST page of tournament players. In an event above 1,000 entrants it could choose an earlier eliminated player as the winner, miss a second surviving entrant, or send incomplete evidence to the settlement authority. The authoritative database transaction remains responsible for refusing invalid settlement; the truncated preflight could prevent legitimate completion.

Read every entrant through the existing keyset pagination helper and require a complete result before either ordinary or satellite settlement. A later failed page or maintenance freeze keeps recovery unresolved without a money, standings, lifecycle or seat mutation. Existing immutable settlement receipts remain the only write path.

Seven new regressions failed against the prior source. All sixteen focused tests pass after the correction, including the actual recovery entry point for both event types, a winner on page two, a second live entrant on page two, later-page failures and the exactly 1,000-row boundary. Both TypeScript checks pass. This large-field defect is separate from the current small-field retained-hand outage; production recovery is not claimed.

Hosted qualification exposed a source guard still requiring the old single-page expression. It now requires the paginated reader, complete-result gate, null-on-incomplete result and null-on-exception result; the failed-query refusal and settlement ordering assertions remain intact.
