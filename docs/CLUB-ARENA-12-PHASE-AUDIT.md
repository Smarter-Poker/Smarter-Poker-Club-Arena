# Club Arena Twelve-Phase Audit And Build Programme

Authorized September 8, 2026. Bots, Horses And Real-Time Assistance is excluded as a feature/policy workstream. Shared financial correctness still applies to all accounts. No horse strategy, automation capability, bot policy or real-time assistance enhancement is included.

## Scope And Evidence

All 7,038 entries in docs/audits/2026-09-08-platform-coverage/source-inventory.csv are in the coverage register, within the Club Arena repository only. The 69 discovered World Hub API files are deferred to a separate future build phase; do not read, edit or deploy World Hub as part of this programme. Inventory entries, lexical scans, existing tests and historical completion notes do not establish audit completion. Classify test, archive, generated, development-only and excluded-workstream files explicitly; never silently omit them. Re-pin the Club Arena repository before each phase and review new files added since the baseline. Include assets, configurations, runtime functions, triggers, policies, scheduled jobs, external routes and integrations that were outside the initial lexical inventory.

Each phase must name its exact surfaces, trace callers and effects, compare applicable dated primary-source benchmarks, fix confirmed defects, execute relevant negative/concurrency/recovery tests, and verify merged source and deployed behavior. Preserve the original 216-requirement register and reconcile it to this programme. Absence of a named competitor feature is a comparison item, not automatically a requirement. External fairness certification and jurisdiction-specific assessment require actual independent evidence, never a software-generated certificate.

## Build Order

| Phase | Scope                                                                                | Exit Evidence                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Cashout outcome propagation and departure correctness; coverage and release baseline | Valid receipts required by both shared cashout helpers; failure reaches callers; eviction events and roster removal follow confirmation; all-in skipped players remain; regression tests and deployed engine source verified                                               |
| 2     | Poker rules and fairness for every supported variant                                 | Legal actions, short all-ins/reopening, heads-up blinds, side pots, odd chips, ties, split boards, muck/show, RNG/shuffle/deck integrity and hidden-card access reviewed; independent certification status explicit                                                        |
| 3     | MTT, SNG, Spins and satellites                                                       | Entry/re-entry/rebuy/add-on, blind clocks, breaks, seating/balancing, payout ladders, multipliers/reserves, guarantees, bounties/PKO/mystery, final-table deals, cancellation and outage behavior tested per format                                                        |
| 4     | Cashier, wallets, tickets and every chip movement                                    | Club Arena client and database financial paths traced; external API dependencies recorded as deferred World Hub verification; authorized source/destination, asset precision, escrow, approvals, reversal/refund, payload-bound retries and balanced receipts verified     |
| 5     | Rake, hierarchy, BBJ, backup BBJ and promotions                                      | Weighted attribution separate from payment; caps and rounding; union/club/super-agent/agent/sub-agent/player flows; main BBJ receives 50 percent, remaining split verified from approved configuration; all reserves and payout legs reconcile                             |
| 6     | Identity, authorization and account security                                         | Login/recovery, session expiry/revocation, device/account switch, club/union isolation, privileges, RLS, definer functions, secrets handling and API authorization tested                                                                                                  |
| 7     | Reconnect, outage recovery and real-time transport                                   | Installed home-screen shell, background/resume, Wi-Fi/cellular changes, dropped/duplicated/out-of-order events, stale auth, durable commands, maintenance thaw and interrupted-hand recovery tested                                                                        |
| 8     | Lobby, seating and multi-table play                                                  | Occupancy, discovery/filtering, observer access, waits/reservations, simultaneous seat claims, buy-in feedback, warm tables, correct table/hand targeting, focus and notification behavior tested                                                                          |
| 9     | History, statistics, reporting and configuration                                     | Hand replay/export, sessions, player stats, transaction histories, dashboards, financial reports; every hardcoded cap/rate/timer/default assigned to its authority and checked against UI/engine/DB behavior                                                               |
| 10    | Integrity, player protection, support and club operations                            | Collusion/chip dumping/multi-accounting review and evidence workflow, disputes/appeals, responsible-play tools, access eligibility assessment, management alerts; club membership/admin, unions, agent workspaces, messaging/moderation and notifications audited          |
| 11    | Every page, feature and visual interaction                                           | Route and component coverage, desktop/mobile/accessibility, navigation, loading/error/empty states, touch targets, reduced motion/audio, cards/animations, inventory/store/VIP/rewards/promotions/social features and assets verified                                      |
| 12    | Performance, resilience and final integration                                        | Measured action/connection/hand-gap latency, load and memory, DB/index/WAL behavior, backups through restore drills, monitoring, publishing/rollback, dependency/security review and full cross-phase regression; remaining unreviewed rows resolved or explicitly blocked |

