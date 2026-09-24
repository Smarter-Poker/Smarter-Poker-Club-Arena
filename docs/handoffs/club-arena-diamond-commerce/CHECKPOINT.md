# Club And Union Diamond Commerce: task checkpoint

Assignment CA-DIAMOND-COMMERCE-2026-09-22, Revision 2 (the complete replacement
for Revision 1 of 02_DIAMOND_MONETIZATION_HANDOFF.md). The revised specification
is preserved beside this file as `CA-DIAMOND-COMMERCE-2026-09-22-R2.md`,
SHA-256 `4434b6d05bd955b9f0887808d5b416b349521e5f7e7580019481c96d73c1f57e`
(Revision 1 input SHA-256 as recorded by R2:
`007b50b0aa6ef9c703766ad3c215207fa7d632a8c4345a6102e64efb7506b844`).

Status vocabulary (R2): Observed In Source; Observed In Live Definition At A
Stated Time; Historical; Proposed; Implemented; Tested; Merged; Installed;
Published; Production-Verified; Unknown.

## Authorization, scope and acceptance

- Authority: the owner's Revision 2 assignment supplied to this implementation
  chat on 2026-09-22 together with the canonical checkout folder; owner policy
  2.9 (September 17, 2026) for direct completion through the protected routes.
- Owner-locked decisions honoured: diamond-only model, full first-month
  operator offer, no permanent free tier, no OFC, gameplay economics untouched.
- Scope: catalog, quotes, operator trials, diamond checkout, entitlements,
  renewals, upgrades, union sponsorship, refunds, operator UI, catalog
  administration, isolated qualification, installation, publication.
- Exclusions in this increment (each recorded as unavailable, none sold):
  report exports and reporting packs (fulfillment mapping to an existing
  generator is a later increment), premium artwork SKUs (asset/renderer
  mapping), delegated sponsor spending from a club admin's own session (needs
  the trusted service route in the World Hub API), admission wiring into the
  existing join/table/tournament doors (the admission policy function exists
  and is in shadow until `ca_commerce_settings.admission_enforced_from` is set).
- Acceptance: the D-series scenarios listed below pass on isolated PostgreSQL
  against the production-captured wallet fixture; the migration installs and
  reads back; the client publishes and renders; the engine consumer is staged
  through the engine route.

## Policy receipt

- Read 2026-09-22 14:05Z (start) from the fresh clone at `origin/main`
  a759cf82e3b153f3ad583f0349de8868b444cf6f and from the owner's Mac
  (`/Users/smarter.poker/Documents/AGENTS.md`, `AGENT-HARDENING-STANDARD.md`,
  and the portable `docs/agent-policy/*`).
- `node docs/agent-policy/agent-policy.mjs check`: policy version 2.9, manifest
  SHA-256 `7663cc909626f7e9966931d27166ad8774addc801f7ad1898a2d7564bc13c378`;
  OWNER-POLICY 76228d75677e, OPERATING-LAW a8bc3c04dce3, HARDENING d5fc451ce5ca,
  REFERENCE-INDEX adce89c3f838.
- Also read: repository `AGENTS.md`, `CLAUDE.md` (sections 1, 2, 4.5, 5, 10.9,
  10.11, 10.12, 10.87, 11, 11.5, 12, 13), `PUBLISHING.md`,
  `docs/standards/EVENT-DRIVEN-EXECUTION.md`, `.claude/skills/club-arena-console/SKILL.md`
  (section 0 and 0.1).

## Source, database and delivery identities

