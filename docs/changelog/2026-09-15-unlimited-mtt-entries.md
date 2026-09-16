# R46: unlimited MTT entries and scheduled satellite creation

Status: source changes under review on `fix/mtt-unlimited-entries-sep15`, based on `9fa0cbad3d71d24ded5f6107aaa72438c7d4253e`. No R46 application tests, TypeScript, build, rendering, SQL execution, installation or publication have run. The protected local pipeline is not qualified for this source. Previous R43–R45 results apply to their previous bytes only.

## Product contract

The owner requires no maximum entry count for any MTT, including satellites. This is Club Arena policy, not a claim that all other platforms share it. New MTT rows persist `max_players=NULL`; legacy numeric limits are ignored. Physical table seats, minimum entrants to start, registration deadlines, individual rebuy/re-entry limits and the number of prizes or tickets remain separate rules.

`server/src/tournament/tournamentEntryCapacity.ts` owns format classification for the engine and imported client projections. The SQL predicate mirrors its explicit type, variant and target rules. Both target column spellings are recognized. An explicit MTT or genuine satellite target precedes stale fixed-format labels; a fixed SNG/Spin with only `is_xmtt=true` remains fixed. Missing fixed-game capacity refuses admission.

New/default MTT minimum is three entrants, matching the existing Manager launch requirement. An uncapped field does not create tables before registration, bypass the full MTT blind validator, disable synchronized breaks or become a two-player game. Historical two-player launch evidence and funded financial contracts are preserved.

## Root causes and source repairs

| Cause | Source repair |
| --- | --- |
| Forms, scheduled creators and recurring creators imposed inconsistent field limits. | Remove the MTT controls and sentinels; normalize every changed creator and schedule payload to NULL. Keep physical table size explicit. |
| Database NOT NULL, creation trigger and several nested registration authorities independently enforced caps. | One additive, transaction-scoped migration relaxes MTT storage, installs normalization and a positive fixed-field check, and changes 39 captured function bodies using 62 exact text replacements. Each old body is pinned; any drift refuses the transaction. |
| Old `max_players=2` satellite rows were treated as fixed heads-up games. | Type/target-aware discovery, launch, seating, break, fee, table-close and unregister decisions. New satellite creation follows the scheduled MTT path. |
| The inner wallet registration authority still compared roster count to the old cap. | Remove that comparison only for known MTTs; keep actual roster checks, debit, maintenance, role and replay boundaries. |
| Ticket admission, delivery and settlement could call an eligible MTT target “full.” | The same unlimited classification reaches the nested authorities; fixed-game capacity and accepted historical plans remain protected. |
| Lobby/home/search projections omitted format/target identity or compared lowercase status strings to canonical uppercase data. | Carry both target representations through actual queries and normalize public MTT capacity to NULL. Repair the club tournament status projection. |
| Pure re-entry schedules set the flag but omitted the price/stack read by the purchase authority. | Persist the configured re-entry price and chips, defaulting to the original total entry price and starting stack. Do not re-charge the net prize contribution as a gross entry. |
| A future feeder could resolve a target that started before the feeder. | Resolve targets after both the current time and feeder start time. |
| Restart copying omitted the legacy target column, converting some satellites to fixed SNGs without their prize target. | Preserve both spellings, canonicalize the new satellite identity, validate its exact target after the computed clone start and protect that link at insertion. |
| Name/time pre-reads did not prevent concurrent workers creating duplicate restarts. | Persist `restart_source_id` on the child and enforce one child per source across all statuses. Lock and validate the source, make the pointer immutable, retain the history and keep old writers outside the release acceptance until retired. |
| Recurring satellite creation used a read followed by an insert. | A service-only owner/target ensure RPC serializes new creation, locks the target and recognizes existing active feeders through either target column. |
| Old feeder names suppressed new same-named targets, and existing feeders consumed creation budget. | Check target identity directly; at most three attempts per owner, with only new or uncertain creation outcomes spending creation budget. |
| A service caller could create a chip-funded feeder into an unsupported Diamond or contradictory bounty target. | One private structural predicate and an all-writer table guard bind new target admission; the recurring RPC and restart guard share it. Align the engine's label checks. Historical settlement is not reinterpreted. |
| A target with live incoming feeders could change to a bounty label while its flags stayed false. | Inspect the proposed target row during updates and refuse unsupported labels or currency while an active feeder references either target column. Preserve unchanged historical rows. |
| A transaction with a repeatable snapshot could miss a newly committed feeder despite taking a target row lock. | Require READ COMMITTED for linked feeder inserts and substantive watched contract edits; refuse unsupported modes before consulting incoming rows. No-op and status-only updates remain available. |
| Old clients could still request a capacity waitlist for an uncapped MTT. | Reject new MTT waitlist admission in the database and client. Preserve leaving existing queues. |

