# Recorded hierarchy accounting stages

Prepared forward migration: `20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql`. This lane has not applied it, committed, pushed, replayed production accounting, or changed an agreement/rate. It depends on the lead owner's certified cash-source migration and the earning helper's certified player-period migration.

## Result

Round 2 builds routes from each immutable cash source's ordered earning-time tiers. The club funds the recorded highest agent. Each parent receives its own entitlement plus the children's budgets, passes only the children's budgets onward, and retains its own entitlement. A zero-own-entitlement parent still routes money. An ordinary agent with no recorded parent is a valid top recipient. Parent changes, current rates, current role/status and later union membership do not choose the historical route. Aggregated weekly cycles or inconsistent historical identities/roles are refused.

`agent_commission_settlements.amount` records **only own earned commission**, including a zero marker when a tier only passes funds. The Round 2 return's `amount` is direct club outflow; `downstream_amount` is additional movement of those same chips and must not be added to club outflow. Both `routing_version=3` and `source_version=2` are explicit.

Round 3 requires the latest version-2 player-period certificate, exact current period figures, every underlying immutable source allocation, exact recorded coordinator, and the original payer. It supports an agent payer or a direct club payer. Current `club_members.agent_id` never chooses the payer. Different game origins (private/union) can share one earning week when their recorded coordinator and payer agree. Conflicting coordinators/payers, missing certificates/sources, existing legacy payments, or insufficient funding abort the stage.

Every account is locked before transfers. Every positive transfer requires the existing central paid source-ledger invoice and delivery. Each journal leg records exact before/after balances on both accounts. The functions preserve caller journal skip settings and set `app.accounting_routing_context` to `union_id::text || ':' || period_start::text || ':' || period_end::text` during source-ledger receipt creation, then restore the prior context. The central invoice publisher can use that context to trust recorded payee roles, including a player who also holds an agent profile.

Both stages are private: direct `service_role`, browser and PUBLIC execution is revoked. The single SECURITY DEFINER coordinator remains the entry point. No application source call site directly invoked these stages in the audited `src`/`server/src` tree.

## Completion receipt contract

`accounting_routed_settlement_runs` has primary key `(union_id, period_start, period_end, round_no)`, routing version 3, an immutable source fingerprint, complete result and completion time. It is inserted only after every stage obligation, balance check and invoice succeeds. Exact replay returns the original result plus `duplicate=true`. Changed source/certificate fingerprints are refused. A zero-commission scope still creates a complete Round 2 run, without fabricated transfers.

The table explicitly revokes service-role default write grants, then grants SELECT only. Only the owner executing the private stage can create completion receipts. UPDATE/DELETE/TRUNCATE are also rejected by immutable-history triggers.

## Native verification

`bash scripts/dev/test-routed-accounting.sh` passed **36 PostgreSQL assertions**, including two competing full-waterfall transactions. It executes the complete migrated R2/R3 functions with controlled source/certificate/account/delivery dependencies. Coverage includes all hierarchy levels, ordinary top agent, zero-own parent, multiple clubs sharing the same agent/player, exact own vs gross accounting, source/certificate disagreement, unchanged history after current membership changes, legacy/partial refusal, cycle refusal, missing/unknown/short funding, full rollback when downstream invoice delivery fails, one receipt per transfer, scoped delivery context, immutable completion permissions including permissive service-role defaults, and exact replay.

The fixture exercises controlled central delivery, not live Messenger audiences or production volume. Those require integrated release verification. No native result is a claim that historical source contracts are known.

| Function | Reviewed production preimage MD5 | Native post-migration MD5 |
| --- | --- | --- |
| `fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)` | `1f79888c067c5e4892442d88a66affbf` | `c03c212bf251276d906b9bbf3568de47` |
| `fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)` | `422380ee15a8e452cf8044c0e91bbddd` | `8132e8213c5432466aac403750358438` |

## Lead-owner integration requirements