| Item             | Identity                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base             | `origin/main` a759cf82e3b153f3ad583f0349de8868b444cf6f (matches the R2 read)                                                                                                                                                                                                                                                                                                                                                              |
| Owned branch     | `feat/club-and-union-diamond-commerce`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Migration        | `supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql` (version reserved by `scripts/new-migration.mjs`)                                                                                                                                                                                                                                                                                                                |
| Schema fragment  | `scripts/ci/schema-manifest.d/club-and-union-diamond-commerce.json` (14 tables, 35 functions)                                                                                                                                                                                                                                                                                                                                             |
| Isolated runner  | `tests/sql/run-diamond-club-commerce.py` (private cluster; registered in `scripts/ci/run-diamond-sql-acceptance.py`, `tests/unit/diamondAcceptanceCi.test.ts`)                                                                                                                                                                                                                                                                            |
| Client           | `src/services/ClubCommerceService.ts`, `src/pages/club/ClubDiamondCostsPage.tsx`, routes `clubs/:clubId/diamond-costs` and `unions/:unionId/diamond-costs`, operations registry item `diamond-costs` (finance, suffix in `OPERATION_SUFFIXES` and `FINANCE_SUFFIXES`), union rail entry `Diamond Costs` in `arenaSectionNavigation.ts`                                                                                                    |
| Engine           | `server/src/services/CommerceRenewalConsumer.ts` (+ test), registered in `server/src/index.ts` leader-owned services                                                                                                                                                                                                                                                                                                                      |
| Pull request     | #5077 `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5077`; commits 947b64e23, 9b1927e58, e46819e96, 779e6ef81 (branch head 779e6ef8132dda41bd312e3fb0a6ac4d351f5278)                                                                                                                                                                                                                                                    |
| Supabase project | kuklfnapbkmacvwxktbh (PokerIQ-Production)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Live reads made  | 2026-09-22 14:17Z: `deduct_diamonds` definition (self-payer guard `auth.role() = 'service_role' OR auth.uid() = p_user_id`; FIFO lot consumption; journal spend to `revenue:<source>`); function signature list; extension list (btree_gist not installed, so interval identity is enforced by the scope advisory lock plus the period identity index rather than an EXCLUDE constraint). No customer balances or payment rows were read. |

## Architecture decision: the commerce boundary

- One transactional boundary in PostgreSQL: `fn_ca_commerce_purchase_impl`
  (service-only) behind the browser door `fn_ca_commerce_purchase` (authenticated,
  actor = `auth.uid()`). Every new purchase, renewal and upgrade goes through it.
- Trust boundary (R2 1.2): a payer's own session satisfies the canonical
  self-payer guard inside `deduct_diamonds`; the same function refuses
  `sponsor_route_required` when the payer is not the session. The union owner
  therefore pays for covered clubs from the union owner's own session (D12,
  D43, D44 qualified). A club admin spending a union budget from their own
  session is the deferred World Hub API increment (`pages/api/club-arena/*`
  with the service role), not a SECURITY DEFINER wrapper (R2 1.2 forbids it).
- Accounting treatment (R2-A02..A06): debit through `deduct_diamonds`
  (source `club_commerce`, journal class `spend`, counterparty
  `revenue:club_commerce`, register burn by the existing journal-following
  trigger); refund through `add_diamonds_to_balance` with the exact-value
  type `refund` (already in the multiplier exception list; register mint by
  the existing origin rule). The boundary then PROVES: the journal row
  (amount, class, counterparty), the exact linked `ca_mint_ledger` row
  (action, asset, amount, holder), and the persisted purchased-lot deltas
  against a before/after snapshot taken under the payer's wallet lock. Any
  unproved postcondition raises and the whole operation rolls back (D33, D34).
- Lock order: quote row -> scope advisory lock -> sponsorship row -> payer
  `profiles` row (same lock `deduct_diamonds` takes) -> `diamond_debts` ->
  `diamond_purchase_lots`. No global economy lock; `supply_after` stays
  observational (R2-A09).
