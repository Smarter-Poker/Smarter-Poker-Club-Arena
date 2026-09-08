# Club Arena comprehensive audit and remaining-work register

Prepared 2026-09-08. Source baseline: `79b1c71433d3ebf15d4e5fcdba4d4ee106e2dc2a`. Source census: 16:31:17 UTC. This expands the existing [12-phase programme](../../CLUB-ARENA-12-PHASE-AUDIT.md); it does not replace its sequencing or claim all phases complete.

## Outcome and limits

The current accounting batch is complete: the original BBJ incident has a source-proven missing journal leg, the scoped wallet confirmation and history changes are merged, and agent self-stake transaction context is hardened. The interrupted-hand retry change is present in the observed running engine. Broader Club Arena correctness is **not yet certified**. This document supplies the requested remaining-work list after that batch, with 109 work items and file-level inventories.

A transaction must commit its authorized balance changes, complete journal, receipt and business-state transition together, or commit none of them. Business retries must reuse the same payload-bound operation identity. These are enforceable invariants; software cannot honestly be promised never to fail or regress. Network errors must not become partially committed accounting. External payment effects also need a durable intent and destination idempotency; a database transaction alone cannot control an external network.

No new watcher or reconciler is proposed. Existing repair dependencies must be retired only after the source invariant is proved. No approved economic rates, blanket table lockdowns, forced engine restart, guessed historical balance migration or new satellite refund subsystem is included. Main BBJ allocation remains **50%**; the remaining backup/promo split must follow approved configuration, not an assumed 25%/25%.

## Completed current batch: evidence, not global certification

| Change                                                       | Completion evidence                                                                                                                                                                                                                                                                                                                  | Remaining boundary                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Original BBJ incident `ca15a882-0066-425f-94a7-2a6cf636840e` | Migration `20260908160032` applied; PR [3828](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/3828) merged at the source baseline. New journal `845feaac-9bd0-4d3e-852d-690cc5d1b1d8` supplies the missing main leg.                                                                                                  | This proves one incident's correction and tested guards; it does not resolve every historical incident. |
| BBJ forensic correction                                      | Source contribution `f390afc0-7cb4-432f-9ef7-9bc8a00245dc`: total .50 = main .25 + backup .12 + promo .13. Failure 871 recorded the main autoledger lock timeout. No balance was changed.                                                                                                                                            | The old incident resolution was preserved in metadata rather than silently overwritten.                 |
| Correction verification                                      | 24 isolated PostgreSQL cases passed: success/replay, 11 evidence refusals, 10 journal/incident fault cases, absent historical event. Combined suite also passed. Reconstructed interval: main 264.06, backup 132.03, promo -.65, each exactly matching movement.                                                                     | These test counts are scoped and must not be summed into a platform coverage percentage.                |
| Wallet confirmation/history                                  | PR [3804](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/3804), merge `a2ebcf7bf4316afcdaffecbf946b9b35aeb776eb`; 30 wallet/store tests and type checking passed; prior static adoption verified. Strict receipts, finite amounts, duplicate client history removal and removal of automatic unkeyed transfer retry. | Active legacy agent self-transfer routing remains open below.                                           |
| Agent self-stake context                                     | Migration `20260908151800`, PR [3806](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/3806), merge `2d5f335f84c2115af4cb961abf472ef0b2dc972f`; 30 PostgreSQL cases passed; live body hash `438f699e38c8e2e6a9949c76e526731b` verified. Eight transaction-local context settings restored.                             | Does not prove every UI calls this canonical operation.                                                 |
| Hand retry request identity                                  | PR [3799](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/3799), merge `af943dde50f2cc4003cb7355e167c7a5983d1452`; 40 hand-history and 19 lease tests plus type checking passed. Observed engine `c3821317` contains the merge.                                                                                       | Durable recovery of an interrupted active hand remains open.                                            |

The BBJ main journal carries the witnessed original event time, with actual recording time **2026-09-08 16:00:32.815419 UTC** separately preserved in metadata. It is an explicit journal-only correction; existing journal rows and pool/player balances were not edited. The autoledger now rethrows failures (observed hash `2ff8923b4c2d8fd3d343cf37acce0f2c`). The migration first refused a scheduled freeze; it was applied after verified thaw without bypassing that guard.

Earlier scoped batch work also covered journal failure propagation, satellite funding, cashout escrow, duplicate hand rosters, union period overlap, BBJ identity/routing, insurance, cashout ordering, shared account funding, ticket escrow context, agent send/claim context and shared rebuy receipts. These are recorded in the [checkpoint](../2026-09-08-chip-audit-checkpoint.md), migration history and their change records; that checkpoint includes historical states and is not the current global certification.

PR 3828 CI run `34250579506` passed its required source gates, TypeScript, four client shards and server-engine tests; silent-revert run `34250579552` passed. Live production E2E, post-deploy, CSS animation and production-build jobs were skipped in that run, not passed. The database correction is verified live. Source merge, static publication and engine adoption are separate evidence states.

## Highest-priority open findings

