# Stats Completion Requirements

## Truth And Governance

- TRUTH-01: Exact settlement facts are canonical for cash investment, return, net and BB/100.
- TRUTH-02: Exact, reconstructed and estimated coverage is never silently blended.
- TRUTH-03: Every metric has a versioned definition, source, denominator and minimum sample.
- TRUTH-04: Corrections, duplicates, voids, refunds and replays are idempotently reflected.
- TRUTH-05: Chips, tickets, play units and currencies remain separate unless an explicit conversion is supplied.

## Security And Privacy

- SEC-01: Owners may read their all-club Stats.
- SEC-02: Cross-player reads require an active shared club and return only that club.
- SEC-03: Membership revocation invalidates server and client access immediately.
- SEC-04: Evidence, hole cards, financial values and opponent/cohort data enforce least privilege.
- SEC-05: Sensitive Stats values are excluded from broad analytics autocapture.

## Club Scope

- CLUB-01: All facts and aggregates carry `club_id`.
- CLUB-02: Every RPC, cache, URL, export, report and evidence link carries the same club scope.
- CLUB-03: Owners can select All Clubs or an authorized individual club.
- CLUB-04: The comparison surface sorts by club, hands, profit, BB/100, VPIP, PFR, hours, rake, tournament results and last play.
- CLUB-05: Additive All Clubs values equal the sum of club values; rates are recomputed from numerators and denominators.

## Cash Analytics

- CASH-01: Correct VPIP, PFR, steal, three/four-bet, squeeze and blind-defense opportunities.
- CASH-02: Correct street aggression, continuation-bet, barrel, check-raise, donk and probe opportunities.
- CASH-03: Correct showdown and saw-flop denominators.
- CASH-04: Position, stack depth, table size, heads-up/multiway and in/out-of-position splits.
- CASH-05: Confidence, opportunity count and evidence accompany every conclusion.

## Tournament, Session And Rake

- TOUR-01: Tournament windows use finalized event dates and statuses.
- TOUR-02: Costs and credits come from authoritative registration, rebuy, add-on, refund, prize, bounty and ticket ledgers.
- TOUR-03: Sessions use actual buy-in, rebuy, cash-out, duration and table overlap.
- TOUR-04: Bankroll terminology is used only for authoritative ledger balances.
- TOUR-05: Rake and rakeback honor club/range scope and distinguish zero, empty, partial and error.

## Evidence And Workflow

- EVID-01: Filters execute before cursor pagination.
- EVID-02: Charts, heatmap cells, sessions, trophies, rivals, tournaments and outliers link to exact evidence.
- EVID-03: Browser navigation restores club, range, filters, tab, sort and scroll context.
- EVID-04: Personal Assistant analysis is real, persisted, retrievable, idempotent and evidence-linked.
- EVID-05: Players can bookmark, tag, note and collect study hands.

## Experience

- UX-01: A distinct data-first casino intelligence-room identity avoids repetitive background imagery.
- UX-02: Dashboard modules, density and saved views are customizable.
- UX-03: Loading, empty, partial, stale, provisional and error states are distinct.
- UX-04: Every chart has keyboard, screen-reader and table alternatives.
- UX-05: Mobile, reduced motion, 200% zoom and supported browsers pass.
- UX-06: New-player onboarding explains samples, processing, definitions and unavailable history.

## Operations And Certification

- OPS-01: Fact writes use a durable idempotent outbox and reconciliation.
- OPS-02: Rollups are bounded, resumable, locked and monotonically checkpointed.
- OPS-03: Data-through, rollup lag, missing facts, latency and failures are monitored.
- OPS-04: Exports carry scope, timezone, currency, coverage and schema version.
- OPS-05: Clean-schema replay recreates every Stats relation and RPC from git.
- OPS-06: Database-backed fixtures certify accuracy, authorization, club conservation and recovery.
- OPS-07: Performance budgets gate overview, filters, tabs, charts, exports and payload size.