- Duplicate barriers: `(actor_id, request_key)` unique with a request hash
  (D04, D05); `quotes.purchase_id` / `purchases.quote_id` unique (D31); the
  entitlement period identity index `(scope_kind, scope_id, kind, starts_at)
WHERE effective` plus the overlap predicate under the scope lock (D32).
- Trial contract: one initial operating trial per operator identity (the
  scope owner), 720 hours in UTC, later scopes inherit the common end (D47);
  a `trial_operating` right records zero principal; inside the trial a
  purchase is refused (`trial_active_authorize_instead`) and the owner records
  a post-trial authorization (a renewal mandate on the trial right) that the
  consumer executes at the trial end (R2 4.6, D02, D03).
- Renewal contract: mandate = payer, sku, quantity, ceiling, due time; the
  consumer claims under a two-minute lease (`FOR UPDATE SKIP LOCKED`),
  re-validates ownership, price ceiling, lateness (24 hours, then
  `needs_attention`, never accumulated debt) and funds, and either extends
  once or leaves a visible attention state with a notice (D09, D10, D49, D50).
- Upgrade proration: credit = floor(value_basis x remaining/interval); new
  line = ceil(list x remaining/term). Residues never favour free capacity;
  staged and direct upgrades agree within whole-diamond residues (D11, D54).
- Catalog: immutable published price versions, one published per product at
  a time, prospective effective dates, staff-only draft/publish, no comparison
  claim (`comparison_verified=false` everywhere) (D18, D26, D74).
- The orphaned `club_creation` row in `feature_pricing` is deleted at install:
  `fn_purchase_feature_v2` sold any `feature_pricing` row and nothing checked
  that one, so a client could have been charged 100 diamonds for nothing (D29).

## Traceability register

| Finding                                    | Contract                                                       | Source                                | Test                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| R2-A01 personal feature semantics          | explicit club/union entitlements, 720h terms                   | migration sections 5, 10              | D67 (`fn_purchase_feature_v2` unknown feature; runner asserts no commerce SKU is a `feature_pricing` row)                  |
| R2-A02 spend is a burn; no treasury wallet | one `deduct_diamonds` debit, no second burn                    | purchase_impl                         | D20 conservation                                                                                                           |
| R2-A03 lot helper swallows failures        | before/after lot snapshot under wallet lock, raise on mismatch | purchase_impl postcondition 3         | D33, D37, D65                                                                                                              |
| R2-A04 register trigger swallows failures  | exact linked `ca_mint_ledger` row required                     | purchase_impl postcondition 2; refund | D34, D35                                                                                                                   |
| R2-A05 `_refund` multiplier risk           | exact-value type `refund`, amount proved                       | fn_ca_commerce_refund                 | D36, D41                                                                                                                   |
| R2-A06 FIFO and debt settlement            | gross / debt / net reported separately                         | fn_ca_commerce_refund, notices        | D38                                                                                                                        |
| R2-A07 replay cost 0                       | `original_total_diamonds` beside `charged_this_attempt`        | receipt_json, client receipt console  | D04, D68                                                                                                                   |
| R2-A08 reserves                            | 23514 mapped to `reserved_diamonds`, purchase fails whole      | purchase door handler                 | D07 (insufficient), D08 by contract of the profile trigger (spin reserve function not in the captured fixture; see limits) |
| R2-A09 supply_after observational          | no global lock added                                           | purchase_impl                         | D70                                                                                                                        |
| R2-A10 club_creation orphan                | row deleted, assertion at install                              | migration section 0                   | D29                                                                                                                        |
| P2-F04/F14/F15/F16/F17/F18                 | as above                                                       |                                       |                                                                                                                            |

## Phase state

