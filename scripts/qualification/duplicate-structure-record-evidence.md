> September 17 delivery-1 replay proposal: the retained packet below is historical source custody, not an execution receipt or active runner instruction. Current Documents/AGENTS.md controls execution. Qualification uses the existing GitHub-hosted PG17 accounting job; no retired local/native service is permitted. The finite driver `scripts/ci/test-alert-evidence-postgres.py` is proposed and unrun. Original financial evidence and every assertion remain retained.

# Duplicate structure records: source qualification handoff

Status: **SOURCE ONLY / UNRUN**. No test, syntax check, build, formatter, database mutation, publication or financial/status repair has been performed. The standalone component is outside `supabase/migrations`; it cannot be selected by normal migration discovery. Parent owns review, source custody and later execution admission.

## Received finding and exact scope

Inbox **40430**, original financial alert **77bdb12a-c757-4aad-8b35-1baf02754ba7**, created **2026-09-01 13:37:00.606737Z**, reports 30 tournament/player pairs across 24 tournaments and 688.30 nominal excess. Its payload MD5 is `320b709330c182c0ef334d79528ea119`. All 60 original payout UUIDs and amounts are retained in the qualification input. The original detector selects `source='structure'`, `amount>0`, `created_at > now()-hours`, groups by tournament/user, and subtracts each group's largest record. It neither groups by place nor proves a wallet credit.

Seven pairs in tournament **4f42d847-f583-458f-8659-26392f24f482** have corrective place keys deliberately reserved without a second credit. Their nominal 300.00 is part of the 688.30; matching reservation keys must not be called payments. The other 23 pairs have two retained legacy credit records, nominal 388.30; that does not qualify an outstanding loss without complete ledger/correction evidence. The additional later `ledger_backfill` record and any reversal are outside the 60 original rows. This source change performs no clawback, payment, history rewrite or closure.

## Installed preimage and ownership

Read-only capture on September 15 around 01:49–01:55 UTC:

- `public.fn_ca_duplicate_structure_payout_check(integer)`: full `pg_get_functiondef` MD5 **c2ceec953ff4cb6b31741fe20b75b635**, `prosrc` MD5 **69cac3aac05f25b5d2078825aa22ec89**. These are distinct hash bases.
- Owner postgres, SECURITY DEFINER, `search_path=public`, `statement_timeout=120s`, ACL `{postgres=X/postgres,service_role=X/postgres}`.
- Cron **210**, `ca-duplicate-structure-payout-hourly`, active, `37 * * * *`, calls `(24)`. The component does not edit or invoke this job.
- Consumed column types/nullability and exact singleton primary keys on payout `id` and reservation `key` are pinned in the component. Payout amounts are numeric(15,2); reservation recipient and unconstrained numeric amount are nullable. The primary key makes the full-key LEFT JOIN at most one row per payout.
- Existing payout indexes include tournament ID, tournament/position, and partial unique non-null idempotency key. The component adds no index or table.
- No function-body reference or view call to this detector was found. Catalog dependencies list only schema/language, as expected for text PL/pgSQL; that catalog alone is not a complete caller inventory.
- `fn_ca_guard_watchlist()` does not list this detector and `ca_guard_defs` has no detector row. Ordinary DDL guards, schema reload and audit effects remain in place. No override or guard bypass is included.

Local search covered the owned tree, accounting owner tree, two audit-detector trees and fee-disbursement tree, plus all locally reachable migration commits touching this exact name. No equivalent report/provenance candidate was found. The other helper confirms its packet is evidence only. This is a bounded local ownership check, not a claim about unreachable tasks or uncommitted files everywhere.

There is a **different pending retirement** in the dirty fee-disbursement tree: `supabase/migrations/20260908002605_a_prize_obligation_cannot_overpay_and_needs_no_watcher.sql`, lines 2845–2880, unschedules/drops this detector; later clauses close historical matching alerts/incidents. That owner/file is untouched. Parent must coordinate selection: do not install this component after retirement, and do not treat it as authorization for that retirement's financial/history changes. The guard accepts only the captured preimage or an exact full candidate definition with matching authority/schema. Exact candidate replay returns without changing it; other replacements or an absent detector fail. This never silently resurrects or overwrites a newer definition.

## Exact report contract

The original positive anomaly population, source, critical severity, hours/default/floor behavior, unresolved-source dedupe and aggregate arithmetic remain unchanged. No place or key classification filters an anomaly out. Existing return keys and all legacy `sample` entries remain; nominal values are unchanged. Equal-value groups now have deterministic UUID tie ordering.

New `report_version=2`, `measurement`, `window_column`, exclusive window start, `nominal_record_discrepancy`, `payment_evidence` and `legacy_key_semantics` state what is measured. `sample.paid`, `excess`, and `players_double_paid` are compatibility names for record arithmetic/group counts; they no longer carry an unqualified payment claim. The message names multiple inserted records and nominal discrepancy. No new `amount` or `discrepancy` context key is added.

Per-group observations include repeated positive-place subgroup count and record count, distinct positive places, cross-positive-place flag, and count of null/nonpositive place records. Global classification group counts overlap deliberately: a mixed group may have all three conditions. They sum neither to unique groups nor to payments.

The full legacy sample remains **unbounded**, preserving its contract. Only the added evidence is bounded: top **30** groups by nominal discrepancy/UUID, at most **4** records per group by created_at/UUID, at most **120** records total. All counts/sums/classifications use the complete selected population. Global and per-group evidence omission counts explicitly expose truncation. Detail reads occur after group/row limits, using the same statement snapshot and exact original predicate. This does not bound all scan work or total legacy response size; native query-plan/resource qualification is still required.

