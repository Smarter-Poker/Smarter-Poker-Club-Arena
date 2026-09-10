# Source Round2 Commission Proposal

This is a disposable review prototype, not a production migration. It is not ready to enable. The current installed Round2, legacy direct claim, and Union cascade have not been changed by this directory.

## Problem And Proposed Accounting

Installed Round2 selects `agent_commissions.created_at` inside a settlement interval, excludes whole settled intervals, and joins the current active agent. That does not preserve captured historical recipients or late source attribution. Prospective cash commission `amount` is a compatibility projection; it cannot authorize source payments.

Per-hand cent rounding loses valid fractional liabilities: 100 sources of 0.01 rake at 25% have exact liability 0.25, whereas summing each rounded commission gives zero. Recomputing rounded cumulative hierarchy differences is also unsafe for provisional payments. At 50% direct and 70% parent, a parent's rounded difference falls from 0.02 on 0.08 rake to 0.01 on 0.09 rake. This proposal never claws back money.

The prototype accrues immutable exact, nonnegative differential entitlement per accepted source/contributor/captured agent and releases `floor(cumulative_exact * 100) / 100 - immutable_paid_receipts` per booked club, captured recipient, and UTC earning week. Changing captured agent IDs does not reset that recipient's within-week fractions. Exact unpaid fractions remain visible. This is a provisional rule for review; it does not declare a final contractual rounding policy.

The credited account is `club_members.chip_balance` at the captured booked club and recipient user. This is the same account the player payer debits for the captured agent. The journal records `player_wallet` with the booked club, matching the installed Round2 account model.

## Source Identity And API Scope

Admission requires the immutable accepted receipt's supported generation 1 and complete-envelope hash:

```sql
authority.contract_version = 1
AND h.hand_id = s.hand_id
AND h.commission_capture_version = authority.contract_version
AND h.post_commit_payload_hash = s.accepted_payload_hash
```

The base request `payload_hash` is a different hash. An activation timestamp alone is not source authority. The native earlier-timestamp case is deliberately synthetic; it is not a demonstrated production overlap defect. The installed accepted receipt uses `clock_timestamp()`, as independently confirmed by the capture lane.

The proposed browser claim requires `(club, expected_user, request_uuid)`. It checks the authenticated user before acquiring the request lock and returns the immutable original result on exact replay, including after later sources arrive. A request UUID cannot change actor or club. Direct payment is service-only and retains a caller guard. All payment entry points use the same sorted club admission lock namespace as the player payer. The duplicate helper must become one shared SQL stage when the proposals are composed.

## Verified Scope

Run `bash docs/audits/2026-09-10-source-round2-proof/run-local.sh` from this tree on the reviewed Mac. The runner creates PostgreSQL 17 with a private Unix socket, no TCP listener, and deletes the disposable cluster on exit. It requires Node, the repository's `pg` dependency, and the Homebrew PostgreSQL 17 binaries.

The proof imports captured table/constraint definitions, the exact installed treasury debit function, 17 selected actual financial triggers, and three append-only guards. The source facts, applied contributor receipts, accepted receipt generation, identities, balances, and timestamps are explicitly seeded fixture data. The source accepted owner, real banking owner, actual Round1, and complete production trigger composition are not executed here. The small accepted receipt relation is synthetic and only models the generation/hash join.

`native-proof.json` contains 17 passing groups, observed lock evidence, the runtime, and SHA-256 hashes of every executed input. The installed treasury function body is checked against its captured MD5. Tests cover fractional accumulation, recipient deactivation, separate earning/admission timestamps, source generation/hash exclusion, exact and concurrent replay, expected-user scope, shared club admission against direct payment, immutable linked money records, and rollback of every public fixture table after final receipt failure. A second-recipient failure also rolls back the preceding recipient in the same transaction. That is not a claim of executing the real Union cascade.

## Release Blockers

1. An applied contributor receipt proves accrual admission, not Union-to-club source funding. This prototype currently gates cash by the treasury balance after accrual; that is insufficient for release. It must consume actual immutable source-linked club funding receipts before deployment.
2. The bridge must preserve both the UTC earning identity and the Pacific funding identity derived from the exact bank credit receipt, including DST and late banking. Merely selecting an overlapping or previous UTC week changes accounting scope.
3. The bridge also needs unconsumed released-cash capacity, not only a source-covered Boolean. Two separate 0.01 sources at a 90% club rate can each release zero cents under separate Round1 groups, while a combined recipient's 70% exact entitlement can reach one cent. Source membership alone cannot prove that cent was released to the club.
4. Prospective source bank legs must be excluded from the legacy aggregate Round1 sweep atomically with activation. Source cash compatibility projections must be excluded from legacy Round2 and direct claim authority, or all callers must share the same canonical payment receipt. These cutovers are not implemented here.
5. This prototype retains fractions per UTC week but does not cash-carry them between weeks. Cross-week/term release, final residual apportionment, and final statements require an agreed liability owner and genuine final-source witness. Calendar age does not certify finality.
6. Player payouts must prove matching source-agent funding coverage and consume available captured payer funds. A positive agent wallet alone is not source coverage. The direct agent's gross allocation must also fund its player rebate under the captured margin contract.
7. Whole accepted-owner, bank, Round1, Round2, player payer, direct legacy claim, and actual cascade integration/races remain required with complete captured dependencies. Current legacy claim member-first locks differ from installed Round2 treasury-first locks; shared admission must cover every participating caller before that race is certified.
8. Reporting, rollup recomputation, interval settlement markers, and durable paid status must adopt the source receipts. Existing created-at projections and whole-period markers are not release evidence.

No historical source is manufactured or backpaid. No production SQL, push, deployment, new cron, engine-host change, or Stage B change was performed for this proposal.