The recurring satellite factory now uses 10,000 chips, the engine's 24-level TURBO ladder (50 opening big blind, 200 BB, four minutes tapering to two), a minimum of three, synchronized breaks, one guaranteed seat and a target at least three hours away. Minimum entrant contributions cover the target's entry price. The lead time is scheduling headroom, not a guarantee of completion before the target closes. Multiple ticket awards still depend on the actual funded prize pool and settlement contract.

The new RPC reports `created` or `existing_active`. It does not promise exact request replay after a feeder has finished. The caller verifies outcome, event UUID, target and owner identity; an error or malformed response causes no direct-insert fallback. Creation itself invents no entrants, tables, wallet movements or tickets.

The common structural rule also rejects a feeder's incompatible bounty/Spin payout configuration. It preserves plain SNG and nested satellite target support in the existing financial authorities; only the automatic recurring picker uses the narrower non-feeder MTT target policy. Real funding, delivery and concurrency still require the qualification catalog.

The isolation restriction is explicit compatibility behavior: Repeatable Read and Serializable callers cannot perform the relevant admission/contract edits until a broader protocol is designed and qualified. PostgreSQL distinguishes locking a row from actually updating it for Repeatable Read conflicts; a row lock alone does not refresh the transaction snapshot. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ). This is the basis for the source-level race analysis, not execution evidence. Confirm all actual writers use the admitted mode and run both transaction orders under READ COMMITTED before adoption.

Restart identity belongs to the immediate completed source, so A→B→C uses one child for A and one for B. A cancelled/completed child still consumes its source identity; its pointer cannot be reassigned or cleared, and deleting it cannot reopen the slot. No historical rows are backfilled or identified by guesswork. Writers that omit the new pointer remain outside this guarantee and must be retired before adoption is certified.

## Required verification

The detailed catalog supplement is [R46 qualification requirements](../audits/2026-09-15-mtt-unlimited-qualification.md). Regression sources include actual creation/payload/board paths, format classification, existing lifecycle paths and three new native entry/ticket/creation probes. They have not executed.

The owner's broader hardening direction is documented in the [change hardening standard](../operations/change-hardening-standard.md) and shared with the pipeline owner for required-catalog integration. The document is not proof that cross-area enforcement is installed.

Source text reconciliation matched all 39 captured old bodies and 62 replacement sites. This checks captured text only; it is not PostgreSQL parsing, live schema freshness, migration execution or behavioral evidence. The captured function definitions, projected text and manifest are held in the task's `work/r46-sql` custody folder.

Required proof still includes the complete current nested database authority, actual trigger order, both application typechecks, full affected catalog/build, phone rendering, concurrent registration and feeder creation, funded tournament and ticket journeys, independent review of the final revision and source-bound protected receipts. The SQL fixture probes use synthetic seed inputs and do not establish historical accounting reconciliation.

## Coordinated installation and recovery

Old engine processes misclassify NULL entry capacity. Old schemas reject new NULL creator payloads. The release plan must qualify the compatibility transition as a whole: all relevant engine/readers adopted before NULL rows become available, creation held during the incompatible interval, current SQL definitions and trigger graph installed atomically, and exact process/web/schema identities read back. Do not assume rolling old/new writers are compatible.

The migration uses bounded lock and statement timeouts and refuses old-source or constraint drift. A failed transaction rolls back. After a successful installation has created NULL rows, reverting to old engine code or NOT NULL storage is not a safe blind rollback; use a reviewed coordinated recovery or roll forward. Never manufacture numeric MTT limits to make an old binary work.

Publication remains on the owner's explicit hold. No source patch or historical test result establishes current live health. The overall MTT audit remains open for launch/playability, financial reconciliation, advanced formats and full lifecycle acceptance in the main blueprint.