Updated 2026-09-24 14:20 UTC, after the backend half shipped (#5196).

| Phase                            | State                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Discovery, authority, baseline | Done                                                                                                                                                                                                                                                                                                   |
| 1 Contracts and schema           | Installed and read back: `20260922143541`, `20260924033509`, `20260924102040` (14:15 UTC) and `20260924102056` (14:16 UTC). All 65 commerce and door function bodies are md5-identical to the qualified build.                                                                                         |
| 2 Trial                          | Implemented, Tested. Launch cohort now refuses until the consumer heartbeat is under 10 minutes old and records a launch notice per owner (refunds runner).                                                                                                                                            |
| 3 Quotes, checkout, exactly-once | Implemented, Tested. Withdrawing a product withdraws its open quotes (D06).                                                                                                                                                                                                                            |
| 4 Renewals, upgrades, lifecycle  | Implemented, Tested. Sponsors authorize renewals of what they paid for; price-increase and short-balance notices go out before the due date; mandates record terms and ceiling text versions.                                                                                                          |
| 5 Sponsorship                    | Implemented, Tested for the sponsor's own session (union page Buy For A Covered Club, sponsor renewals).                                                                                                                                                                                               |
| 6 Reports, assets, refunds       | Refunds: owner request under versioned policy v1, staff decision on the Commerce Desk, execution by the consumer in service context, owed state visible. Reports and assets: not for sale, per-SKU reasons in `evidence/unsupported-offerings.md`.                                                     |
| 7 Operator UI and catalog admin  | Service layer published (`113059a9`). The owner page growth and the staff Commerce Desk are in #5193, blocked on the whole-app bundle ceiling (decision 8). Built:                                                                                                                                     | Owner page (refund requests, policy, balance breakdown, sponsor renewals, former-owner receipts, truthful access copy) and staff Commerce Desk at `/commerce-desk` (refund queue, price lifecycle, product support, settings, comparison evidence). |
| 8 Qualification                  | 159 + 135 + 30 isolated checks (Prompt 1's registry installed first) on the production migration order; unit contract tests pin every RPC key and refusal copy against the SQL.                                                                                                                        |
| 9 Readiness                      | `evidence/` holds the C.1 wiring map, traceability register, activation matrix, state diagrams, compatibility/recovery matrix, D80 per-SKU map, economic model, operational metrics; competitor register in `competitor-evidence-2026-09-24.md` (no comparison claim is supportable; badge stays off). |
| 10 Install, rollout, release     | See the changelog delivery records. Engine releases have failed estate-wide since 2026-09-21 (release workstream, #5161); the consumer ships with the first successful one.                                                                                                                            |
| 11 Final evidence                | `evidence/` and the changelogs dated 2026-09-24.                                                                                                                                                                                                                                                       |

## D-series applicability

Passing in isolation: D01, D02, D03, D04, D05, D06, D07, D09, D10, D11, D12,
D17, D18, D19, D20, D21, D22, D26, D27, D29, D31, D32, D33, D34, D35, D36,
D37, D38, D39, D40, D41, D42, D43, D44, D45, D46, D47, D49, D50, D51, D54,
D63, D64, D65, D66, D67, D68, D70, D73, D74, D76, D78, D80 (mapping).

Not applicable in this increment, with the reason: D13, D14, D15, D16, D48,
D56, D57, D58, D59, D60, D61 (report and asset offerings are not for sale);
D23, D30, D62 (unchanged existing systems; no change made); D25 (no
comparison claim is published; the evidence workflow is the catalog's
`comparison_evidence` column, empty until verified); D28 (old clients cannot
reach the new doors; `fn_purchase_feature_v2` semantics untouched); D52, D53
(accepted-event continuation is Prompt 1's contract; the admission function
never sits in a gameplay path, asserted); D69 (a deadlock retry is the
consumer's whole-wake retry; the database refuses a stale lease); D71 (no
reconciliation writer exists by design; the D20 conservation read is the
read-only check); D72 (no external provider is called inside the boundary;
notices are durable rows delivered by the consumer); D75 (deletion retention
is the existing profile tombstone process; receipts carry the payer id); D77
(no metrics pipeline change in this increment).

Limits stated plainly: the spin-reserve trigger (`fn_diamond_spin_wallet_reserve`)
is not in the captured fixture, so D08 rests on the purchase door mapping the
trigger's SQLSTATE 23514 to a whole-operation refusal, exercised through the
wallet ceiling path (D64) rather than the reserve path itself.

## Decisions made (2026-09-24, owner delegated every decision)

1. Refunds: owners request, platform staff decide on the Commerce Desk, the
   commerce consumer executes in service context. The profile wallet guard is
   not changed. A refund the wallet cannot receive stays owed and visible and
   is executed by the same consumer when it can be.
2. Launch cohort: runs only when the consumer's heartbeat proves it is live
   (the function refuses otherwise). It is run by the owning task after the
   first successful engine release, and recorded here.
3. Admission: shadow at seven doors (the four owner doors, plus the three a
   club gains a member through: automatic joins, invite admissions and agent
   adds; 3 of 5 live clubs admit automatically). Enforcement is switched on
   only after the cohort's trials have run, the shadow report on the Commerce
   Desk has been read, and the two remaining browser-insert bypasses in the
   admission changelog are closed.
4. Prompt 1 integration (their `CAPABILITY-CONTRACT.md`, installed
   2026-09-24): insurance modules are sold only while
   `cash.insurance_ev_cashout` is available; `fn_create_tournament` records
   commerce's reference on the acceptance record; nothing in commerce checks
   an existing event (`evidence/prompt1-shared-interface.md`, version 2).
5. Delivery is split in two because the whole-app bundle ceiling (2,800 kB
   gz; main measured 2,794) cannot hold the staff Commerce Desk and the owner
   page growth (+22 kB gz, no duplicated vendor left after removing the
   second immer), and raising the ceiling was refused by this session's
   safety check. The server, harness, engine and service changes ship first
   (they fit: 2,795 kB); the two pages wait for the owner's call on the
   ceiling.
6. Reports and artwork: not for sale until their rights are established
   (`evidence/unsupported-offerings.md`).
7. Union back office and union insurance: withdrawn from sale after install,
   because no union admission point is defined yet, so a purchase would grant
   nothing. Re-enabled when the union tools door exists.
8. Comparison claims: none shown; the competitor register supports no global
   claim and no per-SKU claim from a primary source for the low tiers.

## Remaining scope

Refused by the session's safety check when delegated ("Auto-Mode Bypass"),
therefore not built in this pass: checkout gated until the free month exists,
catalog_visible honoured by catalog and quote, terms version on trials and
purchases, quote/purchase rate limits, roster vs concurrent capacity
publication, written quotes above 2,500 members, the trial review path,
named-club union coverage with history, union insurance covering club
insurance and the overlap credit, sponsor purchase of club insurance. Also
open: trial waiver value recorded on the trial right, settled-earnings
coverage readout, durable metrics for replays and failed checks (R2 1301),
tests D75 and D79, the shared Prompt 1 interface (`evidence/prompt1-shared-interface.md`
describes what exists).

## Next actions

1. Done 2026-09-24: #5196 merged (`113059a9`), published (run 36009651551,
   both build-info endpoints serve `113059a9`, the served Diamond Costs chunk
   carries the new service), `20260924102040` installed (run 36011338391) and
   `20260924102056` installed (run 36011474185), read back, and
   `union_back_office` and `union_insurance_module` withdrawn from sale
   through `fn_ca_commerce_product_support` (0 open quotes withdrawn).
   Delivery record: `docs/changelog/2026-09-24-diamond-commerce-backend-delivery.md`.
2. Owner call: the whole-app bundle ceiling for #5193 (the staff Commerce
   Desk and the owner page growth, +22 kB gz measured, no duplicated vendor).
   Once decided, merge #5193 and verify its publication.
3. After the first successful engine release (release workstream; the engine
   is still `8825af51`, and the 14:03 UTC deployment-recovery window ended
   without a new engine): verify `/health`, the consumer heartbeat, then run
   the launch cohort and record it.
4. Before enforcement: read the Admission tab; move the two remaining
   browser-insert privileges (`Users can join clubs`,
   `tables_insert_owner_or_admin`) behind the doors.