## Repository Boundary

User clarification: Club Arena only for now. World Hub is a separate future build phase. The cross-repository API inventory is retained as historical discovery, not current authorization. When an end-to-end acceptance item requires World Hub changes or inspection, record that dependency and leave the cross-repository claim unverified. Do not touch the World Hub repository.

## Binding Product Rules

Tournament unregistration only before start; return chips to the originating wallet through the common refund path. Separate cancellation payouts from voluntary unregistration. Do not invent a satellite refund subsystem. BBJ main allocation is 50 percent; do not guess the backup/promo division. Weighted rake attribution is a statistic, not another spendable payment. Preserve approved hierarchy margin and rate rules after verifying their configuration. Financial discrepancies are surfaced to management without blanket table/club lockdowns. Do not perform historical backpay, manual wallet changes or forced engine restarts. F30's no-new-band-aids source gate remains in force.

## Phase 1 Verification Status

In progress. Earlier accounting #3807 and cashout receipt #3809 are merged, but their runtime adoption is independently tracked. Additional defects reproduced here: unhandled cashout failures returned zero as success; eviction emitted seat_left before confirmation; final roster filtering removed all-in players whose eviction was skipped. This phase changes the shared error contract and confirmed-departure filtering. It does not certify the remainder of the financial system.

Regression baseline: 16 failures with 28 passing tests before the correction. After correction, 73 focused tests across four files passed; server TypeScript passed. Broader push gates and deployed engine verification remain required. Do not label this phase complete while either is pending.

## Required Phase Summary

Only after all exit evidence is satisfied: Phase N Of 12 Is Done, followed by concrete changes, tests and deployment evidence, remaining limitations outside that phase, then Ready To Start Phase N+1 Of 12. If a gate is pending, say Phase N Of 12 Is Not Complete and identify the missing evidence. Never use a partial pass to advance the phase counter.

### Phase 1 Follow-up: Zero-stack Departure

The zero-stack no-rebuy sweep also emitted departure before cashout confirmation and attempted a different fallback after failure. Two behavioral tests reproduced premature events. The sweep now waits for the same atomic cashout receipt before its event and cleanup, retaining seat and grace tracking for retry on failure. Pending-ledger rebuy, prompt grace and live all-in protections remain in place.

September 8 verification: 74 focused tests across receipt, eviction, rebuy-ledger and sit-out safeguards passed; server TypeScript passed. PR #3818 merged as ab0f53926ac53c7b8b3d0d7be1278e9fd08e7500. This follow-up still requires its own push gates, merge and engine adoption evidence. Phase 1 remains incomplete.

## Original Requirement Register Reconciliation

The original 216 requirement IDs and control text are preserved in docs/audits/2026-09-08-platform-coverage/phase-requirements.json, extracted from Smarter-Poker-Club-Arena-Audit.docx version 22 (SHA256 recorded in the JSON). Extraction verified 216 rows and 216 unique IDs. Every original requirement has a primary phase or explicit user exclusion; cross-phase scope notes prevent partial evidence being mistaken for a full requirement pass. G07 is retained as excluded, G06 excludes the real-time assistance clause, and World Hub portions of cross-repository requirements remain deferred. All included rows remain pending full requirement verification. This is a scope reconciliation, not 216 completed audits.

Primary-phase assignment counts: 1:4, 2:18, 3:58, 4:26, 5:52, 6:9, 7:13, 8:3, 9:9, 10:6, 11:10, 12:7; one excluded row. The 7,038-file inventory adds implementation coverage beyond these controls. Phase 1's engine/service integration adds eight passing tests with isolated database transport; live adoption and behavior remain separate gates.
