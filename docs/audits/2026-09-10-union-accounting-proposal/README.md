# Union And Hierarchy Accounting Audit

Status: A verified worker correction and a locally rehearsed database proposal.
The database proposal is NOT READY FOR PRODUCTION: canonical source authority,
historical zero-row boundaries, and competing player-rebate payers remain open.
No production DDL, wallet write, historical backpay, push, merge, or deployment
was performed by this lane. The complete hierarchy/accounting programme remains
open. Baseline: `09c01fba4`, September 10, 2026. The independent release
coordinator owns integration and production acceptance.

## Completed Source Correction

Commit `6e3d0fc80` retains the cash rakeback worker's durable source page when
commission or player-statistics attribution fails. The previous code advanced
the cursor when a later period recompute succeeded, even when an earlier
financial obligation never accrued. Receipt validation now rejects malformed
counts and preserves legitimate zero-insert statistics replays. Before:
23 failed and 15 passed tests. After: 45 passed, server TypeScript passed.
This is a worker retry, with no change to table, club, or player availability.
The next commit corrects the changelog filename's accidental September 11 date.

## Confirmed Current Hierarchy Defects

The live `credit_agent_commission_from_rake` body was read directly, MD5
`1583ac138b7687091e7c5a049f0639e9`. Its caller is
`RakebackSettlerService._runSettlementInner` through
`fn_credit_agent_commissions_batch`. Tournament fee attribution calls the same
primitive through `fn_attribute_tournament_rake`.

1. Idempotency omits the contributing player. A second player under the same
   agent at one hand is mistaken for a retry and loses their commission accrual.
2. Only direct agent plus immediate parent are walked. Fifty active relationships
   in the live snapshot have a grandparent, so sub-agent chains are in scope.
3. The parent receives a percentage of the remainder, rather than the difference
   between contractual percentages of one gross base. This does not implement
   the user's ten percentage point hierarchy margin model.
4. The self-agent fallback can select an agent row in a different club.
5. Rate enforcement is incomplete: nine active parent-child edges have less than
   a ten percentage point gap. Existing generic union rate bounds do not prove
   all role-specific bounds, parent gaps, or dependent player deals are valid.

The isolated baseline reproduced items 1-3 with actual old SQL: two contributors
of 100 each under a .25/.50/.70 chain created only two rows totaling 62.50,
with zero for the super agent. The proposal created six immutable rows totaling
140, with 25/25/20 per contributor. This establishes accrual arithmetic only.
Weekly Round 3 debits agent proceeds for player rakeback, but the independent
player claim calls `fn_close_settlement_period`, which debits club treasury.
An agent claim also pays its full accrued amount from club treasury. Until all
paths enforce one approved payer, a .15 player rebate can create a separate
liability beyond the .70 commission envelope; net hierarchy margins are unproved.
No statistical rake attribution creates spendable chips in this proposal.

## Actual Configuration, Not An Assumed Global Rate

The live Midway Union settings observed September 10 contain:

| Setting                            | Observed Value |
| ---------------------------------- | -------------- |
| Generic agent band                 | .20 to .70     |
| Super-agent role band              | .60 to .70     |
| Agent role band                    | .20 to .50     |
| Sub-agent role band                | .20 to .30     |
| Player deal band                   | .10 to .50     |
| Player minimum gap                 | .10            |
| Union rake hold / clubs            | .10 / .90      |
| BBJ setting, main / backup / promo | 50 / 25 / 25   |

Active records: 86 agents (.20-.60), eight super agents (.20-.70), and fifty
sub-agents (.20-.30). No active cross-club parent edge was found. Some configured
bands and active records differ from the earlier requested 70%, 40-60%, and
10-30% profile. The proposal preserves assigned rates, computes differential
allocations, and alerts management about insufficient gaps. It does not rewrite
those assignments. The BBJ values above are a settings observation only; actual
allocation, pivot rules, and each bank's journal still require their Phase 5
trace. Main BBJ's binding requirement remains 50%.

## Three-Stage Proposal

These SQL files live under this audit directory deliberately. They are not
registered migrations or an instruction to apply production DDL immediately.
Version `20260910053719` was reserved with `scripts/new-migration.mjs` while
preparing the proposal; no migration with that version was applied.