- Acquire `fn_lock_rakeback_payer_clubs` for the full sorted current-plus-recorded club scope **before Round 1 takes treasury rows**, preserving lock order with existing payout writers. Both new stages retain those advisory locks themselves.
- Admit clubs/obligations by recorded `coordinator_union_id`, including a club that later left a union and private-game earnings belonging to the same recorded coordinator. Actual game `union_id` remains separate; private rake must never be credited by union Round 1.
- Include zero-value routed-run receipts in close/cutover guards so late sources cannot enter a completed zero-commission scope.
- Preserve the trusted recorded `payee_role_at_transfer` only when `routing_version=3` and the live transaction routing context matches the ledger's union and period. Player rakeback is a player receipt even when the recipient also has an agent profile.
- The player-period writer and other independent payout doors must remain subject to the one coordinator and recorded-source rules. This lane changed only R2/R3.
- Add the native runner to the Accounting PostgreSQL17 CI job, then verify integrated migrations, source gates, summary conservation, engine release, runtime limits under representative volume and live delivery.

Historical periods predating the certified cash-source cutover remain explicitly refused. No clawback, invented rate, historical replay, or automatic payment correction is included.

## Shared union and standalone stages (follow-up)

Forward candidate `20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql` replaces the two union payment bodies with private wrappers. The only payment implementations are now:

- `fn_settle_accounting_commission_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)`
- `fn_settle_accounting_rakeback_stage(p_scope_kind text,p_scope_id uuid,p_period_start timestamptz,p_period_end timestamptz)`

`fn_resolve_accounting_routing_scope` accepts only an existing `union` or exact `club` identity. A union scope admits sources whose recorded coordinator matches that union. A standalone scope admits sources whose recorded coordinator is NULL **and whose club exactly matches the requested club**. Later joining/leaving a union does not change historical scope. Both use the same source, funding, route, invoice, rollback, and replay logic. No second financial writer or direct service/browser entry point was added.

The completion table retains `union_id`, adds `standalone_club_id`, and requires exactly one. Generated `scope_kind`/`scope_id` form the new primary key together with the period and round. Existing immutable union receipts gain their scope through generated columns; no financial receipt is rewritten. Union lock/idempotency keys remain unchanged. Standalone keys have an explicit club prefix. Ledger `union_id` is NULL for standalone; metadata includes `accounting_scope_kind` and `accounting_scope_id`. The standalone routing context is `club:<club UUID>:<period start>:<period end>` and is restored on return.

The canonical scope resolver takes the exact existing union/club accounting-week advisory lock before discovering current or recorded source clubs. The generic commission stage then takes payer-club locks before snapshotting sources. Producers share the accounting-week lock and must reject completed scopes before inserting sources; the lead owner retains this producer integration responsibility, including zero-entitlement runs. A native concurrent fixture proves a waiting resolver sees a newly committed historical club, while a past-week close lock leaves current-week source discovery independent. No additional per-club source-lock helper was added.

## Integrated native result

Final local runner passed **70 assertions** on PostgreSQL17. The runner uses three isolated databases: the shared stages with controlled delivery, the shared stages with the **actual central invoice/Messenger/notification functions and the current `20260914133404` role publisher**, and a forward-upgrade replay of already-paid immutable union receipts. It also exercises competing full union callers and competing standalone callers using real delivery.

The six-transfer fixture produces exactly six source invoices and ten private Messenger/notification delivery pairs. Club managers receive no individual waterfall notifications. Current agent role changes do not replace recorded payment roles. A player with an agent profile still receives a player invoice. Another club's routing context or mismatched scope metadata cannot assert a historical role. Replays add no documents. An exception inside actual notification insertion rolls back both rounds, all balances, earlier invoices/messages, private conversation rows, and completion receipts.

Standalone tests cover the same routing and direct-club player payment, exact club isolation among NULL-coordinator clubs, later union membership, explicit scope identity even when union and club UUIDs are equal, invalid scope rejection, restored context, complete rollback, and private execution grants. The forward-upgrade fixture proves existing immutable union receipts survive the schema upgrade and replay without new transfers.

| Final shared function | Native definition MD5 |
| --- | --- |
| `fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)` | `7d17e883dc9a26febe835655f80ccdbc` |
| `fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)` | `404e23af8a37939355a4f5176791dfad` |
| `fn_settle_round2_club_to_agents(uuid,timestamptz,timestamptz)` wrapper | `5d5071f48af1872b459777b7c4a5e74f` |
| `fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz)` wrapper | `ca110e4463f2d5339242d31c07fecd6c` |

Native evidence: `/Users/smarter.poker/Documents/Codex/2026-09-14/un/work/routed-accounting-shared-native.log`. This lane still made no production mutation, commit, push, or rate change. Native integrated delivery does not certify deployed Messenger behavior, production volumes, commercial agreements, or the entire accounting task.

