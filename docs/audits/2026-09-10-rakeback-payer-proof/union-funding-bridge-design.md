# Prospective Source Funding Bridge

Status: design checkpoint only. No release SQL, production mutation, or completed Union funding claim.

## Captured Baseline

The exact read-only definitions, signatures, MD5 pins and calendar boundary outputs are in union-funding-catalog.json. Round1 reads actual Union rake-wallet credits by created_at, pays the whole interval, moves retained money to generalbank, and refuses an already closed interval. Its basis uses current membership and COALESCE(rate_cash,club_commission_rate,0.90), a fractional rate. The documented cash rule truncates the club payout after grouping rake to cents. Replaying a closed historical period cannot fund newly admitted late sources.
The accepted-owner extension now captures expected Union routing and club terms. That snapshot alone does not prove the rake bank credited its destination. The existing applied contributor receipt proves accrual, not bank or club funding. Positive club and agent wallet balances prove liquidity only.

## Immutable Identities

| Identity         | Authority                                                                         | Must survive                                           |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Accepted source  | Receipt generation 1 plus hand ID and exact accepted payload hash                 | Retries, activation, current hierarchy changes         |
| Earning week     | Original accepted/settled source timestamp, UTC Monday through Sunday             | Late banking and later payment                         |
| Funding window   | Exact bank-credit timestamp mapped with the existing America/Los_Angeles calendar | UTC overlap, 167-hour spring and 169-hour fall windows |
| Bank destination | Committed distribution leg and actual wallet credit                               | Current table or club Union changes                    |
| Recipient terms  | Whole-hand snapshot of booked club, original hierarchy and rates                  | Current membership or status changes                   |

No prior-week selector, containment expansion, current-rate join or timestamp admission guess can substitute for these identities. The payer fixture's earlier timestamp case is synthetic; production accepted receipts use clock_timestamp().

## Proposed Receipt Chain

1. The bank owner atomically binds accepted source hash to the actual rake record, committed distribution leg, route, destination, credited amount and credit time. Conflicting or incomplete acknowledgment refuses. Exact table keys, destination receipt IDs and completeness checks remain under source-owner review.
2. Prospective Round1 records source-linked exact club liabilities and actual released club cents, with the original funding window and source IDs retained. Every release binds the real debit, credit and immutable money journal. Legacy Round1 must exclude these admitted bank legs at the same cutover, including the mixed activation interval.
3. Round2 admits only banked sources whose original club allocation is represented by the new receipt chain. It also consumes sufficient unconsumed released-cash capacity using immutable references; a covered Boolean is insufficient. Liability accrual and available cash remain separate.
4. Player rebates retain captured payer and UTC earning week. Payment requires the corresponding source-agent allocation receipts and sufficient unconsumed capacity, then the actual payer wallet debit. Missing funding or liquidity defers payment without reducing exact entitlement or substituting another payer.
5. Common producer and funding finality must precede final cent apportionment or a settled marker. Calendar age alone is not finality. Unresolved terms and sources remain visible.

## Carry And Conservation Constraints

Two one-cent bank sources in different funding windows each produce zero provisional club cents at 90%, while combined 70% agent entitlement can reach one cent. Therefore source membership alone cannot authorize the downstream cent. The consumption algorithm must preserve exact source/funding-window lots and never consume more released cents than its immutable receipts contain. Cross-window capacity pooling, if implemented, needs explicit receipt allocation and proof; it is not inferred from a shared wallet.
All provisional payments floor cumulative exact entitlement and subtract immutable paid cents. Fractional liabilities remain recorded. Never floor each source and discard the remainder, independently round recipients above total funding, silently clip negotiated rates, or finalize the residue without a witness.
Outer conservation checks must run before every partial-payment return. Preserve existing cache warmup before new sorted club admission; actual rollup refresh holds a transaction advisory lock, so it is not lock-free. The composed lock graph must include standalone Round1, warm-cache, direct agent, direct player, batch and cascade callers.

## Required Composed Proof

- Actual accepted owner, rake bank, Round1, Round2 and player payout with their complete touched-table trigger graph and immutable receipt joins.
- Sunday earning followed by Monday banking; changed Union/club membership, rates, agent assignment and inactive original recipient.
- Pacific 7/8-hour edges, both DST transitions, late sources and mixed activation intervals, with every original source ID funded and paid at most once in its recorded windows.
- Fractional capacities split across windows and recipients, exhausted capacity, funded wallet without source allocation, retained/self-Union and unresolved funding terms.
- Exact-UUID replay, observed native lock races, and all-public-row rollback after each final receipt/journal failure.
- Legacy overlap exclusion, explicit coordinated payer release witness, browser recovery, representative indexed discovery plans, and common finality authority.
  Until these pass, source_active must not activate the new payer merely because source capture exists. Historical settled witnesses remain unchanged.

Review additions: every consumer must take the shared sorted club admission before capacity and wallet locks. Each consumption names the exact immutable release receipt, booked club, original Union/funding window and covered source identity. Database-owned consumed cents must never exceed released cents under concurrent distinct UUIDs. Bank credit and its source binding must commit atomically so legacy Round1 cannot observe an unclassified credit during cutover. Native rollback must include a final receipt failure after a previous recipient consumed capacity, comparing capacity rows and every financial row.