1. `01-schema.sql`: Add nullable `agent_commissions.contributing_user_id` and an
   internal, RLS-enabled receipt table. Existing rows and balances remain intact.
2. `02-online-index.sql`: Build the contributor-aware unique index concurrently,
   outside a transaction. It retains original source IDs and preserves old NULL
   contributor uniqueness using `NULLS NOT DISTINCT`.
3. `03-cutover.sql`: Require the exact valid index and expected old function MD5,
   then replace the obsolete unique index and canonical function in one bounded
   transaction. The unused alternate calculator loses service/client execution
   so the unused calculator cannot open a second source identity. Both cash and
   tournament callers remain wired
   through the existing function signature and batch RPC.

New receipts bind contributor, source, source type, requested club, and exact
rake amount. Replays return the original result before consulting changed rates
or hierarchy. Each contribution gets separate immutable accrual rows. The
function walks the complete active hierarchy, rejects cycles and cross-club
parents, and computes cumulative rounded gross entitlements before taking the
slice for each tier. Configuration gaps create management alerts without rate
rewrites or table/club lockdowns. The existing batch reports failed inputs, and
the cursor correction retains their source page for retry.

The function still trusts a service-supplied source UUID, contributor and amount;
its receipt is not proof that a canonical hand or tournament ledger authorizes
those facts. The next paired audit must bind inputs to immutable accepted source
facts. In addition, an old no-agent/zero-row attempt has no commission row for
the legacy guard to detect; reassignment followed by retry could accrue history.
No historical repair or backpay is authorized.

An already-booked legacy source has no trustworthy contributor mapping. It is
classified `legacy_preserved`, with its existing rows unchanged. The proposal
never guesses who was previously paid and never backfills history. This legacy
boundary is a limitation to disclose, not a claim that historical obligations
are correct.

## Local Verification And Remaining Release Gates

Run `bash docs/audits/2026-09-10-union-accounting-proposal/run-local.sh`.
The runner starts an isolated PostgreSQL 17 cluster on a Unix socket, uses only
synthetic identities, and stops its cluster on exit. `local-proof.json` records
34 passing behavioral/concurrency checks plus the old-body reproduction.

Checks include shared ancestors, full chain, cent conservation, identical and
changed-payload retries, concurrent duplicates, concurrent distinct contributors,
foreign-club fallback, cross-club parents, cycles, invalid numeric values, a
middle-tier failure rolling every row and receipt back, rate changes after the
original receipt, old-source preservation, privilege/RLS expectations, alerts,
the retired alternate source-ID calculator, and the captured live union resolver. No test moves production chips.

Production gates still required: review changed live bodies and active callers;
review all existing table triggers and settlement readers with the new column;
rehearse the full production schema and partial weekly-close/claim interactions;
run advisors and scoped role-negative probes; serialize the online index build
against other DDL; confirm index readiness and exact definition; record approved
schema migrations; integrate and publish the cursor fix; observe committed
source receipts and management delivery. No independent certification is claimed.

Rollback boundaries: before stage 3 commits, transactional failure retains the
old index/function. Before any new contributor rows exist, stages 1-2 are
additive and can be left in place. After contributor rows exist, recreating the
old unique key would conflict with legitimate multiple contributors. Do not
delete or merge those rows to force a rollback. Preserve the new key and fix
forward with receipt-compatible code. A production restoration rehearsal is
still required; the local proof is not a claimed production rollback drill.

## Full Scope And Evidence Limits

`coverage-map.csv` names the Union -> Club -> Super Agent -> Agent -> Sub Agent
-> Player paths and the outstanding per-path acceptance. The source/backend
functions were discovered and selected high-risk paths traced, not every route
behaviorally certified. `live-function-inventory.json` snapshots 456 financially
named public functions and 18 selected accounting tables, including body MD5,
privilege, and RLS metadata. This lexical inventory is supplemental: functions
with unrelated names, triggers, policies, and the original full source register
must also be traced. A grant alone does not establish whether a caller passes
RLS or function-body authorization.