## Independent economic and automation review

The cash source plan preserves the September 3 documented remaining-rake model: direct 50% of a 4-chip source earns 2, then parent 70% of the remaining 2 earns 1.40. `AgentService` instead describes `commissionRate` as the rate received from club/parent; installed `fn_create_agent` caps child rates by parent. The lead owner has asked the user to resolve inclusive-original-rake versus remaining-rake semantics. No formula was changed here.

Remaining-rake tiers conserve source rake but do not establish that the club's post-union share covers all obligations. For example, three 70% tiers consume 97.30% of source rake while a hypothetical 90% club share supplies 90%. Physical funding preflight prevents an unfunded transfer; whether the club may fund the difference from reserves is a commercial rule requiring authority. No speculative reserve-versus-entitlement refusal was added.

The recorded player-period formula applies its direct-agent margin cap only when the direct rate is positive. A zero-commission direct agent can therefore owe a positive fallback/deal rebate. The earning helper and lead owner were notified. The negotiated rate was not silently zeroed or changed. Current installed `fn_admin_update_agent` also lacks the parent/child commission and player-rate comparisons present in `fn_create_agent`; its parent comparison only covers credit. `fn_create_agent` selects its parent by ID without a same-club check within that function. Those agreement-governance findings were handed to the lead owner for integrated review.

To preserve correctness, the route stage refuses conflicting historical roles for one club/payee in a week and historical chains that aggregate into a weekly cycle. The certificate writer similarly refuses multiple historical payers or coordinators in a legacy single player/club/week period. Those are explicit automation limits; supporting such administrative changes requires a split-by-historical-route/obligation representation. The present refusal must not be described as unconditional automatic completion.

## Cash plus recognized tournament source integration

Candidate `20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql` adds the private read-only view `accounting_payable_earning_sources` and upgrades the existing generic payment functions. It depends on the complete tournament capture/recognition tables and guards; the tournament dependency is still a draft, so this file alone is not deployable.

View identity is `(source_type,source_id)`. Columns are `source_type`, `source_id`, `rake_record_id`, `tournament_id`, `player_id`, `club_id`, `union_id`, `coordinator_union_id`, `earned_at`, `rake_credit`, and `contract`. Cash source type is `cash_rake_accrual`; recognized tournament type is `tournament_fee_accrual`. Cash `earned_at` is unchanged. Tournament `earned_at` is terminal recognition time, while the original charge-time contract determines rates and hierarchy. The view requires recognized status, earned disposition, matching tournament identity, recognition timestamp, rake credit and actual union. Captured, refunded and deferred fees cannot become payable through the view. Coordinator quality checks must still detect excluded unrecognized/deferred obligations before reporting an empty scope complete.

Commission planning keys every source and tier by type plus UUID; two source families sharing a UUID cannot merge. New player certificates must explicitly type allocations. Only an already completed cash-only run may read its original untyped allocation again; pending cash certificates receive no fallback. Pure-cash completion fingerprints remain compatible for read-only replay.

A retired current agent profile no longer removes the entitlement documented by the immutable source. The exact recorded identity and role still have to be valid, and an existing club-member wallet with a valid funded balance is mandatory. Read-only production verification confirmed the rollup function never depends on `agents`, and its target table has only its `(club_id,user_id)` primary key. The native integration executes that real rollup function successfully with all current agent profiles removed.

The final combined runner passed **93 assertions**. Its original cash and standalone regression database now runs the newest mixed-source functions. Additional real-delivery tests cover cash/tournament UUID collision, mixed exact totals, recognition-week scope with an older charge agreement, excluded or inconsistent recognition, explicit allocation type, retired profiles, missing wallets, one routed edge per weekly obligation, atomic notification failure, standalone mixed routing, and original paid-cash document preservation. Recognition prerequisites in this fixture are controlled data; actual tournament producer/lifecycle correctness belongs to the earning helper's separate native fixtures.

Final native definitions: resolver `e681a25749f290403589a2ff28d1d405`; shared commission `7344f38c069f5d85332c09c33aa49c6a`; shared rakeback `7626aff917e8fba3cb6f54af51905dc0`. Log: `/Users/smarter.poker/Documents/Codex/2026-09-14/un/work/routed-accounting-mixed-native.log`. No production mutation, rate change, commit, push, or full-system certification was performed by this lane.

## Mixed weekly player certificate integration