Each detail contains exact payout/tournament/user UUIDs, place, amount, source, insertion time and recorded paid_at. It compares the **full** idempotency key, then displays at most **512 characters** with full-key MD5, original character length and truncation marker. MD5 is an evidence locator, not authentication. Non-ASCII UTF-8 keys can use up to four bytes per character. Raw unconstrained registry amount/other freeform metadata are not echoed.

`key_registered` means a key exists. `key_user_matches` and `key_amount_matches` are nullable comparisons. Only `(user_matches AND amount_matches) IS TRUE` yields `registered_key_match`; nulls and mismatches remain explicit unknown/mismatch. All key outcomes have `reservation_only_not_proof_of_wallet_credit` semantics. No wallet transaction is joined by amount, and no reversal is netted.

## Consumers and installation effects

The local `FinancialAlertService.getUnresolved` maps full context without parsing these detector keys. The old migration's only exact numeric consumer is its historical probe, which is not replayed. A later historical migration's source-name list only resolves old rows; that is also not replayed. The detector registry classifies this unchanged source as tournament-related.

Installed `fn_ca_financial_alert_to_incident()` (definition MD5 **3771aeef9008e35c6af3d03f220ebb3b**) forwards full context and derives settlement category from the source. It normalizes the first 200 message characters for the downstream incident key. **The corrected message changes that future incident shape.** Existing detector source-level dedupe still prevents a new financial alert while any unresolved detector alert exists. No prior incident is updated, merged, reopened or closed. The bridge's `amount`/`discrepancy` parsing receives neither key from this change. The parent also has a separately queued leave-pending-only bridge patch; validate the final selected bridge during integration, without overwriting it here.

The alternate `fn_tournament_double_paid_obligations(integer)` is not a replacement: it selects different sources/window and groups by position/amount with distinct sources, while its key-existence check also overstates a reservation as payment. It is outside this accepted 40430 reporting patch.

The component uses one atomic DO statement, checks the captured function and consumed schema before replacing it, and checks exact postimage text and preserved authority afterwards. The protected publisher must serialize definition/schema changes for the full precheck/replace/readback interval; the precheck is not a cross-session lock protocol. No automatic rollback overwrites later work.

The separate `supabase/components/duplicate-structure-record-evidence.rollback.sql` requires the exact candidate definition hash, owner/ACL/config, all 18 consumed column pins and both singleton PKs. It restores the literal captured preimage and reads back its full text and authority; an exact preimage replay is a no-op. It is a separately authorized operation, not an automatic migration or retry. Expected canonical candidate definition MD5 **67d372ba4b1071cae4ac0d9f97035b31** is derived from the installed canonical header plus the new body; it is **not** a PostgreSQL execution receipt. The fixture asserts and emits the actual native full definition/hash, then tests rollback and reapplication. The native owner must confirm that exact postimage before admitting either artifact. Neither install nor rollback may call the detector as a probe on production.

## Native qualification source and limits

`duplicate-structure-record-evidence.sql` creates an explicitly declared minimal model in an empty disposable PostgreSQL 17 database. It runs the literal captured preimage and this exact component. The model preserves all consumed column types, nullability and PK uniqueness but does not load the full financial schema, wallet writers, RLS/event/incident triggers or cron. It is not an end-to-end financial or notification test.

The original fixture keeps 60 literal original IDs/amounts/positions/keys/created_at/paid_at values and 60 registry rows. The modeled payout insertion times receive one uniform offset of `transaction_timestamp() - original_alert_timestamp`. Original input timestamps and paid_at stay unchanged. This tests the real candidate's 24-hour predicate with fixed original relative timing; it does not claim a historical database replay or clock-controlled production execution.

Required source cases are actual old-message reproduction and 688.30 compatibility; every original pair/value; all 30 cross-place groups; seven burned keys with one retained credit witness each; mixed/same/null/invalid place groups; non-structure/zero/singleton exclusions; exact-key recipient/amount mismatches and NULLs; 600-character key truncation after lookup; 31 groups/155 rows with exactly 120 details and 35 omissions; stable tie order; exclusive hour boundary, NULL/zero/negative hour floor and existing future-time behavior; actual anon/authenticated denials and service-role call; preimage/ACL/type/PK/missing-detector guard refusals; unchanged dedupe, resolved predecessor/new alert and clean-window non-closure; source table equality; exact candidate replay; guarded rollback refusal on definition/PK drift, exact restoration, rollback replay and reapplication; full fixture transaction rollback. Assertions treat NULL as failure. Expected negative SQLSTATEs are captured before savepoint rollback.

No concurrency guarantee is added: existing source-level NOT EXISTS dedupe is not serialized, so simultaneous manual callers may still race. That behavior is preserved, not claimed fixed. Native integration must separately show an active scheduled invocation can finish using either whole function definition during normal cutover, and that supported migration serialization excludes concurrent publishers. It must not introduce manual production alert probes.

## Remaining protected acceptance

Owner must supply an actual approved execution UUID; pinned PostgreSQL 17 image/binary, psql and immutable source/input manifest; empty isolated DB `qual_duplicate_<UUID-without-hyphens>` on loopback/Unix; the three roles without production credentials; network denial; bounded CPU/memory/time/output allocation and independently observed container cleanup. No dependency install or copy is authorized by this handoff. Set a bounded whole-execution deadline outside the preserved 120-second function setting.

The minimal fixture, integrated schema/DDL guard/financial bridge qualification, read-only query-plan and resource evidence, exact pre/post function hash and ACL checks, cron preservation, and all required protected receipts must precede installation. After separately authorized installation, observe a **genuine** scheduled receipt/report or natural alert plus inbox delivery. A clean later window does not repair 40430's historical lineage. Final source custody/commit, native runs, declaration/admission, installed source, scheduler, delivery, cleanup and financial disposition remain distinct pending facts.