1. **Legacy agent self-transfer is still wired.** `WalletService.agentSelfTransfer` routes through BUSINESS-to-PLAYER `internalTransfer`. `AgentPortalPage` supplies the auth user ID, while `src/components/dashboard/AgentFinancialPortal.tsx` supplies an `agents.id` primary key. Live `fn_wallet_type_transfer` still writes `public.wallets` (hash `b54ab7050103eecf3b456969e5a71bbd`). The different `wallet_user_transfer` is explicitly retired (hash `3f198dff0553cdb494257eee66df0a1b`). Canonical club self-stake must be wired with correct identity, club, receipt and balances; legacy funds must not be guessed or remapped.
2. **Agent transfer retry identity is created inside each call.** `AgentService.transferToPlayer` generates `p_op_id: uuid()` per invocation, accepts truthy `res?.success`, and checks positive amount without an explicit finite-value check at that boundary. Repeating a business intent can therefore get a new key; full caller impact still requires tracing.
3. **Interrupted cash-hand recovery is incomplete.** `ServerTableEngineBase.checkCrashRecovery` completes the snapshot and advances hand count without rehydrating `HandController`. A durable accepted-hand/action protocol and deterministic interrupted-hand disposition are still required.
4. **Snapshot completion precedes settlement.** `ServerTableEngineSettlement` starts asynchronous `completeHandSnapshot(...).catch(reportError)` before rake/BBJ capture and authoritative settlement. Crash-point tests must prove completion cannot hide unsettled state. The shared canonical hand settlement RPC now exists; the stale claim that all hand financial legs always use unrelated transactions must not be repeated.
5. **Seven disabled tournament triggers need evidence.** Their status is a catalog fact, not proof of an exploitable defect. Verify replacement constraints and authorized retirement before changing them.
6. **Repair debt remains.** The allowlist has 32 entries, including functions and jobs, not 32 proven active jobs. Each needs source-root closure and retirement evidence.
7. **The original 216-requirement register was not located.** Tracked documentation contains references to it. Recover the original IDs and cross-map them; the 109 IDs below are new work-item identifiers, not a substitute invented version of those 216 requirements.

Disabled trigger names: `aa_guard_tournament_completing_claim`, `aaa_guard_atomic_satellite_completion`, `zzzz_freeze_finalized_tournament_prize_pool`, `zzzz_tournament_pool_finalization_window_guard`, `zzzz_tournaments_atomic_place_completion_guard`, `zzzzz_tournaments_atomic_final_table_deal_completion_guard`, `zzzzzz_tournaments_financial_certificate`.

Concurrent cashout/eviction fixes on current main must be assessed against their own tests and deployed engine version. Older findings about missing failure callbacks, departure-before-cashout and all-in removal must not be reopened as current defects without rechecking the merged source. Phase 1 remains in progress until its acceptance evidence is complete.

## What was inventoried, and what has not been thoroughly checked

| Register                                                    |                      Coverage | Interpretation                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Every tracked file](file-register.csv)                     |                        10,617 | Git blob identity for all tracked files; configuration/assets indexed, not all content-reviewed.                                                                       |
| Source census                                               | 7,048 files / 1,672,781 lines | Read under src, server, supabase, scripts, tests, e2e and .github for selected source extensions. No file-read errors. Reading/discovery is not semantic verification. |
| [Pages and tabs](page-and-tab-register.csv)                 |                           125 | All TSX files under pages, including nested/development surfaces; each has imports, dependency candidates and open acceptance checks.                                  |
| [Route declarations](route-register.csv)                    |                           168 | 134 in App.tsx; layouts, redirects, tests and wildcards included. Not 168 unique production pages.                                                                     |
| [Controls](ui-control-register.csv)                         |                         3,833 | JSX control/event candidates. Dynamic controls require additional tracing.                                                                                             |
| [Functions and callbacks](function-register.csv)            |                        69,497 | Includes 27,897 runtime/tooling, 40,247 test/fixture, 214 dev/preview, 1,136 archive and 3 asset/data nodes. Not unique business operations.                           |
| [Imports](module-import-register.csv)                       |                        14,891 | Static dependency candidates; aliases and dynamic imports require review.                                                                                              |
| [Calls and navigation](callsite-register.csv)               |                         3,834 | RPC, relation, event, HTTP and navigation candidates.                                                                                                                  |
| [Server dispatch](server-dispatch-register.csv)             |                            28 | Router URL branches, not a complete endpoint/security inventory.                                                                                                       |
| [Historical SQL declarations](sql-declaration-register.csv) |                         3,481 | Historical declarations, not authoritative current definitions.                                                                                                        |
| [Live RPC catalog](live-rpc-register.csv)                   |     467 overloads / 456 names | Every literal RPC name found in scanned non-test/non-archive source exists. Signatures, hashes and grants observed; bodies not all audited.                            |
| [Live relations](live-relation-register.csv)                |                           179 | RLS enabled on observed ordinary tables is not proof policies are correct.                                                                                             |
| [Live triggers](live-trigger-register.csv)                  |                           365 | Includes seven disabled triggers requiring explanation.                                                                                                                |
| [Existing repair debt](existing-repair-debt-register.csv)   |                            32 | Allowlist entries, not a count of currently running repair jobs.                                                                                                       |
| [Marker candidates](marker-candidates.csv)                  |                            41 | TODO/FIXME/HACK/STUB lexical matches, not confirmed defects.                                                                                                           |

The 467 observed RPC overloads include 426 security-definer and 21 anon-executable overloads. Exposure alone is not an exploit finding; every relevant body and authorization chain still needs review.

**Explicitly unverified:** every page's full role/state/browser matrix; every control's actual outcome; complete call graphs; dynamic imports/routes/RPCs; indirect/private helper closure; indirect database tables; live cron/manual write doors; storage policies; configuration and asset content; all variant rules and randomness; end-to-end tournament/bounty interruption; peak-load behavior; backup restoration; cross-browser/accessibility behavior; all production deployment paths and remaining historical incidents. The unresolved relation candidates `assets`, `club-assets`, and `images` may be storage buckets, and are not declared missing-table defects.

No World Hub repository was read, changed or deployed. Its previously identified API surface remains deferred. Bot strategy and real-time assistance enhancement are excluded; shared financial correctness for all accounts remains included.

## Benchmark references

These are engineering and product benchmarks, not a claim of certification or a statement that every operator uses the same implementation.