Forward candidate `20260914141013_weekly_player_certificates_include_recognized_tournament_fees.sql` preserves the existing durable request wrapper and upgrades its one private calculator. Both cash and recognized tournament allocations carry exact source type and ID. Tournament recognition time selects the earning week; the immutable charge-time membership and agent agreement select the player rate and payer. The calculator rounds once per player/week, preserves recorded coordinator/payer identity, and refuses conflicting scopes or payers instead of inventing split payments.

The new private `fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)` checks actual fee-bank and terminal receipts. It detects missing/deferred recognition, uses the actual fee net-plan proof, verifies active/refunded source coverage and contract timing, and blocks private legacy events whose historical coordinator is unknown. Open captures do not create an earlier charge-week obligation. A complete recorded standalone scope does not block unrelated clubs.

`bash scripts/dev/test-mixed-rake-period-writer.sh` passed **69 PostgreSQL assertions**, including 44 retained cash/request tests and 25 mixed-source, quality, or concurrency checks. It loads the actual calculator, durable request wrapper, fee fingerprint/net-plan bodies, and source view. Controlled original source/terminal receipts remain fixture inputs. The tests cover cash/tournament UUID collision, original charge agreements, later recognition week, refund exclusion, deferred/missing terminal refusal, ambiguous private scope, incomplete receipt rollback, and competing requests producing one durable request and one certificate.

The known zero-direct-agent-rate cap behavior is preserved as explicit unresolved commercial evidence. No negotiated term was changed. Definition MD5s at this candidate: calculator `e683367f367422c00539a38f9600858e`; unchanged request wrapper `dbeadf42b4143e11c6e7b76343fecf0a`; private tournament quality checker `ecda7ce1a97da6c9048ee8b0d6fbd6b5`. Native log: `/Users/smarter.poker/Documents/Codex/2026-09-14/un/work/mixed-period-native.log`.

## Recorded union and standalone weekly statements

Forward candidate `20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql` replaces the current-union join with recorded scope discovery and retains one existing settlement-period invoice/delivery path. `fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)` is the private generic entry for union or standalone club. It requires the exact transaction setting `app.accounting_validated_scope = scope_kind || ':' || scope_id || ':' || period_start::text || ':' || period_end::text`. The old union function is a thin private wrapper; it also accepts the existing validated union setting and restores the previous scoped setting on success, with exception rollback restoring it on failure.

The coordinator creates and marks exactly one matching settled period before issuing. Missing or duplicate periods are rejected. Historical source clubs, recorded certificate clubs, observed union members during the week, and matching existing periods participate even after leaving a union. A club first joining after the week is excluded by the coordinator's canonical scope helper. The issuer takes the same scope/week lock before discovering expected clubs; concurrent retries cannot publish two documents.

An issued weekly statement returns its original immutable breakdown. New previews report union rake earned, actual union receipts, private rake earned and banked, total funding, direct payments by role, and downstream redistribution separately. Retained rake is actual union receipts plus proved private bank funding minus direct club outflow. It is not a current treasury balance or profit assertion. Private funding requires each typed source group to match its actual cash/tournament bank receipt and posted journal into the same club. A second coordinator's same-week payout journals are excluded. Missing or malformed period tags, source/bank disagreement, unclassified roles, absent paid invoice/delivery receipts, missing routed-stage completion, and deferred tournament evidence prevent publication.

The authorized read-only summary calls the existing private tournament quality checker. This forward candidate removes only that checker's redundant engine-caller guard, retaining every proof predicate and revoking all external EXECUTE grants. Summary authorization precedes the call; calculator/coordinator authority checks stay unchanged. The generic statement issuer and union wrapper are likewise private, including explicit service-role revocation. The central delivery function only gains the new private-funding and downstream subtotal fields in its existing message amount-line list.

`bash scripts/dev/test-scope-weekly-accounting.sh` passed **65 PostgreSQL assertions**. It loads actual statement/delivery functions, invoice triggers, Messenger conversations/messages/notification writes, source view, fee net-plan and quality checker, plus the coordinator owner's historical scope and settled-period creator draft. Paid stage headers and original bank/source receipts are controlled fixture inputs; actual R2/R3 transfers are independently covered by the 93-check routed suite. Tests include departed/zero-source clubs, a club joining after the period, standalone scope after joining a union, private cash plus recognized tournament funding, separate downstream totals, owner/union access, exact GUC scope, malformed period data, wrong bank destination, deferred recognition, missing stage/period proof, notification rollback, immutable issued figures, duplicate period refusal, and two competing issuers resulting in one weekly document, one delivery, and no new chip transfer.

