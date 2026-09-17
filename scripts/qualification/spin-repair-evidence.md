> September 17 delivery-1 replay proposal: the retained packet below is historical source custody, not an execution receipt or active runner instruction. Current Documents/AGENTS.md controls execution. Qualification uses the existing GitHub-hosted PG17 accounting job; no retired local/native service is permitted. The finite driver `scripts/ci/test-alert-evidence-postgres.py` is proposed and unrun. Original financial evidence and every assertion remain retained.

> Composition delta: install and rollback both require final bridge `00a43ae03ab12cec9505e2bfed71d937` exactly. The fixture and embedded race use that same definition. Core installation/qualification establishes final bridge/raiser/escalator before consumer installation. Consumer rollback preserves final core; restore consumers before rolling core back. Target preimage/candidate, arithmetic, statuses, selectors, all assertions and historical originals are unchanged. These model fixtures do not prove the real bridge/raiser/mirror/inbox chain.

# Spin repair evidence wording — source-only qualification

Status: **UNRUN, unapplied, uncommitted by this helper.** This packet changes one function's successful-repair reporting and evidence fields. It does not qualify an original random draw, a payment, historical incident resolution, installation, scheduler behavior or delivery.

## Exact received basis

| Inbox / original financial UUID              | Tournament                           | Recorded buy-in / pool | Later draw-booking UUID              |
| -------------------------------------------- | ------------------------------------ | ---------------------- | ------------------------------------ |
| 40497 / 2e3e8281-d4a1-47ec-9211-701ca6fed537 | dea62e98-7cd9-404f-966f-b9fe3c7a94d8 | 1 / 3                  | 45317a75-0e4a-4b89-a7cc-4ae68f1141b4 |
| 40498 / cbd34ffe-664a-4849-b79e-696ec3988068 | a374cdd3-b10e-4725-bab5-ff6e90bb2af5 | 2 / 6                  | 433d0ea3-8560-4fbe-bbdd-39a76f873b48 |
| 40499 / e1956b38-cf92-412e-8a57-fb4db7883e3d | 78181713-fa93-4a52-93d8-e73bbf97851e | 3 / 9                  | e47783bd-0b68-4b25-a81e-2122e787712d |

The three games ended on Aug21. Their original warnings were recorded Aug22 18:24:04.240366Z. All six retained reserve contribution/draw rows were booked Aug23 04:04:59.880486Z by migration 20260823040459, which passed the existing reconstructed multiplier to settlement. They cannot independently prove the original RNG. The literal fixture retains all three original payloads, three tournament rows, six reserve rows, twelve wallet rows and three later Aug31 structure-payout rows. A prize wallet of 3/6/9 is separately retained for each; a later payout record does not establish another credit. Original RNG/engine deployment cause remains unknown.

The read-only evidence packet and fresh authority packet are pinned in the manifest. The exact original alert messages came from an earlier Aug22 function: the native before/after comparison deliberately uses the captured **current** 833c function. It reproduces the current misleading reserve wording with modeled missing projections; it is not a replay of the unknown original caller.

## Component boundary

Only public.fn_spin_repair_missing_multiplier(integer) is replaced. No migration auto-apply path, scheduler, table, financial row, balance, RPC, draw receipt, history, alert status, guard declaration or trigger is changed or invoked by either component.

Preserved: selector/window/earliest-positive-booking order, tier list, rounded ratio, chosen multiplier, premium threshold, compare-and-set predicate, ROW_COUNT and all return counters, arithmetic, source, severity, unresolved-tournament dedupe, critical message/context, and every legacy context field. The component adds no secondary ordering to tied booking timestamps; any ambiguity of that existing selector is unchanged. The SQL query adds only the selected booking UUID/time and tournament end time.

The success message uses the actual source: recorded reserve booking or recorded prize-pool/buy-in ratio. The existing paid_over_drawn value is **recorded pool minus buy-in times selected multiplier**, not verified payment. Its amount and key, plus paid_over_drawn_count and clawed_back=false, remain compatible. New explicit fields expose the same numeric difference, amount basis, selected booking UUID/time, whether that booking supplied the multiplier, and booking timing relative to recorded start/end. An invalid-tier positive booking can be observed but unused when ratio fallback is valid. Null UUID/time means no positive booking was selected, not proof that the ledger contains no other entries.

rng_evidence and payment_evidence are always not_established_by_this_repair: this function reads neither immutable RNG receipts nor wallets. Even a booking before the recorded start is not labelled authenticated RNG. A booking after an ended_at timestamp is labelled after_recorded_end; after start without later-end proof is after_recorded_start; missing game times stay game_time_unknown. These labels describe recorded timestamps, not newly authenticated timing.

The unchanged critical text still says “ran without a draw.” Rewriting that separate critical condition would affect message-derived identity and is outside this three-success-case patch; no original-draw absence claim is accepted here.

## Authority, install, replay and rollback

Full pg_get_functiondef preimage MD5: **833c06b59dfdd8fd29b74cce0c6be6a2**. Body-only hashes are not interchangeable. Both components carry the complete captured preimage and derived candidate, and require exact known full text. Target authority stays postgres-owned SECURITY DEFINER, non-strict, volatile, parallel unsafe, search_path=public and only postgres/service_role EXECUTE.