| Reference                                                                                                          | Applicable comparison                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)                     | Appropriate transaction isolation and concurrency control; serialization failures require retry of the whole transaction, preserving one business identity.                                 |
| [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)                                      | Stable request keys and parameter binding illustrate safe retry semantics. Its retention choices are not adopted as universal journal policy.                                               |
| [GLI-19 v3.0](https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf)        | Interrupted-game handling and verifiable game/account records provide a benchmark for recovery and evidence. This is not a GLI certification or jurisdictional applicability determination. |
| [OWASP ASVS 5.0.0](https://owasp.org/www-project-application-security-verification-standard/)                      | Versioned security verification for authorization, sessions, validation and sensitive interfaces.                                                                                           |
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/)                                                                          | Keyboard, focus, labels, status messages, reflow and financial error prevention; target AA-oriented review.                                                                                 |
| [PokerStars contribution-based reward points](https://www.pokerstars.com/help/articles/sr-rewards-pts-ring-games/) | Illustrates contribution-weighted attribution. It does not disclose their private accounting architecture or justify changing Club Arena's approved payout rates.                           |

## Work-item rules

The [machine-readable backlog](feature-backlog.csv) and the phase list below contain the same 109 items. P0 concerns financial conservation, authoritative game state, privileged access or irreversible outcome integrity; P1 concerns completion, operational correctness and user experience; P2 concerns lower-risk cleanup. Priorities guide triage within the authorized programme and do not silently change its phase sequence.

“Confirmed gap” identifies observed source behavior with a concrete missing boundary. “Needs audit” is unverified scope, not a claim a bug exists. “Concurrent fix awaiting acceptance” requires fresh release evidence. No item is closed solely because a file was scanned or a catalog row exists.

For **each of the 125 page rows**, review route/deep link, all roles, club/union scope, imported components, every control, API/RPC payloads and receipts, realtime updates, loading/empty/error/offline states, narrow/mobile/desktop rendering, keyboard/focus, and refresh/back navigation. Record exact commit, environment, test evidence, discovered defects and resulting status. Apply the same trace to controls outside page files and dynamically created surfaces.

For each financial operation, acceptance must include competing spends, duplicate requests, changed payload with reused key, unauthorized identities, non-finite/precision boundaries, injected rollback at each write, lost response after commit and correct receipt replay. Corrections must preserve history and cite evidence; no arbitrary balancing adjustments.

## Detailed remaining work

### Phase 1: Cashout and release baseline

- **CA-01-01 · P0 · Departure ordering** — Concurrent fix awaiting acceptance. Trace the merged cashout eviction outcome through leave, kick, sit-out expiry and shutdown; prove departure cannot precede a confirmed disposition. Entry point: `server/src/engine/ServerTableEngineBase.ts`. **Close when:** Reject/timeout/lost-response and concurrent leave/kick tests; normal deployed engine runs the tested commit.

- **CA-01-02 · P0 · Cashout business identity** — Needs audit. Bind one durable operation ID to player, club, table, seat generation, currency and amount across retries. Entry point: `src/services/WalletService.ts`. **Close when:** Same request returns the original receipt; changed payload is rejected; duplicate requests never credit twice.

- **CA-01-03 · P0 · Seat and escrow ownership** — Needs audit. Trace stack, committed bets, side pots and escrow at every departure boundary. Entry point: `server/src/engine/ServerTableEngineSettlement.ts`. **Close when:** Conservation before and after departure with an active hand, all-in, disconnect and seat reuse.

- **CA-01-04 · P1 · Release provenance** — Needs audit. Map each scoped fix to migration, merged source, test evidence and actual adopted runtime. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** Separate database, static frontend and engine versions; no pending adoption marked complete.

- **CA-01-05 · P1 · Original requirement register** — Needs audit. Recover the original 216-requirement register and cross-map its actual identifiers. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** Every original requirement has evidence or an explicit open status; do not reconstruct invented IDs.

- **CA-01-06 · P1 · Obsolete candidate changes** — Needs audit. Keep superseded hand-commit and dedicated rebuy-receipt branches out of deployment. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** Deployment ancestry excludes superseded alternatives and uses the shared canonical protocols.

### Phase 2: Poker rules and fairness

- **CA-02-01 · P0 · Legal action authority** — Needs audit. Review server legality for check, call, bet, raise, fold and all-in for every supported variant. Entry point: `server/src/engine/HandController.ts`. **Close when:** Adversarial clients cannot act out of turn, spend beyond stack or bypass betting limits.

- **CA-02-02 · P0 · Short all-in reopening** — Needs audit. Verify minimum raise and reopening rights across multiple short all-ins. Entry point: `server/src/engine/HandController.ts`. **Close when:** Table-driven rule examples cover intervening action and cumulative raises.

- **CA-02-03 · P0 · Side pots and eligibility** — Needs audit. Review contribution grouping, folded players, refunds of unmatched bets and zero-stack seats. Entry point: `server/src/engine/HandController.ts`. **Close when:** Independent expected allocations balance exactly for multiway all-ins and folds.

- **CA-02-04 · P0 · Split and odd-chip allocation** — Needs audit. Review ties, high-low qualification, multiple boards and odd-chip priority. Entry point: `server/src/engine/VariantRules.ts`. **Close when:** Exact smallest-unit conservation; deterministic rule-correct allocation on every board.

- **CA-02-05 · P1 · Blinds and position** — Needs audit. Review heads-up transitions, dead buttons, missed blinds, straddles and new seats. Entry point: `server/src/engine/HandController.ts`. **Close when:** Position and blind obligations remain correct through departures and table merges.

- **CA-02-06 · P0 · Variant rule matrix** — Needs audit. Enumerate configured variants and trace evaluator, deck and betting rules per variant. Entry point: `server/src/engine/VariantRules.ts`. **Close when:** Every selectable variant has independent evaluation vectors and full hand tests.

- **CA-02-07 · P0 · RNG and hidden information** — Needs audit. Review shuffle entropy, deck uniqueness, server ownership and card access across logs, sockets and history. Entry point: `server/src/engine/HandController.ts`. **Close when:** No duplicate cards, predictable client influence or unauthorized hole-card/deck disclosure.

- **CA-02-08 · P1 · Showdown and muck** — Needs audit. Review automatic reveal, winner disclosure, muck choices and history visibility. Entry point: `server/src/engine/HandController.ts`. **Close when:** UI and server agree on visibility; privileged and spectator paths cannot leak private cards.

- **CA-02-09 · P1 · Bomb pots and runouts** — Needs audit. Review bomb-pot scheduling, mandatory contributions, multi-board settlement and cancellation. Entry point: `server/src/engine/BombPotScheduler.ts`. **Close when:** Collection and awards remain balanced across errors and table population changes.

- **CA-02-10 · P1 · Decision timers** — Needs audit. Review timeout actions, time banks and clock authority through reconnect and maintenance. Entry point: `server/src/engine/HandController.ts`. **Close when:** One authoritative action occurs at deadline; stale timers cannot act on a new hand.

### Phase 3: Tournaments, SNGs, Spins and satellites

- **CA-03-01 · P0 · Entry and re-entry** — Needs audit. Trace registration, late registration, rebuy and addon through wallet debit, prize allocation and seat creation. Entry point: `live-rpc-register.csv`. **Close when:** Atomic failure injection and concurrent retry tests prove one funded entry per operation.

- **CA-03-02 · P0 · Bounty PKO accounting** — Needs audit. Trace entry bounty split, knockout allocation, progressive carry and final winner disposition. Entry point: `page-and-tab-register.csv`. **Close when:** Prize, fee and bounty liabilities reconcile algebraically within each committed operation.

- **CA-03-03 · P0 · Mystery bounty commitments** — Needs audit. Review funded award inventory, eligibility, random draw, reveal and retry identity. Entry point: `live-rpc-register.csv`. **Close when:** One funded award per eligible draw; retries cannot reroll or consume multiple awards.

- **CA-03-04 · P0 · Payout plan authority** — Needs audit. Review current canonical payout plan, rank finalization and idempotent awards; recheck concurrent fixes before opening defects. Entry point: `live-rpc-register.csv`. **Close when:** No partial completion; each recipient and retained liability matches the immutable approved plan.

- **CA-03-05 · P0 · Disabled tournament safeguards** — Needs audit. Explain all seven disabled triggers and prove replacement invariants and authorized retirement. Entry point: `live-trigger-register.csv`. **Close when:** Each disabled guard has replacement evidence or a tested source correction; no blind re-enabling.

- **CA-03-06 · P0 · Deals and final table completion** — Needs audit. Review deal acceptance, participant binding, chip-based calculations and post-deal completion. Entry point: `live-rpc-register.csv`. **Close when:** All required consents match one versioned plan; no double payout or mutable finalized pool.

- **CA-03-07 · P0 · Guarantees and overlays** — Needs audit. Review funding source, fee separation, minimum entries and guarantee changes. Entry point: `live-rpc-register.csv`. **Close when:** Every overlay is funded and journaled; published commitments cannot silently change.

- **CA-03-08 · P0 · Spin multiplier and prizes** — Needs audit. Review draw commitment, multiplier persistence, funding and restart behavior. Entry point: `existing-repair-debt-register.csv`. **Close when:** A started game has one funded immutable prize; retry and outage cannot redraw.

- **CA-03-09 · P1 · Tournament seating and clocks** — Needs audit. Review balancing, table merges, breaks, blind levels, heads-up transitions and duplicate seats. Entry point: `page-and-tab-register.csv`. **Close when:** Concurrent moves preserve one seat per entry and one authoritative tournament clock.

- **CA-03-10 · P0 · Satellite awards and ticket liabilities** — Needs audit. Review the hardened funding path plus ticket mint, ownership, redemption and award completion. Entry point: `live-rpc-register.csv`. **Close when:** Tickets and underlying liabilities are created/redeemed once with recipient and tournament binding.

- **CA-03-11 · P0 · Unregister, cancellation and outage** — Needs audit. Review approved pre-start unregister and common origin-wallet refund; inspect cancellation and interrupted-event policy. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** Refunds return once to the proper origin; no invented satellite refund subsystem.

- **CA-03-12 · P1 · Tournament client wiring** — Needs audit. Exercise all create/edit/register/rebuy/addon/deal/results pages and permission states. Entry point: `page-and-tab-register.csv`. **Close when:** Displayed options, server acceptance and persisted state agree for MTT, SNG and Spins.

### Phase 4: Cashier, wallets, tickets and issuance

- **CA-04-01 · P0 · Legacy agent self-transfer routing** — Confirmed boundary gap. Replace active legacy wallet-pool self-transfer with club-scoped canonical self-stake after identity and ownership mapping. Entry point: `src/services/WalletService.ts`. **Close when:** Both AgentPortalPage and AgentFinancialPortal use agents.user_id/club identity correctly and canonical balances; no guessed historical balance migration.

- **CA-04-02 · P0 · Agent transfer retry identity** — Confirmed boundary gap. Move AgentService.transferToPlayer operation creation to the durable business intent and validate finite amount and strict receipt. Entry point: `src/services/AgentService.ts`. **Close when:** Lost response, reload and repeated submit reuse the same key; altered payload and malformed success cannot credit.

- **CA-04-03 · P0 · Global wallet writer inventory** — Needs audit. Trace every balance-writing RPC, trigger, service, admin script and indirect helper to an authorized journal transaction. Entry point: `live-rpc-register.csv`. **Close when:** No unregistered balance write or independently committed journal leg remains.

- **CA-04-04 · P0 · Accounting transaction primitive** — Needs audit. Verify debit, credit, journal, receipt and state transition commit together with conservation constraints. Entry point: `live-rpc-register.csv`. **Close when:** Injected failure at each statement leaves no partial state; valid retry returns the original result.

- **CA-04-05 · P0 · Precision and limits** — Needs audit. Review smallest units, numeric scale, rounding, bounds, NaN/infinity and JSON conversions per asset. Entry point: `callsite-register.csv`. **Close when:** No floating-point loss, negative authorization bypass, overflow or cross-asset balancing.

- **CA-04-06 · P0 · Cashier send and take-back** — Needs audit. Trace player, agent, club and union send/recall paths including roles and insufficient funds. Entry point: `page-and-tab-register.csv`. **Close when:** Authorized parties only; serialized competing spends cannot overdraw or take another tenant's funds.

- **CA-04-07 · P0 · Cashout approvals and reversals** — Needs audit. Review requests, approvals, denial, cancellation and external settlement evidence. Entry point: `page-and-tab-register.csv`. **Close when:** One legal state transition and one financial disposition; external uncertainty does not cause duplicate payment.

- **CA-04-08 · P0 · Wallet type and tenant boundary** — Needs audit. Review player, business, promo, treasury and legacy global pools for every caller. Entry point: `src/services/WalletService.ts`. **Close when:** All reads and writes agree on owner, club, asset and account purpose; retired paths are explicit.

- **CA-04-09 · P0 · Ticket sending and redemption** — Needs audit. Review issue, send, take-back, expiration, redemption and duplicate-use protection. Entry point: `live-rpc-register.csv`. **Close when:** Ownership transitions and liabilities are atomic and payload-bound; concurrent redemption succeeds once.

- **CA-04-10 · P0 · Chip mint and burn** — Needs audit. Review authorized issuance, source account, supply effects and audit actor. Entry point: `live-rpc-register.csv`. **Close when:** Every issuance or destruction has an explicit balanced journal and correct authorization.

- **CA-04-11 · P0 · Diamond economy** — Needs audit. Trace purchase, grant, spend, refund, gifting and chip conversion where supported. Entry point: `page-and-tab-register.csv`. **Close when:** Diamond and chip ledgers remain separately balanced; retries cannot repeat grants or conversion.

- **CA-04-12 · P1 · Cashier UI receipts** — Needs audit. Review pending, rejected and confirmed states and history deduplication on all cashier controls. Entry point: `ui-control-register.csv`. **Close when:** UI never announces success before an authoritative matching receipt; refresh reproduces the same outcome.

### Phase 5: Rake hierarchy, BBJ and promo

- **CA-05-01 · P0 · Rake calculation and caps** — Needs audit. Review all game-type rates, caps, eligibility, no-flop rules and smallest-unit rounding against approved configuration. Entry point: `server/src/engine/ServerTableEngineSettlement.ts`. **Close when:** Independent calculation vectors cover boundary pots and all supported table rules without changing approved economics.

- **CA-05-02 · P0 · Union-to-club attribution** — Needs audit. Trace collected rake, owning union/club and settlement period to actual treasury credits. Entry point: `live-rpc-register.csv`. **Close when:** Each hand belongs to one correct scope and period; no duplicate distribution or orphan liability.

- **CA-05-03 · P0 · Agent and player rake shares** — Needs audit. Trace club-to-agent hierarchy, subagents and player rakeback including hierarchy changes. Entry point: `live-rpc-register.csv`. **Close when:** Approved rates apply to immutable earning context; total distributions do not exceed their funded basis.

- **CA-05-04 · P0 · Weighted attribution versus payment** — Needs audit. Separate contribution statistics and rewards attribution from actual rake and cash credits. Entry point: `page-and-tab-register.csv`. **Close when:** Weighted statistics cannot mint funds or generate an additional financial credit.

- **CA-05-05 · P0 · BBJ main, backup and promo split** — Needs audit. Review every collection path with main fixed at 50%; recover approved backup/promo configuration and rounding policy. Entry point: `server/src/engine/ServerTableEngineSettlement.ts`. **Close when:** All three legs commit together and sum to collection; no assumed 25/25 split.

- **CA-05-06 · P0 · BBJ payout and replenishment** — Needs audit. Review eligibility, claim approval, main payout, backup transfer and post-win pool state. Entry point: `live-rpc-register.csv`. **Close when:** One funded award; replenishment is a traceable transfer and cannot duplicate on retry.

- **CA-05-07 · P0 · BBJ reporting identity** — Needs audit. Review pool/club/union/hand labels, bucket identity and time-window reports. Entry point: `live-relation-register.csv`. **Close when:** Reports reproduce all three correctly labeled legs, including the completed original incident correction.

- **CA-05-08 · P0 · Promo credits and redemption** — Needs audit. Review allocations, accrual, grant, expiry and spend/refund rules. Entry point: `existing-repair-debt-register.csv`. **Close when:** Promo liabilities and funding remain explicit; retries and expired eligibility cannot create free chips.

- **CA-05-09 · P0 · Period close and settlement** — Needs audit. Review union treasury close, overlapping periods, late events and repeated settlement. Entry point: `live-rpc-register.csv`. **Close when:** No event is omitted or paid twice; immutable period ownership and journal evidence survive retry.

- **CA-05-10 · P1 · Retire repair dependencies** — Needs audit. Work through all 32 existing allowlist entries after their source invariants are proven. Entry point: `existing-repair-debt-register.csv`. **Close when:** Allowlist only shrinks; retire obsolete repair jobs without replacing them with renamed watchers.

### Phase 6: Identity, authorization and tenant security

- **CA-06-01 · P0 · Security-definer RPC review** — Needs audit. Review bodies, fixed search paths, caller checks and grants for 426 observed definer overloads. Entry point: `live-rpc-register.csv`. **Close when:** Untrusted callers cannot impersonate owners, choose unauthorized tenants or invoke privileged helpers.

- **CA-06-02 · P0 · Anonymous callable RPCs** — Needs audit. Classify and adversarially test the 21 observed anon-executable overloads. Entry point: `live-rpc-register.csv`. **Close when:** Public exposure is intentional and minimum-privilege; catalog exposure alone is not labeled an exploit.

- **CA-06-03 · P0 · RLS policy correctness** — Needs audit. Review all policies and role combinations on the 179 observed relations plus indirect dependencies. Entry point: `live-relation-register.csv`. **Close when:** Cross-tenant read/write attempts fail; service-role paths independently enforce business authorization.

- **CA-06-04 · P0 · Session and account lifecycle** — Needs audit. Review sign-in, refresh, logout, revocation, role changes and account deletion. Entry point: `page-and-tab-register.csv`. **Close when:** Revoked sessions and stale role caches cannot retain sensitive access.

- **CA-06-05 · P0 · Endpoint and socket authorization** — Needs audit. Trace all 28 server router branches plus dynamic/API/socket entrypoints. Entry point: `server-dispatch-register.csv`. **Close when:** Every command authenticates scope, actor and current authority; no trusted client financial fields.

- **CA-06-06 · P0 · Secret and deployment configuration** — Needs audit. Review documented .env names and deployment paths without printing values; verify Hetzner-only Club Arena publication. Entry point: `file-register.csv`. **Close when:** Secrets remain server-only; no browser bundles, logs or reports disclose credentials.

- **CA-06-07 · P1 · Storage authorization** — Needs audit. Trace assets, club-assets and images candidates through bucket policies and signed URLs. Entry point: `callsite-register.csv`. **Close when:** Upload/read/delete authorization, file validation and object ownership are tested.

- **CA-06-08 · P1 · Abuse and request validation** — Needs audit. Review schema bounds, rate limits, CSRF/CORS and replay/duplicate handling where applicable. Entry point: `server-dispatch-register.csv`. **Close when:** Malformed or abusive requests fail without corrupting state or starving unrelated tables.

### Phase 7: Reconnect, interruption and durability

- **CA-07-01 · P0 · Incomplete cash-hand recovery** — Confirmed source gap. Replace snapshot completion-only recovery with an authoritative interrupted-hand state protocol. Entry point: `server/src/engine/ServerTableEngineBase.ts`. **Close when:** Restart restores or deterministically resolves the accepted hand without losing bets, changing cards or guessing refunds.

- **CA-07-02 · P0 · Snapshot completion before settlement** — Confirmed ordering gap. Move durable completion behind authoritative hand settlement and disposition evidence. Entry point: `server/src/engine/ServerTableEngineSettlement.ts`. **Close when:** Crash at every boundary cannot mark an unsettled hand complete or commit its financial effects twice.

- **CA-07-03 · P0 · Accepted action durability** — Needs audit. Trace action acceptance, persistence, sequence numbers and response ordering. Entry point: `server/src/engine/HandController.ts`. **Close when:** Acknowledged action survives process loss; replay neither omits nor duplicates an action.

- **CA-07-04 · P0 · Lease and stale owner fencing** — Needs audit. Review all hand and table writers against the shared lease and canonical commit protocol. Entry point: `live-rpc-register.csv`. **Close when:** Old engine owners cannot settle or mutate after ownership changes.

- **CA-07-05 · P1 · Realtime sequence and resubscription** — Needs audit. Review socket/subscription reconnect, duplicates, gaps and ordering. Entry point: `callsite-register.csv`. **Close when:** Clients converge on authoritative state after dropped, reordered and repeated events.

- **CA-07-06 · P1 · Mobile and PWA resume** — Needs audit. Review sleep, background, network switch, multiple tabs and cached releases. Entry point: `page-and-tab-register.csv`. **Close when:** Resume restores current hand and wallet state without resubmitting a financial intent.

- **CA-07-07 · P0 · Maintenance freeze and thaw** — Needs audit. Review scheduled lifecycle, in-flight transactions and normal engine version adoption. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** No guard bypass or forced restart; operations are either committed or safely rejected during the boundary.

- **CA-07-08 · P1 · External effect protocol** — Needs audit. Identify effects outside the database and use durable intent plus destination idempotency where available. Entry point: `callsite-register.csv`. **Close when:** Lost responses cannot produce duplicate external payouts; do not claim a database transaction controls external networks.

### Phase 8: Lobby, seating and multi-table operation

- **CA-08-01 · P1 · Lobby listings and filters** — Needs audit. Review club/union visibility, stakes, variants, search, pagination and stale occupancy. Entry point: `page-and-tab-register.csv`. **Close when:** Filters and counts match authorized live data across refresh and subscription loss.

- **CA-08-02 · P0 · Seat claims and reservations** — Needs audit. Review simultaneous seat joins, reservation expiry and seat generation. Entry point: `live-rpc-register.csv`. **Close when:** One occupant per seat and one authorized funded buy-in; expired claims cannot steal new seats.

- **CA-08-03 · P0 · Waitlists and auto-seat** — Needs audit. Review queue fairness, claim acceptance, timeout and funding handoff. Entry point: `ui-control-register.csv`. **Close when:** A claim is consumed once and cannot bypass club membership or wallet checks.

- **CA-08-04 · P0 · Buy-in, top-up and rebuy wiring** — Needs audit. Trace manual and automatic funding while seated and between hands. Entry point: `src/services/WalletService.ts`. **Close when:** One escrow transfer per accepted intent; no stack change occurs before the confirmed transaction.

- **CA-08-05 · P1 · Multi-table navigation** — Needs audit. Review table switching, simultaneous sessions, active-table identity and wallet refresh. Entry point: `page-and-tab-register.csv`. **Close when:** Actions and financial confirmations always target the intended table and seat.

- **CA-08-06 · P1 · Warm tables and lifecycle** — Needs audit. Review creation, idle shutdown, occupancy authority and restart attachment. Entry point: `server/src/engine/ServerTableEngineBase.ts`. **Close when:** Tables do not accept play without an authoritative engine; no ghost seats or duplicate owners.

- **CA-08-07 · P1 · Spectator and player views** — Needs audit. Review watch/join transitions and private/public payload boundaries. Entry point: `ui-control-register.csv`. **Close when:** Spectators see only public data and cannot issue player-only commands.

- **CA-08-08 · P1 · Join and leave feedback** — Needs audit. Review full tables, insufficient funds, membership rejection and interrupted requests. Entry point: `ui-control-register.csv`. **Close when:** Every control reports a clear durable outcome without trapping a reservation or presenting false success.

### Phase 9: History, reporting and configuration

- **CA-09-01 · P0 · Balance reconstruction** — Needs audit. Review event time, recording time, account identity and immutable corrections. Entry point: `live-relation-register.csv`. **Close when:** Balances at a cutoff are reproducible from valid ledger semantics; journal-only corrections are explicit.

- **CA-09-02 · P0 · Incident semantics** — Needs audit. Separate true imbalance, execution failure, missing evidence and delayed reads in incident classification. Entry point: `page-and-tab-register.csv`. **Close when:** Zero discrepancy is not silently treated as proof of health or corruption; resolution cites exact evidence.

- **CA-09-03 · P1 · Hand and tournament history** — Needs audit. Review completeness, pagination, participants, awards and visibility. Entry point: `page-and-tab-register.csv`. **Close when:** History matches authoritative outcomes and never leaks hidden information.

- **CA-09-04 · P1 · Player, agent and club statistics** — Needs audit. Review denominators, weighted attribution, currencies, timezone and period boundaries. Entry point: `page-and-tab-register.csv`. **Close when:** Reports match independently derived fixtures and distinguish statistics from cash credits.

- **CA-09-05 · P0 · Configuration authority** — Needs audit. Trace every editable rate, cap, timer, prize and rule from UI to server/database authority. Entry point: `ui-control-register.csv`. **Close when:** One approved effective configuration applies at the right boundary; clients cannot override it.

- **CA-09-06 · P1 · Exports and accounting statements** — Needs audit. Review filters, totals, precision, timezone and spreadsheet formula escaping. Entry point: `page-and-tab-register.csv`. **Close when:** Exports match the same scoped query and totals as the UI with safe cell content.

- **CA-09-07 · P1 · Cache invalidation** — Needs audit. Review all report and balance caches after transactions, role changes and reconnect. Entry point: `callsite-register.csv`. **Close when:** Read-after-confirmation displays the committed version and cannot combine incompatible snapshots.

- **CA-09-08 · P1 · Migration and live-body drift** — Needs audit. Compare applicable migration history, live signatures, function bodies and ACLs. Entry point: `sql-declaration-register.csv`. **Close when:** Historical declarations are not mistaken for active code; each live difference has provenance.

### Phase 10: Integrity, protection, support and operations

- **CA-10-01 · P0 · Club and union governance** — Needs audit. Review membership, invitations, ownership transfer, suspension and delegated roles. Entry point: `page-and-tab-register.csv`. **Close when:** Only current authorized actors can change scope or transact; role changes preserve historical attribution.

- **CA-10-02 · P1 · Player protection controls** — Needs audit. Inventory existing limits, exclusions, breaks and support controls; review agreed product policy. Entry point: `page-and-tab-register.csv`. **Close when:** Enforced server state survives alternate entry routes and reconnect; policy gaps are documented.

- **CA-10-03 · P1 · Dispute and support evidence** — Needs audit. Review hand/transaction lookup, case references and correction authorization. Entry point: `page-and-tab-register.csv`. **Close when:** Support can explain an outcome from immutable evidence without unaudited balance editing.

- **CA-10-04 · P1 · Integrity investigations** — Needs audit. Review existing reporting, suspicious activity evidence and privileged access. Entry point: `page-and-tab-register.csv`. **Close when:** Evidence access is scoped, logged and separated from unauthorized outcome manipulation.

- **CA-10-05 · P1 · Notifications and social features** — Needs audit. Review recipients, unread state, retries, moderation and deep links. Entry point: `callsite-register.csv`. **Close when:** No tenant or private-data leak; repeated delivery cannot repeat a financial action.

- **CA-10-06 · P1 · Admin and operational tools** — Needs audit. Review every script, manual RPC and privileged page that changes economic state. Entry point: `file-register.csv`. **Close when:** All write doors use the same authorization and atomic ledger invariants as normal product flows.

- **CA-10-07 · P1 · Settings and lifecycle** — Needs audit. Review club setup, archival, configuration changes and account relationships. Entry point: `page-and-tab-register.csv`. **Close when:** Lifecycle operations cannot orphan balances, tickets, tables or unsettled liabilities.

### Phase 11: Every page, control and visual state

- **CA-11-01 · P1 · All 125 page and tab files** — Needs audit. Use the page register as the mandatory per-file checklist, including nested tabs and development surfaces. Entry point: `page-and-tab-register.csv`. **Close when:** Every row has tested roles, routes, states, dependencies and evidence or an explicit exclusion.

- **CA-11-02 · P1 · All route declarations** — Needs audit. Resolve 168 discovered Route declarations, including 134 in App, and dynamic/redirect/layout behavior. Entry point: `route-register.csv`. **Close when:** Direct load, back/forward, refresh, invalid ID and unauthorized route tests cover each production destination.

- **CA-11-03 · P1 · All discovered controls** — Needs audit. Review 3,833 interactive JSX candidates and find interactions created dynamically or outside JSX. Entry point: `ui-control-register.csv`. **Close when:** Every production control has correct wiring, disabled/loading/error/success states and keyboard behavior.

- **CA-11-04 · P1 · Responsive layout** — Needs audit. Review desktop, narrow mobile, rotation, zoom, safe areas and overlapping navigation/modals. Entry point: `page-and-tab-register.csv`. **Close when:** Critical actions and amounts remain visible and usable without unintended horizontal clipping.

- **CA-11-05 · P1 · Accessibility** — Needs audit. Review keyboard order, focus return, labels, contrast, announcements and error prevention. Entry point: `ui-control-register.csv`. **Close when:** WCAG 2.2 AA-oriented checks include actual assistive-technology testing of critical financial flows.

- **CA-11-06 · P1 · Store, VIP and rewards** — Needs audit. Review product eligibility, purchase, entitlement, expiry, redemption and refund. Entry point: `page-and-tab-register.csv`. **Close when:** Displayed price matches the committed debit; entitlement and accounting share a durable operation.

- **CA-11-07 · P1 · Assets and content** — Needs audit. Review indexed images, icons, fonts, text, broken links and placeholder content. Entry point: `file-register.csv`. **Close when:** No broken assets, misleading controls or production-only placeholder states.

- **CA-11-08 · P1 · State completeness** — Needs audit. Review empty, loading, timeout, offline, denied, expired and partially populated page states. Entry point: `page-and-tab-register.csv`. **Close when:** Users can recover without repeating an uncertain transaction or losing context.

- **CA-11-09 · P1 · Realtime visual correctness** — Needs audit. Review hand animations, balances, badges, notifications and stale component closures. Entry point: `module-import-register.csv`. **Close when:** Visual transitions reflect authoritative sequence and never imply an uncommitted financial result.

- **CA-11-10 · P2 · Dead and duplicate surfaces** — Needs audit. Classify archives, previews, unreachable pages and duplicated service/UI implementations. Entry point: `file-register.csv`. **Close when:** Production surface is explicit; removal or consolidation follows verified usage and does not silently remove features.

### Phase 12: Performance, resilience and release gates

- **CA-12-01 · P0 · Financial concurrency suite** — Needs audit. Build shared property and failure-injection tests for every financial operation family. Entry point: `live-rpc-register.csv`. **Close when:** Conservation, isolation, authorization and payload-bound idempotency hold under competing and interrupted operations.

- **CA-12-02 · P1 · Database contention and queries** — Needs audit. Review transaction duration, lock order, indexes, plans and hot-account contention. Entry point: `live-relation-register.csv`. **Close when:** Measured peak-load tests meet agreed latency budgets without partial commits or unbounded deadlock retries.

- **CA-12-03 · P1 · Runtime and client load** — Needs audit. Measure tables, sockets, memory, rendering, network volume and bundle size. Entry point: `file-register.csv`. **Close when:** Agreed capacity and responsiveness budgets pass with representative simultaneous games and users.

- **CA-12-04 · P0 · Backup and restore proof** — Needs audit. Review database/WAL backups, restore procedures, secrets and ledger evidence continuity. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** An isolated restore meets agreed recovery objectives and verifies journals and outstanding liabilities.

- **CA-12-05 · P0 · Migration and rollback safety** — Needs audit. Review forward compatibility, grants, live definitions and old/new client coexistence. Entry point: `sql-declaration-register.csv`. **Close when:** Normal releases preserve invariants throughout deployment; rollback cannot revive retired unsafe writers.

- **CA-12-06 · P1 · Hetzner publication verification** — Needs audit. Verify documented push path, CI, static origin, public route and scheduled engine adoption separately. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** Published versions match approved commits and required tests; no manual production bypass.

- **CA-12-07 · P1 · Dependency and supply-chain review** — Needs audit. Review lockfiles, build actions, server packages and known advisories using current primary sources. Entry point: `file-register.csv`. **Close when:** Applicable vulnerabilities and unsupported components have validated fixes or explicit outstanding records.

- **CA-12-08 · P1 · Integration boundary coverage** — Needs audit. Trace dynamic RPCs, indirect helpers, cron, storage and external callbacks missing from the literal-source catalog. Entry point: `callsite-register.csv`. **Close when:** Every runtime write entrypoint has an owner, authorization check, invariant and test evidence.

- **CA-12-09 · P1 · CI regression gates** — Needs audit. Enforce critical negative/concurrency tests and prevent silent reintroduction of legacy writers or repair jobs. Entry point: `existing-repair-debt-register.csv`. **Close when:** A deliberately broken invariant fails CI; skipped browser/deployment suites are never reported as passed.

- **CA-12-10 · P1 · Final cross-phase acceptance** — Needs audit. Close each item only after source review, meaningful tests, merged code and relevant runtime evidence. Entry point: `docs/CLUB-ARENA-12-PHASE-AUDIT.md`. **Close when:** No blanket '100% safe forever' claim; every open or untested item remains visible with ownership.

## Provenance and closure

[coverage.json](coverage.json) records the baseline and discovery limitations. [register-integrity.json](register-integrity.json) records CSV row counts and SHA-256 digests. Source files can be recovered by their Git blob IDs from the pinned repository version. AST discovery is not type checking or a proof of a complete call graph. Page-to-route matching and suggested phase mappings are candidates requiring human/source verification.

This register is a reproducible baseline of discovered surfaces and known remaining work, not a promise that undiscovered defects cannot exist. Completion requires evidence per item and per relevant page/control, plus the correct deployed runtime. Expand the register when a dynamic or indirect path is discovered; do not conceal it behind a global completion percentage.

## Publication Addendum

The user approved publication on September 8, 2026. This inventory remains pinned to its recorded source baseline; it is not a claim that later changes were already audited. The original 216-requirement register has since been recovered in docs/audits/2026-09-08-platform-coverage/phase-requirements.json. The 118-item execution mapping is maintained separately in docs/audits/2026-09-08-execution-work-items.csv.
