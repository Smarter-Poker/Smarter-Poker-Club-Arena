# Empty Seat Truth Closes Stale Seated Tabs

The MultiTable rebuild stopped before reconciliation when the server returned no active seats, leaving the last seated tab open. A successful empty response now reaches the shared pruning policy while deliberate observers, pending buy-ins, lobby pages and hub pages remain available.

Seat admission, auth identity and request fences reject stale responses and schedule a fresh snapshot. Failed reads preserve existing tabs. A voluntary leave stays closed while its cashout row is still active; a genuine new seat can reopen it. Focus restoration and closure notices follow the committed, current result.

Verified with 22 rendered page cases, 39 adjacent checks, two source-window gates, TypeScript, targeted ESLint and a complete local build. The same zero-seat regression fails against the original page. The local build is not a publication artifact, and this change does not establish adoption by already-open legacy tabs.