| Final statement function | Native definition MD5 |
| --- | --- |
| `fn_club_weekly_accounting_summary(uuid)` | `08e8809611b60e14aa090ecc46ac40e9` |
| `fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)` | `e73d9e7d8807ac4244d8131e4b2bc407` |
| `fn_issue_club_weekly_accounting(uuid,timestamptz,timestamptz)` | `5bbb7a8239c3edc916b6d2f936f26325` |
| `fn_deliver_accounting_invoice(uuid)` | `0291df67e104292f018647d10d4d862e` |
| `fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)` | `499582f36664ab6ffc2116b22740ae69` |

Reviewed live preimage hashes were fetched read-only before drafting: summary `fd8af5960df5b5da23b4e9a6497ae63b`, union issuer `3d37ae48c223ec49afc1ad468237e0b5`, and delivery `8aeee5f47863f0496c9cdf86490eb084`. Native log: `/Users/smarter.poker/Documents/Codex/2026-09-14/un/work/scope-weekly-native.log`. Dependency order includes the complete tournament source bundle, mixed source140015, certificate141013, version-3 R1 source close14141800, and the root coordinator's historical scope/settled-period creator. This lane did not apply production DDL, perform accounting payments, commit, push, or certify live automation.

## Unified weekly coordinator integration

The parent-owned `20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql` was tested by this lane through `scripts/dev/test-unified-weekly-accounting.sh`, with **38 PostgreSQL assertions passing**. The harness loads the actual J schema/function upgrade, private preparation receipt verifier, R2/R3 routed stages, weekly summary issuer, invoice triggers, Messenger and notification functions, and parent-owned K143500 conservation assertion. It also proves the run-table scope upgrade preserves an original union result and attempts.

Explicit fixture boundaries are a controlled durable certificate-recompute response, an existing already-paid Round 1 close, disabled ECO, and a controlled union square-up producer. Preparation verifies the real durable request against the controlled response, including a deliberately forged request ID. Cash/tournament certificate calculations, original Round 1 bank/source posting, and unresolved PNL/ECO economics have separate proof/ownership; this fixture does not claim those full production paths are certified. After printing the exact J function hashes, the harness replaces only `clock_timestamp()` in the private coordinator body with its deterministic clock dependency to exercise four-AM and maintenance decisions.

The tests exposed and verified parent fixes for completion shortcuts accepting absent actual routed receipts, a different union's period statement, and a standalone processing period. The upgraded coordinator requires matching stored stage receipts, exact scope/period/statement identity and settled/closed period status. Processing can finish; closed stays closed. Missing paid-stage evidence fails without repayment. Exact-club calls do not widen into other clubs, and callers cannot supply union and club IDs simultaneously.

The tests also reproduced repeated identical reconciliation alerts caused by period/ledger UUIDs generated inside a rolled-back attempt. Parent J now compares a stable failure identity while retaining the full attempt result. Two retries of the same private-bank discrepancy alert once; a changed funding failure emits a new alert. Durable failed runs and preparation requests survive final notification failures, while all actual routed balances, stage receipts, new invoices, messages, notifications and period objects roll back. A later valid retry finishes once.

Two competing full coordinator transactions prove the global scheduler exclusion: the second caller reports an active run without starting another payer; after commit, retry observes one complete run, two actual routed stage receipts, the expected 153.40 treasury, seven invoices and eleven real Messenger/notification pairs. No additional chip transfer occurs on replay.

Native J definitions: `fn_process_weekly_accounting_scope` = `63f8248cd6d804f450a0b8f0fbc05e77`; compatibility wrapper = `5aec6700bf043463e9db2933ca63bca1`; union cascade = `42d975cb30c4185dbf58b57f840296a7`; failure identity = `0bd593693aeb24b71354052987bec8df`; scope clubs = `d7873c8b3dd2a0ef8df48be321dd9a2f`; settled-period marker = `8471e94814d37d3fb9359b711682e0b1`. Log: `/Users/smarter.poker/Documents/Codex/2026-09-14/un/work/unified-weekly-native.log`. This is native integration evidence, not installation, release, live payment, or complete economic certification. The parent retained all J/K source ownership; this lane changed only the native runner/fixtures and this audit record.