Each atomic DO checks target authority/one overload, all 23 consumed column types/nullability, three nondeferrable primary keys, the captured financial bridge/watchlist definitions and authority, and absence from guard-watchlist/declarations before and after replacement. Relation locks fence consumed schema changes; the component advisory lock serializes cooperating component calls. Neither replaces exclusive protected DDL admission for other function writers. The native owner must bind the complete actual postimage and authority readback; source-derived hashes are not a native receipt.

Install accepts exactly the captured preimage or exact already-installed candidate. A candidate replay is a guarded no-op. Rollback accepts exactly that candidate or exact already-restored preimage, restores the literal captured definition, and rechecks the same authority/dependency/schema contract. Unknown bodies, ACLs, columns, identities or dependencies fail atomically. This rollback is not a financial reversal. SQL errors must never be handled as successful application. Function/schema drift requires fresh owner review, not edited pins to force acceptance.

Composed public.fn_ca_financial_alert_to_incident() MD5 **00a43ae03ab12cec9505e2bfed71d937** returns immediately unless severity is critical. Thus changed info/warning success messages do not enter that captured bridge's message-derived incident key. The critical branch's message/context/source/severity/dedupe inputs remain identical. These facts do not qualify a changed downstream bridge, trigger wiring, future all-severity routing or provider delivery. The guard intentionally refuses dependency drift. Parent routing composition must be reviewed separately before release.

## Native qualification source

The primary SQL requires a protected empty disposable PostgreSQL 17 database named qual*spin* plus the admitted UUID without hyphens, postgres identity, local socket/loopback, no public relations/functions and preprovided anon/authenticated/service_role roles. It creates only a minimal consumed-column model in a transaction. The captured bridge/watchlist definitions are loaded for dependency/authority checks, but production financial triggers and wallet providers are absent. No production credentials may be mounted or reachable.

Cases are reviewable in the SQL:

1. Exact three received input sets are retained unchanged. A uniform time translation and multiplier=NULL model a missing projection within a seven-day window; this does not change literal evidence or claim those projections are currently missing. Actual preimage and candidate outputs, legacy contexts, severity and all nonprojection fields are compared.
2. All six exact late reserve rows retain IDs, amounts and original evidence; the time translation preserves order. Three selected draw-booking UUIDs/times must bind the three games, stay after recorded end, and never become original RNG proof.
3. Ten modeled cases compare preimage/candidate: valid pre-start booking; invalid booking with valid ratio fallback; invalid booking/ratio; no valid source; premium tier; already-stamped row; non-Spin exclusion; missing start with creation time; old row without booking; old row with valid booking. Counters remain five repairs/two unreconstructable/two positive nominal differences/one outside window. Critical dedupe and messages stay unchanged.
4. An explicit BEFORE UPDATE veto proves ROW_COUNT zero produces lost_the_race without a repair alert. It is explicitly **not** a concurrency test.
5. Guards refuse missing target, changed function settings/ACL, consumed timestamp type, missing PK, changed bridge ACL and newly watched target. Install replay, rollback drift refusal, rollback/replay, exact source and authority restoration are asserted.

The separate PostgreSQL isolationtester specification models an actual two-session CAS race. One session writes multiplier5 and holds its transaction; the repair reads the prior missing projection and must block on that row. The first session commits; the repair must preserve5, return lost_the_race1/repaired0, and emit no alert or reserve entry. The observed wait/commit/resume ordering is part of acceptance; the assertion result alone is not enough. Its final step restores the exact captured function. It uses a separate empty allocation, and embeds the same preimage/install/rollback bytes because isolation specifications do not use psql include commands. Changes to any embedded source require regeneration and fresh custody.

Neither runner has executed. The specification is not accompanied by a fabricated expected-output or pass log. A native owner must bind the actual PG17 server, psql/isolationtester binaries and complete provider closure, exact source/manifest hashes, actual public execution UUID and approved input mapping, entrypoint/protocol/expected error handling, and resource reservation. The primary script deliberately emits expected P0001 guard errors inside savepoints; all other errors are failures. The race must contain no SQL errors and exactly the required blocking sequence.

## Admission and completion still required

The adapter and protected execution route must be actually installed and admitted under Documents/AGENTS.md. No test/build/syntax-check/installation command is authorized by this document. Proposed execution limits for owner review are one light job at a time, separate disposable allocations, 60 seconds and 512 KiB captured output per case, no network beyond the isolated local PostgreSQL provider, and no production access; these are proposed caps, not an allocation receipt. A timeout/error fails qualification and requires independently observed cleanup, never a success inferred from source.

Required actual receipts: final source custody; complete provider pins; approved execution identity/plan; exact original-fixture digest; both native terminal results and durable logs; full before/candidate/rollback definitions, ACL/settings/schema readbacks; actual CAS blocking sequence; independently closed connections and stopped/empty allocation; and required-check intake. The primary transaction's ROLLBACK does not prove process/allocation cleanup. The race intentionally leaves only its disposable model for the owner to inspect and destroy; it never issues a broad DROP against a database whose admission may have failed.

Existing tests/config/spinNullMultiplierRepair.test.ts and spinStampCannotHideFromItsRepair.test.ts inspect earlier migrations; they do not substitute for running this guarded component's native fixtures. No CI/catalog registration has been invented. Parent custody, native qualification, protected installation, normal scheduler observation and routing/live identity proof remain distinct outstanding steps. Do not replay the repair against the three historical games, redraw, pay, claw back or close their original records to qualify this reporting correction.