Union create/settings/application and several wallet commands cross the
Club Arena client's `/api/club-arena/manage-union`, `union-application`, and
`union-wallet` dependencies. Their World Hub implementations were not inspected
or edited, in accordance with the programme boundary. Their end-to-end
certification is explicitly deferred, even when the Club Arena caller is traced.

High-priority follow-up candidates include cash-claim versus weekly-close
serialization (amounts are selected before treasury locks in Round 2), Round 3
versus independent rakeback payment concurrency, commission `created_at` versus
underlying game-period attribution, historical seat-club attribution when a
player has multiple union memberships, assignment/role/rate mutation atomicity,
and all refund/reversal and reserve-bank receipts. These are investigation
items, not untested claims that a particular double payment already happened.

## Independently Delivered Changes On Fresh Main

Fresh main `5800a2b9d` contains `b242d60a4` (#4113), which adds explicit finance
scope and visible read failures to admin money pages, scopes exports/ledger
reads, and introduces UnionOverseerGuard and financial route gates. It also
contains `d1b13a09c` (#4117), recording DB CPU work on audit/reconcile indexes,
cron cadence, seat guards, and Spin draw handling. Their source/changelog diffs
were reviewed for overlap. These were delivered by other workstreams; this lane
did not rerun their entire acceptance or verify their deployed behavior. Neither
commit changes this lane's RakebackSettlerService/CommissionService/UnionOpsService
source baseline. Incorporate their new files into the next per-file coverage pass.

## Next Independent Audit Batches

- **Union Membership And Authority:** creation/admin changes, club applications,
  joining/exiting/expulsion, statement issuer preservation, all hierarchy
  assignments and promotion/demotion, role/union gaps. Verify DB-bound identity,
  changed memberships during requests, and new guards from #4113.
- **Union And Club Wallet Rails:** all bank/promo/BBJ/rake/Spin reserve sends and
  pulls, cashier source selection, business/player/self-stake, credit draw/repay,
  owner and agent reversals. Trace selected UI balance to actual debit and receipt.
  The BBJ wallet's club-send route currently selects the bank route; verify its
  approved semantics and user feedback rather than assume those accounts match.
- **Accrual, Claims And Weekly Close:** full production-schema proposal rehearsal,
  assignment/rate snapshot timing, claim versus Round 2, Round 3 versus player
  claim, one payer per obligation, late-arriving source attribution, two concurrent
  periods, short recipient funding, and immutable payment receipts.
- **BBJ, Promo, Treasury And Issuance:** main50%, verify actual backup/promo pivot
  rules, every bank transfer/payout, reserves/guarantees, mint/burn, asset conversion,
  tickets/escrow and funded refunds. Coordinate format-specific obligations with
  the tournament lanes instead of duplicating their pending edits.
- **Reporting And Reconciliation:** every new admin page/export, weighted stats
  versus earned/payable/paid amounts, accrual liabilities, source-booking club,
  journal replay, incident classification and actual management push delivery.

Every batch must promote inventory rows to traced/tested/released only when its
own evidence exists. None of these next batches is marked complete here.

## Primary Benchmarks

- GLI-19 v3.0 sections 2.5.6-2.5.7 and 2.8.5 describe confirmations, durable
  transaction identity, account records, and histories. Used as technical
  comparison criteria only, not a claim of jurisdictional applicability or full
  GLI conformance: https://gaminglabs.com/wp-content/uploads/2024/06/GLI-19-Interactive-Gaming-Systems-v3.0.pdf
- PostgreSQL transaction isolation and uniqueness define the concurrency/retry
  guarantees used by this proposal: https://www.postgresql.org/docs/current/transaction-iso.html
  and https://www.postgresql.org/docs/current/index-unique-checks.html
- PostgreSQL explains concurrent index builds, invalid indexes, and the
  prohibition on running them inside a transaction:
  https://www.postgresql.org/docs/current/sql-createindex.html
- Supabase distinguishes object grants, RLS, and privileged function boundaries:
  https://supabase.com/docs/guides/database/postgres/row-level-security

Accessed September 10, 2026. Hierarchy percentages and margin rules are user and
product configuration, not an invented universal competitor rate schedule.
