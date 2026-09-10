# Prospective Cash Commission Source Authority

This is a locally verified proposal, not an applied migration. The production
commission primitive still has its original body. The existing three-stage
proposal remains a prerequisite, and this source cutover requires the payer
proposal before release. No historical accrual, backpay, wallet write, production
DDL, push, or deployment was performed by this lane.

## What Changed

The prior draft read seats, assignment and hierarchy separately for each
contributor. A concurrent change could combine the first player's old terms
with the second player's new terms. It also converted an explicitly assigned
but missing or inactive agent into an apparently genuine no-agent result.

The capture helper now reads the whole hand's seat generations, booking clubs,
membership assignments, full hierarchy and player terms in one SQL statement.
Subsequent inserts use only that statement's snapshot. Exact accepted seat
identity is mandatory; a missing generation never borrows a current occupant.
The source is captured only by the pinned accepted-hand owner's first envelope
write, after its legacy replay refusal. The helper has no API-role execution.

Source rake credit comes from the captured current PostgreSQL allocator, whose
body is pinned in the owner cutover. Admission also requires a matching banked
rake record, including club, table, amount, method, contributions and returned
uncalled amounts. Caller-supplied identities and amounts cannot manufacture a
prospective source. Old banked sources with no immutable source facts receive
no new accrual or adopted receipt.

Configured player rates retain the installed positive negotiated-deal, then
positive agent-default precedence. Missing assigned terms do not fall back to
an invented volume ladder. Rates are preserved, with invalid terms or deficient
margins recorded for review, rather than silently clipped. Genuine unassigned
players have a separate `legacy_volume_unbound` player-policy state; they may
have a zero commission allocation but are never declared paid a zero rebate.
Their rebate policy remains unresolved.

Player rebate entitlement is stored as exact, unrounded
`rake_credit * player_rebate_rate`. The payer must aggregate fractional
entitlements by period and captured payer/terms and retain the unspent fraction
across incremental payments. Rounding each hand would erase small entitlements.
Staff or self-agent rebate exclusions have a separate explicit policy marker.

Sources, facts and final commission receipts reject mutation and truncation.
The new contributor column has its own immutable guard because the actual
existing journal trigger does not inspect newly added columns. The prospective
commission writer is a service-only SECURITY DEFINER function; receipt and
source tables grant service SELECT only. The earlier additive stage explicitly
revokes DELETE and TRUNCATE even under broad default privileges.

## Source Interface

`ca_cash_commission_sources` stores hand identity, accepted payload hash,
requested club, table, rake envelope, contributor count and occurrence time.
Both `settled_at` and `accepted_at` preserve the original
`hand_atomic_commits.committed_at`; `captured_at` is diagnostic only.

`ca_cash_commission_facts` is keyed by `(hand_id, player_id)` and stores
booking club, seat generation, rake credit, assignment state, direct agent
identity, payer user, direct commission rate, player rebate rate, exact
`player_rebate_entitlement`, raw player terms, complete hierarchy and errors.

`ca_cash_commission_authority` is an immutable singleton containing contract
version 1, activation time and accepted owner before/after MD5. The owner patch
and singleton commit together. Its timestamp is not a calendar-period finality
guarantee. An empty query cannot permanently settle a period.

## Verification

Run `bash docs/audits/2026-09-10-union-accounting-proposal/source-authority/run-local.sh`.
The runner starts PostgreSQL 17 on a disposable Unix socket with no network
listener. It exercises the real capture/admission SQL and all five captured
`agent_commissions` triggers, including transition-table rollups and the actual
append-only journal guard.

Forty checks passed, including two observed PostgreSQL lock waits: concurrent
duplicate accrual creates one contributor's three rows once; and an assignment
mutation committed while capture is paused before its first fact insert cannot
mix terms across contributors. The next hand sees the newly committed terms.
Other checks cover source matching, exact seat identity, wrong amount, missing
and inactive assignments, fractional rebate entitlement, invalid margins,
legacy boundaries, inherited broad grants, actual permission denials, middle
tier rollback, whole-transaction rollback, and owner patch rollback.

The original three-stage fixture also passed after the explicit receipt-grant
correction. It remains an arithmetic/proposal test, not a production acceptance.

## Explicit Release Gaps

- This fixture seeds accepted envelopes synthetically. It installs and patches
  the exact current 795-line accepted owner, proves its body and rollback, but
  does not execute the full stack/lease/escrow owner dependency graph. Its
  source identity and acceptance composition require that integrated rehearsal.
- The captured inventory includes thirty triggers across agents, commissions,
  accepted commits and rake records. Only the five commission triggers execute
  here. Agent wallet sync/autoledger, rake escrow/reporting and all payer
  triggers still require the combined production-shaped fixture.
- The separate payer path must consume exact fractional entitlements and
  captured payer groups, preserve one payment identity across claim/batch/
  weekly close, and exclude unbound historical liabilities.
- Existing commission reporting uses accrual `created_at` and period-wide
  settlement markers. Late causal attribution across a period boundary is not
  proved by this proposal.
- In-flight calls holding the old accepted-owner body may finish around a
  CREATE OR REPLACE. The activation timestamp alone cannot certify capture for
  that overlapping tail. A reviewed release boundary with the existing
  settlement coordination must prove the old callers drained before admission.
- Tournament fee source authority is still outside this prospective cash
  contract. The inherited tournament branch in the three-stage proposal remains
  unverified and cannot be approved by these cash checks.
- Configuration repair and management delivery for invalid captured terms
  remain separate acceptance tasks. No table or club is locked by this capture.

Current inspected source bodies: accepted owner
`0ef3c57a6a31acc383ce4b95a0f9519f`; allocator
`a63ce6760dc4178f000f2214a7cf7cd6`; original commission primitive
`1583ac138b7687091e7c5a049f0639e9`.

Supabase's current function/ACL guidance and changelog were consulted.
Object grants and RLS are independent, and default function grants must be
explicitly removed:
https://supabase.com/docs/guides/database/functions
https://supabase.com/docs/guides/database/postgres/row-level-security
