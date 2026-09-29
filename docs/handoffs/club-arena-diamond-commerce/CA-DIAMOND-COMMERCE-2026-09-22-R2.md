Diamond-Only Club And Union Commerce, Activation, And Verified Charging

Paste or upload this entire document into the implementation chat.

Revision 2, September 22, 2026. Assignment ID: CA-DIAMOND-COMMERCE-2026-09-22.

This is the complete replacement for Revision 1 of 02_DIAMOND_MONETIZATION_HANDOFF.md, not an addendum to run alongside it. The companion Product Completion prompt remains a separate assignment. Preserve applicable work already completed under either prompt; do not restart or replay it merely because this document was revised.

Revision 1 input SHA-256: 007b50b0aa6ef9c703766ad3c215207fa7d632a8c4345a6102e64efb7506b844.

The Revision 2 preparation read the entire original commerce prompt and the entire companion product prompt, refreshed selected repository and live database definitions, and amended this document only. No application code, production configuration, balances, catalog prices, or deployments were changed by this review. Its new failure findings are observations of installed function definitions, not injected production failures or evidence of a measured customer loss.

Read the R2 verification update before following the phases. Original phase numbers 0-11 and tests D01-D30 are retained; additional contracts and tests D31-D80 extend them. This document remains an implementation assignment when the owner supplies it to an implementation chat. Reading the document in a review chat does not itself activate charges.

Navigation

R2 Verification Update And Critical Corrections

Mission And Scope

Workstream Coordination

Mandatory Context, Authority, And Preservation Rules

1. Recorded Commercial And Accounting State

2. Existing Source, Database, And API Map

3. Candidate Catalog V1: Preserve This Starting Schedule

4. Competitor Evidence, Price Protection, And Unresolved Rates

5. Phase 0: Discovery, Actual Authority, And Baseline

6. Phase 1: Commercial Contracts And Data Ownership

7. Phase 2: Full Thirty-Day Operator Trial

8. Phase 3: Authoritative Quotes, Checkout, And Exactly-Once Charging

9. Phase 4: Renewals, Upgrades, Downgrades, And Lifecycle Continuity

10. Phase 5: Union Coverage, Sponsorship, And Earned Diamonds

11. Phase 6: Reports, Assets, And Fulfillment

12. Phase 7: Operator UI And Commercial Administration

13. Phase 8: Security, Economic, And Failure Qualification

14. Phase 9: Economic And Distribution Readiness

15. Phase 10: Migration, Rollout, And Actual Charging

16. Phase 11: Required Final Evidence And Acceptance

Appendix A: Read-Only Intake Queries

Appendix B: Research And Internal References

Appendix C: Integration Contracts And Completion Checklist

Final Execution Instruction

R2 Verification Update And Critical Corrections

What Was Rechecked

Source baselines freshly read for this revision: Club Arena a759cf82e3b153f3ad583f0349de8868b444cf6f; World Hub cee7a6ef6491a52501525ca27b2acd600385a87d. These are source refs, not claims of installed client or engine versions. Current PUBLISHING.md and docs/agent-policy/OWNER-POLICY.md were read at the Club Arena ref. Live SQL introspection was available during R2 and was used only in read-only transactions against kuklfnapbkmacvwxktbh from 2026-09-22T13:26:09Z through 13:28:13Z.

The scope of those reads was function definitions, enabled trigger metadata, table/column names, and public product configuration. No customer balances, individual payment records, game activity, or private account data were queried. No gameplay or purchase function was executed. Reproduce only the relevant findings under the successor's current environment and source, because concurrent agents may have repaired them.

Architecture Corrections That Override The Earlier Wording

ID

Rechecked Fact Or Required Correction

Consequence For Implementation

R2-A01

fn_purchase_feature_v2 is a personal-player purchase function. Its per_session term is eight hours, not a club operating month.

Reuse its proven ledger/receipt patterns, but implement explicitly scoped club/union contracts. Do not represent thirty-day capacity as an eight-hour personal feature or a VIP flag.

R2-A02

Ordinary deduct_diamonds service spending is journaled as spend to a revenue: classification; the journal-following path registers a Mint burn.

Do not add a second burn or invent a platform revenue wallet. A classification label is not proof of a spendable treasury or recognized cash revenue.

R2-A03

fn_ca_consume_purchase_lots catches lot-write errors; its returned accumulator alone does not prove the persisted lot changes.

The new commerce transaction needs operation-linked allocation evidence and strict postconditions before commit. Failure must roll back this new purchase, not silently grant access with incomplete provenance.

R2-A04

fn_ca_diamond_register_follows_journal catches register-write errors and attempts incident reporting instead of raising.

Prove the exact required Mint row for the new purchase/refund inside its transaction. A successful wallet debit alone is insufficient. Do not globally change unrelated legacy rule modes.

R2-A05

add_diamonds_to_balance applies a VIP multiplier to some positive types. A new name ending \_refund is not automatically in its exact-value exception list.

Prove exact-value classification end to end. Never let a refund of 100 diamonds become 200 because the recipient has a multiplier.

R2-A06

The existing debit policy consumes eligible purchased lots FIFO before promotional balance. Positive credits may first settle existing diamond_debts.

Earned-diamond coverage is a cost-offset explanation, not permission to change FIFO. Statements must distinguish gross refund, authorized debt offset, and actual spendable increase.

R2-A07

A replay from fn_purchase_feature_v2 can return cost=0 and original_cost for an already-paid purchase.

Present the original total separately from charged_this_attempt; do not label the original sale free or retry under a new key.

R2-A08

Spin reserves protect negative pending obligations and integer headroom for positive incoming settlement.

Respect both availability and maximum-balance limits on debit, refund, and earmark changes. Pending positive custody is not available spending money.

R2-A09

Mint supply_after is explicitly observational under concurrency, not a globally serialized running balance.

Use exact journal/register identity and consistent-snapshot supply reconciliation. Do not add a global economy lock to force sequential snapshots.

R2-A10

Eligibility still reports four memberships while the creation implementation checks ten; club_creation remains priced at 100 diamonds.

Keep Prompt 1's eligibility ownership and Prompt 2's catalog ownership. Do not activate the orphaned creation price through an unrelated feature purchase.

These are acceptance conditions for the new commerce boundary. They are not authorization to rewrite the entire diamond economy, relax existing safety checks, manufacture historical lot allocations, or claim the existing financial system has passed fault injection.

Authority And Terminology

Distinguish owner-locked decisions, candidate commercial rates, proposed policy defaults, observed source/installed definitions, and accepted customer authorization. The owner locked the diamond-only model, full first-month operator offer, absence of a permanent free tier, no OFC, and preservation of gameplay economics. The particular capacity bands, report prices, proposed trial-identity rules, and other suggested defaults are carried-forward recommendations, not verbatim owner rulings.

Use the latest actual owner-confirmed contract where one exists. Resolve ordinary technical choices within the assigned authority and record them. A genuinely missing consequential commercial term blocks only that term's activation, not independent development, testing, or delivery. Do not invent a new GitHub human-approval gate, and do not treat a recommendation as permission to debit an uninformed customer.

The operator's service entitlement expires; their purchased diamond balance does not expire merely because the service period ends. A software-fee waiver is not a new currency. A paid report license is not permission to read another club's data. A refund is not a fresh reward. A quoted nominal dollar equivalent is not a cash-out promise.

Mission And Scope

You own the end-to-end implementation of a competitor-style diamond purchasing system for Smarter.Poker Club Arena operating capacity and specific services. Implement the price catalog, authoritative quotes, operator trials, diamond checkout, entitlements, renewals, upgrades, reports/assets, union payment coverage, statements, refunds, and release verification. Do not respond with another generic business-model proposal or a mock interface that cannot actually charge and grant access.

One diamond has a nominal catalog value of $0.01. All operator payments are diamond debits. The first 30 days provide the complete owner operating-software offer with no operator-service debit; ordinary economic funding and supported technical limits remain distinct. There is no permanent free operating tier, no dollar subscription plan, and no daily/hourly usage tariff in this assignment.

The user rejected three earlier models: fixed-dollar $7/$29/$99-style subscriptions, a permanent Community/free tier, and active-day/table-hour pricing. Do not revive them under new names. Diamond-funded renewable capacity and individually priced features are the selected direction. Do not make Diamond Spins earnings the rate formula. Earning opportunities remain separate perks that can reduce additional diamond purchases.

The catalog figures below are the carried-forward candidate launch schedule from the prior proposal, not prices already installed, not measured profitability, and not universally verified 20%-below competitor offers. Build them as a versioned configurable catalog and validate their scope/economics. Recover any newer owner-confirmed price instruction before publication. Do not silently invent missing rates, claim unverified savings, or interpret a sample as authorization to retroactively debit existing operators. Continue the complete engineering work even when an exact price-publication decision affects only one item.

Workstream Coordination

Prompt 1 owns multi-day tournaments, Kill/Half-Kill, advanced tournament functionality, technical capability readiness, and the four-versus-ten product eligibility repair. Do not rebuild those features in this assignment. Consume their capability IDs and accepted-event continuation contract. Product fixes and commerce can be developed in parallel with explicit ownership of shared files/functions.

This workstream owns catalog versions, pricing rules, operator account/payer scope, trial grants, purchase/renewal authorization, exact diamond charges, scope entitlements, sponsorship, receipts, commercial reporting, and price comparisons. Do not create a second capability registry or change game rules to enforce billing. Do not wait for every unrelated enhancement to finish before selling already complete services; do not sell an unfinished capability as available.

Use a bounded specialist swarm where available: commerce/ledger, entitlement/trial policy, operator UI, competitor-price validation, and independent failure/security review. One integration owner owns each shared transaction. If delegation is unavailable, execute these lanes honestly with one agent rather than pretending they ran.

Mandatory Context, Authority, And Preservation Rules

This is a self-contained implementation assignment for Smarter.Poker Club Arena. The owner is Daniel Bekavac. Read this entire prompt before acting, then read the current repository and path-specific instructions. On context loss, reread this prompt, the policies, and your existing task checkpoint. Do not substitute a short summary for the source instructions.

Owner Decisions That Must Not Be Reopened Or Reversed

NO OFC. Open-Face Chinese Poker is explicitly excluded. Do not implement it, resurrect retired OFC tables, or describe Crazy Pineapple as OFC. Preserve historical records without rewriting them.

The approved product targets are genuine multi-day tournaments, Kill and Half-Kill for supported fixed-limit games, and advanced tournament functionality, discovery, and reliability.

Monetization is a competitor-style catalog of diamond purchases for operating capacity and specific services. One diamond has a nominal catalog value of $0.01; 100 diamonds = $1. Do not introduce dollar subscriptions, the previously rejected $7/$29/$99 plans, a permanent free operating tier, or the discarded active-day/table-hour tariff.

Every eligible new operator receives the first 30 days of owner operating access with all included operating service fees waived. Existing operators receive an equivalent prospective transition offer. Never back-bill previously free usage. Operating access is not a gift of unlimited funded chips, wagers, prizes, or transferable diamonds.

Diamond-to-Chip Spins and other earning opportunities are separate cost-reducing benefits. They are not the price formula. Do not charge more because an owner earns more, alter odds to cover fees, promise profitability, or require players to spin to keep a club open.

Preserve the existing chip and diamond economic rules. The latest recorded owner-mint configuration is 100 diamonds per chip, not the retired inverse of one diamond per 100 chips. This internal configuration is not a representation of a legal cash-redemption right. Read the live authoritative configuration before any related change.

Preserve cash, MTT, SNG, poker Spin, satellite, insurance, EV Cashout, rake, weighted attribution, BBJ, backup BBJ, promo, and treasury accounting. Diamond Spins, poker Spin & Go tournaments, and Diamond Arena are different products. Diamond Arena is not a new private club/union billing scope and must not be mixed into chip ledgers.

Preserve the approved hierarchy: Union -> Club -> Super Agent -> Agent -> Sub Agent -> Player, with existing ownership/administrator permissions and valid direct-player relationships. The earlier operating audit records a 90% return to the member club based on its players' attributed union activity, not table ownership. Preserve actual current effective-dated agreements; do not substitute these historical examples for live contract data.

Historical hierarchy examples: Super Agents 70%; Agents 40-60%; Sub Agents 10-30%; players 10-50% subject to available upline allocation; minimum upline spread of ten percentage points on the approved common denominator. These are nested allocations, not additive independent payouts. Billing must not reprice them. An example 70 -> 50 -> 30 -> 20 allocation pays 70 total, not 170.

Preserve valid existing security, insufficient-funds checks, financial-integrity controls, and certified maintenance safeguards. Do not introduce blanket automatic player/table/club/union lockouts for drift, billing, or agent-policy violations. Alert management and use the approved operation-level policy. No-lockout does not authorize an unfunded payout, disabling authentication, ignoring a legal restriction, or removing an existing authorized maintenance freeze.

Do not confiscate or claw back a player's settled overpayment caused by a platform defect. Preserve settled history and record specifically authorized corrections through the canonical ledger. No master reset, chip reset, history deletion, retroactive rebilling, or production fixture masquerading as a real customer.

All authoritative game outcomes, debits, entitlements, and payouts are server-owned. A browser animation, local storage flag, successful button click, or optimistic balance is not authority to move money or grant access.

Use durable event-driven execution. Significant obligations must be recorded transactionally and have a named running consumer. Timers are wake signals, not the only record. Do not add cron-based corrective writes, automatic balancing adjustments, autonomous release watchers, or a replacement release system. Read-only reconciliation and discrepancy reporting are allowed through the existing operational path; they must not become a second money writer. Preserve existing owner-approved product schedules; do not delete them merely because they are scheduled.

Preserve approved matte bronze/blue/black Smarter.Poker styling, global header/footer, icons, and routes. Title Case for user-facing labels; no em dashes. Do not turn these assignments into another global visual redesign. New surfaces must work on mobile and desktop without horizontal overflow, inaccessible controls, or unreadable dialogs.

The user's preference is parallel specialist work where available. Use a bounded swarm with explicit file/operation ownership and one integration owner per shared operation. Never claim to have spawned agents when no delegation tool exists. A single agent should perform the same review lanes sequentially if needed. Do not create a global delivery queue.

What Was Actually Done Before This Handoff

This conversation performed public competitor research, created a pricing workbook, inspected repository source, and made targeted read-only database checks. It produced proposals and identified defects. It did not implement the requested features, activate operator billing, create a task PR, apply task migrations, execute paid purchases, deploy a release, or certify live gameplay. Other agents have been changing these repositories concurrently; their work may supersede dated findings. Recover it before editing.

The prior workbook is Poker_Club_And_Union_Competitor_Pricing_2026-09-21.xlsx. It contains 56 fee/requirement entries, 49 currency-package records, ClubGG SKU observations, conditional cost examples, a quote checklist, and 24 sources. It is historical research, not a current price authority. An unchanged copy is included in the handoff ZIP when available. Neither prompt depends on the workbook being present: material rates, limitations, and sources are also recorded in the monetization prompt.

Status vocabulary is mandatory: Observed In Source; Observed In Live Definition At A Stated Time; Historical; Proposed; Implemented; Tested; Merged; Installed; Published; Production-Verified; Unknown. Do not collapse these states.

R2 expands the specification and qualification requirements; it does not mark any phase implemented. Maintain one traceability register linking each P2-F/R2-A finding, contract, test, source change, installed object and acceptance receipt. Do not count document length, a new table name, or a passing text-pattern assertion as a completed purchase lifecycle.

Repository, Environment, And Access Map

Item

Reference / Required Treatment

Primary repository

Smarter-Poker/Smarter-Poker-Club-Arena

Primary main head re-read for R2

a759cf82e3b153f3ad583f0349de8868b444cf6f

Previous source inspection baseline

374ec5cae20380ade08a1e5339b8ae09fe999d8d; retain dated findings, never reset to it

World Hub repository

Smarter-Poker/Smarter-Poker-World-Hub

World Hub main head re-read for this handoff

cee7a6ef6491a52501525ca27b2acd600385a87d

Supabase project

kuklfnapbkmacvwxktbh, name PokerIQ-Production, region us-west-2

Supabase project metadata read during preparation

Reported ACTIVE_HEALTHY; metadata is not a function/body or correctness verification

Production database host identifier

db.kuklfnapbkmacvwxktbh.supabase.co; use configured authenticated tooling, never embed credentials

Public app origin

https://smarter.poker

Club Arena route base

/hub/club-arena/

Known historical Mac World Hub checkout

/Users/smarter.poker/Documents/Smarter-Poker-World-Hub; verify existence and ownership

Known historical Mac Club Arena checkout

/Users/smarter.poker/Documents/Smarter-Poker-Club-Arena; verify rather than assume

Approved new private worktree root on owner's Mac

/Volumes/SmarterWork/agent-work; confirm the volume is mounted, writable, and has available space

Approved evidence/archive root on owner's Mac

/Volumes/SmarterArchives/agent-evidence; use a unique task directory

Cloud execution

Use the actually mounted repository and available tools; /mnt/data from a prior chat is not the user's Mac or an implied production checkout

Vercel project for World Hub

hub-vanguard, project ID prj_op66GkZyZcygXQKm76iyycfVFAQx

The listed SHAs are source inspection baselines, not deployment claims and not instructions to reset main. Fetch current refs at intake, record branch/HEAD/tree, and prove inclusion when a newer protected revision contains your change. Do not overwrite a newer deployment simply to make an old SHA match.

Revision 1 preparation reported SQL execution unavailable. That limitation is historical: R2 discovered execute_sql and performed the bounded read-only checks recorded above. Neither availability state is permanent. Discover the successor's actual actions and use a supported configured route. The R2 reads do not refresh findings outside their named scope or establish deployed frontend/engine behavior.

Desktop Commander earlier reported its monthly allowance exhausted and explicitly said not to retry or reconnect. No later working desktop session was established in this task. Do not claim local files or credentials have been inspected. Use another supported authorized route; do not invent a successful connection.

Required Policy Files And Precedence

Read current versions of:

AGENTS.md, CLAUDE.md, AGENT-PLAYBOOK.md, PUBLISHING.md.

docs/agent-policy/OWNER-POLICY.md.

docs/agent-policy/OPERATING-LAW.md.

docs/agent-policy/HARDENING.md.

docs/agent-policy/REFERENCE-INDEX.md.

docs/standards/EVENT-DRIVEN-EXECUTION.md.

.agent/architecture/deploy-paths.md and applicable nested/path instructions.

The actual existing task checkpoint, applicable financial/product laws, release contracts, and qualification manifests.

On the owner's Mac also read the current shared files under /Users/smarter.poker/Documents: AGENTS.md, AGENT-OPERATING-LAW.md, AGENT-HARDENING-STANDARD.md, and AGENT-REFERENCE-INDEX.md. Their local contents were not read during this preparation. Portable mirrors exist in the repository.

The September 17 owner policy supersedes older restoration-only authority, FIFO/numbered release queues, stop-after-push directions, human-only release labels, and retired local/custom production publishers. Preserve actual technical safeguards and task-specific holds. Do not bring back retired external error-telemetry SDKs or their secrets. Read the current root policy instead of treating an old handoff as release authority.

The policy reader and classifier exist at:

node docs/agent-policy/agent-policy.mjs read
node docs/agent-policy/agent-policy.mjs check
node docs/agent-policy/agent-policy.mjs plan origin/main HEAD

Use the current documented commands and read their output. A generated policy receipt does not prove compliance or application behavior. Store one durable checkpoint per assignment; do not scatter inconsistent status summaries.

Secrets, Safety, And Worktree Discipline

Use connected GitHub/Supabase/Vercel tools first where their actions fit. Otherwise use the configured authenticated CLI on the authorized machine. Check permissions and secret-name metadata without printing values. Relevant existing names mentioned in code/runbooks include SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL or the framework-specific public URL variable, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, REVENUECAT_WEBHOOK_AUTH, VITE_REVENUECAT_IOS_KEY, and VITE_REVENUECAT_ANDROID_KEY. Their presence, values, validity, and necessity must be verified by the owning environment. None is supplied or guaranteed here.

Do not cat an environment file, dump environment values, ask the user to paste a key, copy another task's credentials, or put secrets in logs, source, PRs, screenshots, prompts, or test fixtures. Use canonical secret stores and least-privilege identities. Do not replace a trusted CI reporter with a different identity to manufacture a passing check.

Inspect status and existing PRs before editing. Use an isolated owned worktree/branch and private locked dependencies. Do not reset a shared checkout, prune another agent's branch, write through shared node_modules symlinks, perform broad /tmp cleanup, or delete recent/active work. Preserve all active evidence and the owner's 72-hour recent-work constraint. No production real-chip or real-payment tests to prove a new feature. Use the maintained isolated PostgreSQL runner and disposable accounts/fixtures only through the approved qualification process.

Existing Test Commands And Release Routes

Observed root package scripts include npm run typecheck, npm test -- <affected-test-paths>, npm run build, npm run lint, npm run check:title-case, npm run check:club-entry-budgets, npm run test:db:rake-attribution-atomic, npm run test:e2e, and npm run test:e2e:financial-decisions. Root tests use Vitest; browser tests use Playwright. server/package.json provides npm --prefix server test -- <affected-test-paths> and npm --prefix server run build with its own dependency lock/test configuration. Re-read package files and workflow applicability before using commands. Do not run every script blindly; some scripts require database or production credentials. Scope changes and reuse valid evidence for unchanged inputs.

db:push and types:generate exist, but their existence is not permission to blindly push all migrations or overwrite a maintained type file. Follow migration reservation/qualification/history rules. Use integer minor units/exact numeric arithmetic and the project's canonical writers. Check RLS, privileges, function search paths, service-only helpers, stale-session authorization, and refund/ownership boundaries. A schema-only CREATE TABLE is not an operational feature.

For the new operator code, choose one application/API module and the existing database transactional boundary. The likely client is Club Arena; existing World Hub-hosted Club Operations/store routes remain World Hub source and Vercel deployment where applicable. Resolve the exact integration route from current code, then document it. Do not add a microservice, another cashier, a parallel diamond wallet, an unowned queue, or a poker-engine dependency solely to bill a club.

Changed Component

Approved Delivery And Proof

Club Arena client

Protected squash merge -> .github/workflows/publish-club-arena.yml -> Hetzner static publication. Verify both https://ca-static.smarter.poker/build-info.json and https://smarter.poker/hub/club-arena/build-info.json, publisher run, and affected browser behavior. Do not copy the bundle into World Hub.

Club Arena engine

Existing .github/workflows/stage-engine-release.yml -> .github/workflows/auto-deploy-hetzner.yml; stage immutable artifacts, preserve production-door qualification, certified maintenance activation, sealed receipts, concurrency, rollback budget, and exact selected engine component. Verify https://engine.smarter.poker/health plus actual affected behavior.

World Hub API/client

Protected merge -> existing Vercel Git-source integration in hub-vanguard -> deployment READY. Verify selected Git revision and https://smarter.poker/api/health, then affected behavior. No replacement project or local/prebuilt bypass.

Database

Install only the exact qualified migration through the approved route, then read back function/trigger/privilege/configuration state and migration history. Merged SQL is not installed SQL. Do not edit or replay an already installed migration.

Monitoring, if actually changed

Existing deploy-monitoring.yml and loaded-configuration proof. No unrelated monitoring redesign.

Read post-deploy-e2e.yml: client browser verification and live-table/engine verification are distinct jobs. Use the applicable proof, never silently call an unrelated failed job passing. Client-only delivery and independent World Hub changes do not wait for an hourly engine cutover. Only actual engine replacement or an identified dependency on new engine behavior needs the certified activation window. Prepare, qualify, merge, build, and stage promptly. Do not create a watcher to wait or retry a release. Work on independent authorized steps while jobs run and inspect their recorded result directly.

On failure, distinguish preflight/build failure, unknown owning operation, failed activation, and missing proof. Resume an existing ambiguous operation before creating another. Preserve the known good runtime and current maintenance/rollback contract. Do not ad-hoc restart production mid-hand or extend a freeze to force a result.

1. Recorded Commercial And Accounting State

ID

Recorded Finding

Status / Required Treatment

P2-F01

The owner reports that club/union operation is currently uncharged.

Binding business context. This does not mean every player store item is free. No retroactive operator debt.

P2-F02

Diamond packages are 100/$1, 500/$5, 1,000/$10, 2,500/$25, 5,000/$50, 10,000 base + 500 bonus diamonds/$100, 25,000 base + 1,250 bonus/$250, and 50,000 base + 2,500 bonus/$500.

Live catalog read September 22 at 12:35:58Z. Nominal catalog valuation remains $0.01 per diamond. Do not reprice existing packages here.

P2-F03

ca_bridge_rate.diamonds_per_chip = 100; fn_mint_chips_from_diamonds reads the authoritative rate and routes owner minting through existing diamond/chip paths.

Live rate confirmed September 22. Preserve; do not confuse owner minting with operating charges or player Diamond Spins.

P2-F04

feature_pricing contains club_creation = 100, but reviewed creation did not establish a diamond debit.

September 21/22 observation. Reconcile this exact catalog/path contradiction; do not accidentally charge it during the free trial.

P2-F05

The four-membership preflight and ten-membership creation implementation disagree.

Live definitions read September 22 at 12:33:35Z. Prompt 1 owns the common product policy fix. Commercial roster capacity is not the same as the number of clubs one user may join/own.

P2-F06

User VIP and diamond purchase infrastructure exists; venue-based commander_subscriptions also exists.

Reuse verified components; do not assume Commander venue billing already implements Club Arena club/union commerce. Do not mutate unrelated Commander subscriptions.

P2-F07

No complete new operator purchase/trial/renewal lifecycle was established by the review.

A name search returning no operator objects is a lead, not proof none exists under another name. Trace actual routes/writers before creating tables.

P2-F08

Daily Diamond Spins custody, immutable movements, owner day statements, and net settlement functions exist.

Live definitions inspected September 21; source changelog explains the design. Source qualification did not itself prove production installation or UI acceptance. Re-read actual installed state.

P2-F09

fn_wheel_host(club) resolves to its union when affiliated, otherwise the standalone club. fn_diamond_game_owner(host, kind) resolves the corresponding owner.

September 21 live definition. Affiliated club owners do not automatically receive separate union Spins proceeds. Sponsor authority is required for union-funded club fees.

P2-F10

Spins net settlement can be negative; owner reserves cover existing obligations.

Do not bill against gross entries, estimated earnings, or diamonds reserved to fund prizes/negative custody.

P2-F11

The owner-consent wording described direct owner entry flow while newer accounting uses daily custody/net settlement.

Recheck. Version/reconcile disclosures and acceptances without overwriting prior consents or treating operating authorization as implied Spins consent.

P2-F12

Existing catalog has player features and artwork, VIP/Lifetime rules, and native IAP product naming.

Preserve prices/allowances and current purchase policy unless an explicit scoped correction is required. No compulsory player VIP to operate a club.

P2-F13

Future membership/capacity, report, insurance, and union tariffs were proposals only.

No new task code, migration, checkout, PR, purchase, or production charge was created in this conversation.

| P2-F14 | The installed personal feature function uses personal ownership and eight-hour session access; replay cost is an attempt delta. | R2 definition read at 13:26:09Z. New operator API must not inherit those semantics accidentally. |
| P2-F15 | FIFO allocation and automatic Mint register helpers can catch errors without refusing their caller. | R2 definitions at 13:27:01Z. New commerce must prove its required persisted side effects or roll back its own transaction. No customer-loss measurement was made. |
| P2-F16 | Positive new refund-like types can still enter the multiplier path; positive credits also settle existing diamond debts. | R2 add_diamonds_to_balance read at 13:27:12Z. Exact refunds and clear gross/debt/net statements are mandatory. |
| P2-F17 | Existing service spends retire supply through the journal-linked Mint path; supply_after is observational. | R2 origin/register reads at 13:27:12Z and 13:28:13Z. Reuse the existing treatment without a second economic writer. |
| P2-F18 | Current feature prices, package bonuses and 100-D-per-chip configuration remained as listed during R2. | Configuration read at 13:28:13Z. These are configuration observations, not actual purchase or provider-approval evidence. |

The recorded Spins flow is paid entries and optional game entries -> durable daily custody -> recorded diamond prizes/inventory expenses -> net settlement to the authorized owner. Existing Promo-first/Main Bank chip awards remain distinct. Net spendable diamonds are not the entire operator's economic profit, and reused diamonds are not new cash receipts at every transfer.

2. Existing Source, Database, And API Map

Read the exact current source and follow wrappers and imports. Entries from prior reads are starting references, not a guarantee that signatures have not moved.

Area

Starting References

Club creation and eligibility

src/services/ClubsService.ts; fn_get_club_creation_eligibility, fn_create_club_atomic, fn_create_club_atomic_membership_impl

Existing feature/VIP catalog

src/services/VIPService.ts, src/utils/vipStatus.ts; tables feature_pricing, vip_pricing, vip_subscriptions

IAP product mapping

src/lib/iapProducts.ts; docs/APP-STORE-RUNBOOK.md, docs/APP-STORE-LISTING.md; table iap_products

Diamond accounting documents

docs/DIAMOND-ACCOUNTING-STANDARD.md, docs/DIAMOND-RULINGS.md; latest corrections govern older inverted examples

Rate correction

docs/changelog/2026-09-08-diamond-phase-three.md, docs/changelog/2026-09-07-diamond-wheel.md

Spins settlement description

docs/changelog/2026-09-19-diamond-spins-daily-owner-settlement.md

Spins settlement migrations

supabase/migrations/20260919152614_diamond_spin_daily_net_settlement.sql, 20260919152626_schedule_daily_diamond_spin_settlement.sql

Spins records/functions

diamond_spin_movements, diamond_spin_days; fn_diamond_spin_book, fn_diamond_spin_settle_day, fn_diamond_spin_settle_daily, fn_diamond_spin_statements, fn_diamond_spin_settlement_receipt

Host/consent

fn_wheel_host, fn_diamond_game_owner, fn_diamond_spins_owner_terms, fn_diamond_spins_owner_agreed; diamond_spins_owner_consents

Canonical diamond paths

add_diamonds_to_balance, deduct_diamonds, fn_purchase_feature_v2; trace current grants, wrappers, kind registry, idempotency and supply rules before reuse

| Personal purchase receipts and rights | digital_purchase_receipts, feature_purchases, sp_theme_asset_is_owned; personal purchase semantics are not club/union capacity semantics |
| Purchased-fund allocation | diamond_purchase_lots; fn_ca_consume_purchase_lots(user, amount); new-operation allocation evidence must preserve existing FIFO and arena_reserved |
| Register classification and receipt | fn_ca_diamond_journal_classifier, fn_ca_diamond_journal_origin, fn_ca_register_diamond_journal_row, fn_ca_diamond_register_follows_journal; link through ca_mint_ledger.diamond_tx_id |
| Existing reserve/debt policies | fn_diamond_spin_wallet_reserve, diamond_spin_days, diamond_debts; inspect applicable additional canonical reservation paths rather than subtracting the same hold twice |
| Rule and registration manifests | scripts/ci/schema-manifest.d/diamond-rules.json, scripts/ci/schema-manifest.d/cw-wallet-one-mint-for-diamonds.json; qualify any scoped strict-path extensions and update actual manifests |
| Historical helper behavior references | docs/changelog/2026-09-08-diamond-rules-wired.md, supabase/migrations/20260905041033_one_mint_for_diamonds_the_register_follows_the_diamond_journ.sql; do not edit installed migration files |
| Diamond purchase inventory | diamond_packages, diamond_purchases, diamond_transactions, canonical current balance/lot/reservation ownership; earlier reads used profiles.diamonds but do not assume a column alone defines all availability |
| Mint and bridge | ca_bridge_rate, fn_ca_bridge_rate, fn_mint_chips_from_diamonds, ca_mint_ledger, fn_ca_mint_supply; trace current canonical issuance/retirement contract |
| World Hub store/API references | pages/api/store/create-checkout-session.js, pages/api/store/purchase-vip-with-diamonds.js, pages/api/store/purchase-daily-vip.js, pages/api/store/webhooks/stripe.js, pages/api/store/webhooks/revenuecat route family; resolve current extension/path |
| Card purchase settlement/refunds | settle_diamond_card_purchase_atomic, reconcile_diamond_purchase_refund, claim_stripe_webhook_event, complete_stripe_webhook_event; historical names, current behavior must be traced |
| VIP diamond purchase wrappers | purchase_vip_with_diamonds_atomic, \_v2, \_v3; discover current callers before assuming a legacy version is authoritative |
| Owner views/services | src/services/UnionService.ts, MembershipService.ts, PermissionService.ts, WalletService.ts; src/pages/CashierTradePage.tsx; locate the current club shop/Table Studio/customization and operations pages |
| Spins operations route | Earlier statements link /hub/club-arena/clubs/<club-id>/diamond-games-operations; resolve actual route and permissions |
| Venue subscriptions not to repurpose blindly | commander_subscriptions has venue_id and its own billing fields; not automatically a club/union entitlement model |
| Historical audit only | docs/audits/2026-09-02-diamond-economy/lane2-ramps-bridge-and-standard.md contains old defects later partially corrected; never relaunch those repairs without fresh verification |

Earlier source states that Lifetime VIP covers designated digital gameplay benefits, not automatically club ownership capacity. Existing ordinary VIP allowances include Rabbit Hunts, timebank seconds, emojis, tags and throwables. Recheck live authoritative behavior and prior promises before changing anything. Do not create a new “Platinum” or multi-rung VIP ladder for this assignment.

Helpful tracked-source searches:

rg -n 'club_creation|feature_pricing|fn_purchase_feature_v2|VIP_MONTHLY_ALLOWANCES' src server/src supabase
rg -n 'diamond_spin_settle|diamond_spin_days|fn_wheel_host|fn_diamond_game_owner' src server/src supabase
rg -n 'add_diamonds_to_balance|deduct_diamonds|diamond_transactions|ca_mint_ledger' src server/src supabase
rg -n 'create-checkout-session|purchase-vip-with-diamonds|revenuecat|stripe_webhook' pages/api src supabase
rg -n 'operator|subscription|trial|entitlement|price_version|billing' src server/src supabase pages/api

Run searches only in directories that exist in the relevant owned repository. A subscription match often means realtime subscriptions, not commerce.

3. Candidate Catalog V1: Preserve This Starting Schedule

Every amount is a proposed diamond price. Dollar equivalents are explanatory values at one cent per diamond, not separate dollar checkout products. Effective dates, scope, status, and authority must be explicit. This table must not be promoted silently just because it is copied into a migration.

3.1 Renewable Club Capacity

Capacity

Diamonds / 30 Days

Nominal Dollar Equivalent

Up to 60 approved members

500

$5.00

Up to 100 approved members

700

$7.00

Up to 250 approved members

1,500

$15.00

Up to 500 approved members

2,500

$25.00

Up to 1,000 approved members

4,000

$40.00

Up to 2,500 approved members

7,500

$75.00

Above 2,500

A written diamond quote with validated capacity

No invented unlimited price

Include ordinary administration, roster/role management, existing hierarchy, routine dashboards, supported table/tournament creation, scheduling, and ordinary table operation within the published tested capacity. No additional per-hand, per-table-hour, active-day, per-transfer, or per-Agent toll. Registered roster capacity is not the same as certified concurrent-table/field capacity; publish both accurately.

Count each approved account once within its covered club; role promotion does not create a second counted account. Pending/rejected/archived memberships do not use active roster capacity under the proposed counting policy. Archive rules must not erase debt, funded entries, history, or valid access rights. Do not create a loophole by relabeling real participants as fixtures. Respect current owner rules on horses/bots and memberships; test legitimate special-account behavior rather than guessing exemptions.

Displayed club levels are product/community indicators, not the purchased capacity tier. Keep them separate. Capacity upgrades need an exact incremental quote and remaining-period proration. Example: 700 -> 1,500 diamonds with half the period remaining is 400 additional diamonds. Define whole-diamond rounding once, return the same quote result on retry, and avoid per-suboperation upward rounding. Downgrades apply prospectively; no member deletion or interrupted game.

The 100 -> 250 member jump is a known pricing cliff, not an approved optimum. Support intermediate capacity products or a documented credited upgrade policy in the catalog, but do not invent and auto-activate additional rates. Price/protection verification and accepted owner terms determine final publication.

3.2 Union Back Office

Candidate rate: 1,000 diamonds per affiliated club per 30 days for additional union-management functionality. Examples: 2 clubs = 2,000; 5 = 5,000; 10 = 10,000; 25 = 25,000; 50 = 50,000 diamonds.

This buys actual union-wide oversight, permissions, cross-club coordination, approved settlement-management tools, and consolidated reports. It is not payment to acquire players, credit, or a real-money settlement guarantee. Simple affiliation is not proof a payable product was authorized; define accepted scope and payer at enrollment.

Individual club capacity remains a separate entitlement under the last proposal. The union may sponsor it, but the same capacity purchase cannot be billed to both owners. Union back-office purchase includes covered consolidated reports and their corresponding underlying club reports for the same period. Do not add paid exports again. Recover unused overlapping prepaid entitlements through a documented credit when coverage changes.

Use effective-dated covered-club intervals for joins/leaves; avoid charging a whole new period for a one-day overlap unless the published contract explicitly sells indivisible periods and comparison supports it. Never rewrite old charge attribution after a club changes union.

3.3 Detailed Reports And Operator Tools

Item

Diamonds

Scope / Term

Detailed club export

200

One seven-day reporting interval for one club

Club reporting pack

700

Thirty-day reporting interval, including regenerated exports

Consolidated union reports

Included in paid union back office

Covered clubs and corresponding reporting interval

Club insurance software module

200

One club, thirty days

Union insurance software module

min(200 \* covered_clubs, 1,000)

One union, thirty days; no duplicate club charge for covered functionality

Define report dates explicitly; do not confuse one seven-day data interval with seven days to download arbitrary history. A thirty-day pack covers its full interval, including overlapping weeks and the final partial week, without charging twice. Re-downloads, authorized staff downloads, corrected filters, and regeneration of an already purchased interval are not new purchases.

Core balances, transaction evidence, standard statements, accounting corrections and dispute records remain included in operating access and accessible under the published retention policy after expiry. Sell export packaging/advanced functionality, not access to evidence needed to dispute a charge. If the advertised detailed export is materially identical to an included competitor report, account for that in the complete comparison.

Insurance prices above are candidate software-access prices. They are not insurance premiums, odds, profit share, required reserve, or EV Cashout fees. Those underlying economics stay unchanged. Do not charge for a bug fix or remove existing accepted benefits without a prospective transition.

3.4 Premium Customization

Item

Diamonds

Entitlement

Custom premium club cover/banner

100

One saved customization, scope specified

Premium table background

250

One selected asset

Premium table design/felt

350

One selected asset

Complete coordinated theme

600

One bundle with explicit component IDs

Club-branded card back

250

One club-branded design entitlement

Basic logo, description, contact information and standard branding remain included. Operator-owned club artwork applies to its authorized tables without an extra per-table purchase. Distinguish player-owned versus club-owned versions rather than silently broadening an existing personal entitlement. Preserve existing purchases. Credit eligible owned bundle components when upgrading; never let overlapping component credits exceed the bundle price.

These candidate amounts resemble the existing customization catalog but must be reconciled with actual SKU IDs and ownership semantics. Do not create duplicate storefront SKUs for the same asset or generate replacement artwork as part of billing.

3.5 Existing Player Prices To Preserve And Verify

Recorded live feature rows: Rabbit Hunt 5 diamonds/use; timebank extension 5 per defined extension; throwable 1/use; auto timebank 5/activation; stack display in BB 5/session; offline protection 10/session; emoji pack 1/permanent unlock; tag pack 1/permanent unlock. Preserve actual VIP/Lifetime allowances, definitions, and purchases. A theme_unlock constant is not proof a matching live row exists. Inspect the actual current item IDs rather than applying this list blindly.

These are player products, not automatic extra club-owner bills. Do not require every player to buy VIP for an owner to use capacity they already purchased. Baseline reconnect and funds safety cannot depend on purchasing an optional protection product.

The R2 personal feature read established that per_session currently means eight hours in that function. This observation does not authorize repricing or rewriting player session products; it specifically prohibits using that term for operator renewals. Existing UI/session wording should be checked when touched, and any unrelated mismatch recorded for its owner.

3.6 Explicitly Included Or Out Of Scope

No separate new charge for initial creation/activation during the offer, ordinary invitations/approvals, role assignment, normal transfers, supported ordinary table creation/reopen/extension, ordinary tournament creation, essential account security, accounting corrections, basic records, or an additional platform rake percentage. Initial creation remains included in the applicable operating entitlement after the offer as well; the orphaned legacy 100-diamond row must not become a second activation fee. Included services are funded by the paid diamond entitlement, not a permanent free operating tier.

No new price for Kill/Half-Kill, corrected tournament filters, or other necessary repairs in this launch catalog. Multi-day premium pricing remains unproposed; do not invent a fee to lift an unbuilt-feature guard. Do not monetize an unavailable feature.

Owner chip minting remains at the current authorized conversion, with no added processing surcharge. Trial service-fee waivers do not waive chip issuance principal or prize reserve funding. Do not advertise numerical competitor chip quantities as equivalent without matching denomination and obligations.

4. Competitor Evidence, Price Protection, And Unresolved Rates

4.1 Evidence Register

Separate official verified public tariff, official product listing with missing entitlement mapping, operator-reported rate, historical rate, negotiated customer quote, and unknown. Unknown is not zero. The prior workbook is a research trail; do not treat its title date as checkout verification.

Competitor / Category

Recorded Evidence

Limitation

PokerBROS starter renewal

Reported 1,000-1,300 diamonds per 30 days

Operator guide, not a verified current owner checkout; capacity mapping incomplete

PokerBROS chip inventory

Reported 1,300 diamonds for 520 chips

Do not compare numerical chip counts without denomination/rights

PokerBROS weekly export

Reported less than 300 diamonds

An upper bound cannot establish the lowest competitor cost

PokerBROS other charges

Official FAQ describes diamond-funded chip purchases, levels, insurance, covers and personal items

Exact current insurance/customization prices not publicly established

PPPoker starter capacities

Reported 1,500 diamonds/30 days for 60 members; 2,500 for 100 members

Region/global-app mapping and current tariff need verification

PPPoker larger historical level

A 2024 guide reported 48,000 diamonds/30 days for 1,200 members and 20 managers

Historical, not a current price

X-Poker starter renewal

Reported 1,200 diamonds/30 days

Capacity mapping and rate require verification

X-Poker chips

Reported 100 diamonds per 300 chips

Not automatically comparable to Smarter chip obligations

ClubGG club subscription listings

US Level 1A $19.99; another USD storefront showed Level 2E $49.99, 3E $99.99, 4E $199.99, 5E $399.99, 6E $499.99, 7E $699.99

Do not infer full US period/capacity mapping, or assign old capacities to new A/E SKUs

ClubGG weekly export

Reported 560 diamonds

Operator guide, not current private tariff

ClubGG Union Back Office

Official page displays $5,000/month for up to 50 affiliated clubs; larger plan supports 250+ with price not retrieved

Not proof it is mandatory for every union, cheapest for a small union, or inclusive of every unrelated club purchase

Poker Now

Official Plus $9.99/month or $69.60/year; Platinum $49.99/month or $499/year, ten 100-member clubs and listed reports/tools

Whole-bundle benchmark; match features, capacity, period and commitment

Pokerrrr 2

Official Gold store; industry-reported hosting 6-9 Gold/table-hour

Current host tariff unverified; a low-volume customer's complete cost may be lower than a renewal

Suprema

Official listing describes free basic creation and paid growth features

Detailed tariffs unverified

UPoker

Historical evidence of chips, reports, rename and selected feature charges

Not a verified current complete price list

PokerStars Home Games

Free basic club management with its own product scope

Positive Smarter fees cannot be represented as 20% below a genuinely equivalent free item

Poker Mavens

Published self-hosted Version 7 licenses: 39.95 / 149.95 / 499.95 dollars

One-time software license is not a monthly hosted service; compare real total cost over the same period

Independent unions

One operator advertised PRIME/X-Poker 7%, TOP UNION/PPPoker 7%, EUROPA PARTY/ClubGG 15% of rake

Independent operator offers, not universal vendor fees or necessarily equivalent software-only services

The original ten-platform research included free and self-hosted alternatives for context. It does not authorize introducing a Smarter free tier or copying a real-money service. Likewise, do not assert that no other app offers an earnings/savings perk; that uniqueness claim has not been established.

4.2 Normalize Cost Correctly

For a matched service/configuration over the same interval, let C be the lowest verified comparable cost in dollars, including every unavoidable software charge and accessible discount, and excluding refundable reserves and player liabilities. At Smarter's nominal $0.01:

maximum_smarter_diamonds = floor(0.80 \* C / 0.01).

The internal target may be 25% below for a buffer, but the minimum advertised target is 20%. Compute with exact decimals/rational values, not binary floating point. Match term dates, renewal period, region, storefront, capacity, staff, game/tournament/table limits, reports, required purchases, and support scope.

A 30-day renewal is 720 hours under the proposed fixed-duration contract; a calendar month is not always 30 days. Compare the same service dates. Annual prepaid rates cannot be compared to cancel-anytime periods without explicitly matching the commitment or reporting that difference. Record tax inclusion and currency conversion assumptions; do not invent taxes or pass-through costs to hide a higher tariff.

Retail currency has two measures: consumed diamond value and cash required to buy whole packages. Report them separately. Include legitimate authorized purchase conditions actually available to the compared customer, including official bonus packages and a verifiable customer-specific contracted offer when its eligibility, duration and full required cost are established. Do not assume a private discount or use unauthorized currency resale as the benchmark. Earned diamonds and the first-month waiver are additional customer benefits and must not be counted as the advertised catalog undercut.

Conditional examples from recorded retail packages: 1,200 X-Poker diamonds at 13,000/$99.99 consume approximately $9.23, so 738 Smarter diamonds is the whole-diamond 20%-below ceiling before capacity/term qualification. 1,000 PokerBROS diamonds at 6,468/$99.99 consume approximately $15.46, ceiling 1,236. Reported 560 ClubGG diamonds at 10,000/$99.99 consume $5.59944, ceiling 447. The proposed 500 starter / 200 export figures are below these arithmetic ceilings, not yet certified equivalent offers.

4.3 Entire-Cart Protection

After selecting services, compare the entire required basket, not only attractive individual lines. Ten 100-member clubs at the candidate 700 rate total 7,000 diamonds per 30 days before extras; this needs checking against Poker Now's complete multi-club package. A report marked “included” on a competitor cannot be ignored and billed separately in a purported equivalent comparison.

Apply a documented comparison adjustment to the applicable lines/cart before the customer accepts the quote. Show catalog gross, credits/discounts, comparison adjustment, trial waiver, and final diamond debit. Do not silently remove features, reduce actual capacity, or count an earnings credit as a rate discount. Persist benchmark evidence/version and comparison scope with the quote.

The comparison mechanism is a price ceiling/adjustment on a diamond catalog, not a fixed-dollar subscription and not the rejected table-hour meter. Do not dynamically raise prices when the competitor raises theirs or the owner's earnings improve; published price changes follow the explicit version/notice policy.

4.4 Missing Evidence And Launch Choices

Exact higher levels, insurance tariffs, matched customization rights, complete table allowances, some union contracts, and comparable chip acquisition remain unresolved. Retrieve official/private owner evidence through authorized access or accept a verifiable customer quote with a defined validity period. Never manufacture a tariff or declare “every feature is 20% cheaper” from unknowns.

Implement the complete comparison/evidence workflow. Keep an unvalidated global savings claim disabled. Recover a later owner-approved publication decision when available; otherwise distinguish a proposed price from a verified guarantee. An unresolved SKU or comparator does not justify stopping independent engineering or delivering an empty pricing screen. Record the exact remaining publication decision without presenting it as resolved.

5. Phase 0: Discovery, Actual Authority, And Baseline

0.1 Current Source And Live Inventory

Refresh both repositories and current policies. Recover related branches/PRs/checkpoints, installed migrations, existing catalog and wallet writers, refunds, purchase lots, IAP/Stripe integration, and legitimate lifetime/operator promises. Use read-only metadata/definition queries first. Do not read unrelated personal balances or production customer transactions when schema/caller inspection suffices.

0.2 Establish Finite Scope

Determine which candidate services already exist, their actual current asset/report IDs, required permissions, and readiness. Inherit Prompt 1's technical registry or agree its stable interface. Do not sell multi-day support while the unbuilt guard is still active. Do not mutate Commander venue subscriptions, public Diamond Arena access, unrelated World Hub stores, or other projects.

0.3 Single Commercial Checkpoint

Reuse the existing task checkpoint. If none exists, proposed location: docs/handoffs/club-arena-diamond-commerce/CHECKPOINT.md. Record policy receipt, findings, proposed/approved price authority, catalog version, exact owner/trial terms, source/DB identities, owned operations, tests, PRs, migration state, provider runs, launch cohort, activation status, and outstanding price/evidence decisions. This is newly proposed storage, not a file already created by this conversation.

0.4 Baseline And Access

Run exact-candidate applicable local checks. Verify configured provider access and secret names without values before dependent work. If current tools lack SQL execution, use a supported authorized existing route; do not claim the old tool call is available. Record a true access block and continue independent work. No new arbitrary approval labels or global release holds.

6. Phase 1: Commercial Contracts And Data Ownership

1.1 Product, Price, Capability, And Entitlement Are Different Objects

A technical capability states what the product can do. A product/SKU describes a purchasable package. A price version defines the cost and effective terms. A purchase is the accepted transaction. An entitlement defines scope and duration of access. A wallet transaction records the diamond movement. Do not overload a club level, player VIP flag, or subscription status to represent all six.

Reuse established models where they satisfy the contract. Any names introduced below are conceptual proposed entities, not claims of existing tables or directions to create duplicates:

Product/SKU and immutable price versions, with draft/published/retired status and authorized publisher identity.

Billing scope for a club/union and an explicitly authorized payer, with effective dates and owner/finance roles.

Trial grant and its non-repeatable operator/scope identity.

Durable quote with cart, duration, capacity, role/ownership context, included items, discounts and expiry.

Purchase intent/receipt with stable business key, request hash and canonical debit reference.

Entitlement with start/end, service scope, source purchase or trial, and amendment/revocation history.

Renewal authorization with payer, product scope, period, diamond ceiling and cancellation state.

Sponsorship authorization and budget, with covered clubs and valid intervals.

Refund/credit adjustment linked to its original receipt and delivered entitlement.

Price-comparison evidence with source, country/period/capacity and confidence.

1.2 Permissions And Boundaries

Only an authorized payer may commit its diamonds. Ownership, finance administration, gameplay administration and read-only reporting are distinct permissions. A union admin is not automatically allowed to spend the union owner's personal diamonds. Scope each read and write to actual club/union access; membership alone does not authorize billing. For browser-based mutations, preserve the application's session, same-origin/CSRF and request-integrity controls. Rate-limit hostile repeated quote or purchase attempts without dropping idempotent recovery of an already accepted operation. For native requests, use the existing verified account/session mechanism rather than client-supplied ownership claims.

Require server-side current ownership/role/session checks for sensitive actions. Do not trust editable metadata, a client price, a supplied owner ID, or stale UI permission. Delegation changes and ownership transfer must not redirect old receipts or spend a former owner's wallet. Financial helpers remain private/service-only where required, with RLS and exact grants reviewed.

A PostgreSQL SECURITY DEFINER wrapper alone does not satisfy the existing self-payer check inside deduct_diamonds, which checks the request's authentication context. Do not spoof auth.uid(), weaken the global self-payer guard, or put a service key in a browser to make sponsorship work. Choose a supported existing trusted-server route that verifies the signed-in actor and effective payer mandate, then invokes a narrowly authorized commerce function, or an equivalently proven end-user/RPC design. Record the actual trust boundary and caller; do not assume any proposed wrapper is service-authorized because it compiles.

An authenticated owner may read their own original payment receipt after losing club management access, without retaining the club's private operating data. Billing authorization, receipt ownership, and permission to inspect gameplay reports are three separate checks. Revoking any delegation invalidates future uncommitted spending by that delegate; it does not erase already committed obligations.

1.3 Money And Supply Model

R2 establishes the baseline representation rather than leaving a choice between an invented treasury and a burn. In the installed definitions inspected, an ordinary operator-style service debit through deduct_diamonds is a spend journal entry whose classification names revenue:<source>. The journal-following register records its Mint retirement. A correctly classified positive service refund follows the existing reversal/issuance registration. Revalidate these bodies and their triggers at intake, then use this canonical treatment.

The revenue: label is an accounting classification, not an automatically funded wallet. Do not create a second credit to the platform, call a separate burn after the journal has already registered one, or book the same consumption as a transfer and a retirement. A future economic redesign needs a separate explicit contract; it is not an implementation choice hidden in this task.

Use whole diamonds, exact numeric arithmetic and the canonical wallet. A trial waiver has zero debit and no Mint movement. A sponsor payment uses the authorized sponsor's balance for the recipient scope and has one fee debit. A mere operating earmark changes availability, not supply. Actual transfers between supported canonical holders remain supply-neutral. Do not count mirrors, reserved quantities already moved to custody, or internal observations as additional balances.

Purchased-lot provenance and Mint registration are required postconditions of a new paid commerce operation. The R2 read found that fn_ca_consume_purchase_lots and the register-following trigger can swallow failures. Calling a helper is therefore not itself proof of complete accounting. Add the smallest compatible strict boundary for these new commerce operations: lock according to the existing conflict graph, retain operation-linked before/after lot allocation evidence, verify the intended journal and exact linked Mint entry, and throw on an unproved required result so the new debit, purchase, entitlement and outbox roll back together. Do not consume lots twice, register a second burn, or globally flip existing gameplay rule modes.

A helper's reported v_consumed is not enough if its exception block rolled back the writes it counted. Required evidence is the persisted affected-lot deltas under the serialized operation. A valid mixture of purchased and promotional funds may consume fewer purchased lots than total diamonds; calculate that expected split from eligible locked provenance, not from an assumption that all diamonds are purchased. Frozen, refunded and already reserved amounts are not unallocated promotional money by default. Reuse the actual canonical availability contract.

For registration, verify the indexed row associated with this diamond_transactions.id, including asset, action, amount and operation identity. A registration helper can return a no-op when the row already exists; compare the row, not just the boolean. Missing or conflicting evidence fails this new transaction. Do not add a full supply SUM or an economy-wide advisory lock to each purchase. supply_after is observational under concurrency; supply reconciliation uses a consistent accounting snapshot and the canonical movement totals outside the payment critical path.

The database transaction's rejection does not cancel prior gameplay or lock a club. Report the failure after rollback through the existing application diagnostics/notification path, without holding a financial transaction open for external delivery. An incident inserted inside a rolled-back transaction is not durable evidence of the failure by itself.

A new credit type must be registered across exact-value/multiplier rules, journal classification, Mint origin, debt policy, purchase lots, budget rules and reports before use. In the read add_diamonds_to_balance body, a made-up operator_refund name could be classified as a refund while still receiving a VIP multiplier. Use the approved exact-value refund door/type or a proven compatible exact mapping. Test multiplier-bearing accounts explicitly. A refund is not a reward and must not earn a reward multiplier.

Keep diamond quantity accounting separate from cash/provider accounting and revenue recognition. Cash sale proceeds, net provider receipts, consumption and operator-license service delivery are different events. Capture the relevant facts for finance; do not encode a universal GAAP/IFRS recognition rule from an old audit paragraph. The nominal one-cent price is not necessarily net cash proceeds per diamond or a cash-redemption entitlement.

Required New-Operation Accounting Identities

New fee purchase: spendable wallet debit equals the accepted final diamond amount; journal shows the same debit; required Mint retirement has that amount; the entitlement and purchase receipt refer to that same operation.

Trial or already-covered zero-cost access: actual debit and supply change both equal zero. Do not feed zero to a positive-only debit function.

Service refund: credited gross amount equals the authorized unreturned part of the original net debit, excluding waivers and already-returned value. Any existing debt offset is a separately linked movement; net spendable increase may be lower.

Sponsor coverage: service recipient and actual payer differ only under an effective authorization. The recipient is not debited again for the same right.

Sum of refundable line allocations cannot exceed the original net debit. An independently authorized goodwill award is a different funded operation, never disguised as a refund.

1.4 Feature Failure Policy

A failed authorization, rejected quote, insufficient available balance, duplicate inconsistent payload, or unavailable service must not debit or claim success. For asynchronous delivery, commit an explicit paid/pending obligation and durable fulfillment owner; on permanent failure, reverse through a linked idempotent refund. Never say a report is delivered solely because its charge committed.

Distinguish an expected business refusal from an exception after side effects. Returning JSON such as success:false after a successful debit does not automatically undo earlier SQL in the surrounding transaction. Structure the atomic function or explicit subtransaction so every failed mandatory postcondition rolls back the new operation. Map the failure to readable client copy only after transactional safety is established.

A paid external export job may legitimately be pending. Its accepted job record, scope, cancellation/refund rules and outbox must already be durable. A worker starting does not mean delivery succeeded; an external notification failure does not authorize a fresh charge.

1.5 Concrete Objects And Uniqueness Contracts

Reuse existing receipt/entitlement tables where their semantics fit; otherwise extend the same module and database with the smallest necessary scoped records. Record an architecture decision mapping these logical entities to the actual installed objects, constraints, server callers and client consumers. Do not copy this table into a second disconnected implementation.

Logical Record

Required Identity And Invariant

Published price

Product plus immutable version, integer diamond amount, explicit term/capacity and effective interval; accepted prices are never edited in place.

Quote

Unique quote ID, actor, payer, recipient scope, basket hash, exact versions/coverage, expiry, and a one-time consumption link to purchase.

Purchase intent

Unique actor/request key plus canonical request hash. A retry is the same intent, not a new chance to debit.

Purchase receipt

One committed purchase per consumed quote; original net total and per-line allocation persist even when retry response charges zero.

Entitlement

Scope, capability/product, service/data interval, capacity or asset, source purchase/trial, revision and effective state. Define which overlapping rights can coexist and which are duplicates.

Renewal

Mandate plus original entitlement and exact due-period identity; a different request key cannot renew the same period twice.

Asset right

Unique authorized beneficiary/asset/license combination. Trial use and permanent purchased ownership are distinct sources, not duplicate permanent grants.

Sponsorship

Mandate, scope set, authorized payer, effective interval, revision and budget. Outstanding reservations and committed charges cannot exceed the budget.

Refund

Original receipt/line plus durable adjustment ID; cumulative returns and replacements remain bounded and explained.

Fulfillment

Purchase line plus job identity and generation; only the current generation can publish a result, cancellation or failure refund.

Use database constraints for uniqueness, referential integrity and valid amounts, plus appropriate locking/version checks for predicates such as current coverage. A cache or prior SELECT is not a concurrency invariant. Draft, expired and revoked rights may legitimately overlap as history; constraints must prevent duplicate effective purchases without deleting those records. Exact interval exclusion or another proven serialized design should be scoped to the correct product and coverage dimension.

1.6 Separate State Machines And Shared Contract Version

Track quote (open, consumed, expired, withdrawn), purchase (committed with delivery status), entitlement (scheduled, active, expired, revoked), renewal mandate (authorized, cancelled, needs_attention), and fulfillment (pending, processing, delivered, failed, cancelled) as separate logical dimensions. Map names to current conventions; these labels are a proposed contract, not instructions to add arbitrary enums independently in each layer. A committed purchase with pending delivery is not a failed debit; a cancelled future renewal does not cancel current access.

Prompt 1 owns technical capability and accepted-event semantics. This workstream owns the commerce-to-capability mapping, coverage and renewal authority. Publish a small versioned shared interface, with exact symbols/paths resolved at intake, containing capability ID, supported scope, readiness, entitlement query, admission decision, accepted-event identity and continuation decision. Do not introduce a second global feature-flag service or require every product enhancement to finish before this interface can serve existing capabilities.

1.7 Numerical And Input Boundaries

Validate positive whole diamond costs, maximum quantities, legal period lengths, roster caps, asset IDs and supported currency on the server. Persist wider intermediate arithmetic as appropriate, but do not send values beyond the canonical wallet's actual supported range. Current positive-credit and reserve code uses a 2,147,483,647 ceiling, including incoming settlement headroom. Test near-boundary values without funding real wallets.

Reject manipulated negative quantities, fractional diamonds, duplicate cart lines that expand rights twice, invalid dates, excessively large carts and client-chosen internal transaction kinds. Display formats can abbreviate a dashboard; an accepted price confirmation and receipt must show the full exact amount.

7. Phase 2: Full Thirty-Day Operator Trial

2.1 Activation And Duration

Recommended precise contract: the operator affirmatively activates a verified club/union operating scope; record trial_start in UTC and trial_end = trial_start + 30 \* 24 hours. Display exact local expiry in America/Chicago or the user's selected IANA zone. Market it as 30 days, not an undefined calendar month. Existing operators receive a prospective migration cohort start no earlier than the disclosed launch/acceptance event. Time previously spent on the free platform never becomes debt.

No card is required for this waiver and no cash subscription is created. Record eligibility and accepted terms once. Do not start the clock while the owner merely prepares an account unless the activation contract says so clearly.

2.2 Waive Operating Services, Preserve The Economy

All operating software features included in the offer are usable without operator service debits during the trial, subject only to published supported technical capacity and ordinary security. Capacity, union tools, detailed reports, insurance-software access and included premium customization use receive a zero-net fee waiver. Do not hide a required operating screen behind a player VIP or diamond purchase.

Record normal catalog price, waiver reason/version, zero actual debit, service result, and entitlement. A trial waiver is not a diamond Mint event or cash revenue. Do not issue transferable diamonds to simulate free access. Temporary trial art rights must be labeled, not silently converted into permanent giveaways. Previously owned assets retain their rights.

Paid player Spins entry rules, new chip issuance principal, jackpot/insurance funding, and prize obligations remain unchanged. The phrase “everything free” in operator marketing must state this operating-software scope clearly rather than imply unlimited funded gambling or free cash-equivalent prizes.

2.3 First Purchase And Transition

Show the post-trial diamond price and services before expiry. Reminders around day 21/day 27 are proposed product reminders, subject to current notification preferences and dedupe; implement through an owned durable process, not a release watcher.

The first paid entitlement begins no earlier than the trial end. No retroactive debit. The operator must accept the price/payer/renewal authorization; a prior trial acceptance is not unlimited permission to spend. New operator products must not auto-enroll on launch without that authority.

At expiry, preserve already accepted cash hands/tournaments, withdrawals, settlement, and records. Admission to new discretionary paid operation requires a valid entitlement, funds, or an explicitly approved finite credit policy. This is not a blanket account/club/table lockout or permanent free operating tier. Do not trap funds or abruptly terminate a session to collect a software fee.

2.4 Abuse, Ownership, And Union Coverage

A rename, transfer, delete/recreate maneuver, or union hop does not automatically grant a second trial for the same operation. Use minimal existing account/ownership/operation evidence; shared IP alone does not prove abuse. Do not collect passports or new sensitive documents by default. Provide a review path for a genuinely new independent operator.

A union trial covers its defined union service and authorized affiliated operating scopes without double charging. A new club's legitimate first-month benefit must be explicitly reconciled with existing union coverage. Preserve operator identity and entitlement history through transfers; do not hide an earlier owner's accrued liability on a new owner.

2.5 Trial Identity, Rights, And End-Date Integrity

Define the trial's operator identity and included scopes explicitly at enrollment. Recommended implementation default: one initial operating trial for the actual operator organization, with its enrolled club/union scopes listed and a common end time. This is a proposed anti-repeat policy, not a claim the owner mandated a particular identity model. Preserve any more specific current owner promise, including a legitimate new independent operator's full first month. A database UUID, shared IP or renamed club alone cannot settle that distinction.

A late-in-trial feature selection inherits the original end time. Selecting a thirty-day module on day 29 must not grant another thirty free days; a union adding a scope must not reset its original trial either. Conversely, a genuinely new operator must not lose their valid first-month benefit merely because another payer sponsored a related club. Persist the decision, policy version, reason and covered scopes so support can resolve the case without manual balance edits.

Temporary artwork may be used during the full offer but creates no permanent paid purchase or refundable principal. At expiry, preserve owned artwork and use an already-approved fallback for temporary unpurchased designs at a safe presentation boundary; do not hide cards, interrupt a hand, or delete the owner's custom source files. A trial-generated report covering an authorized historical interval can remain accessible under its disclosed retention and data-permission policy without granting unlimited future report generation.

The 30-day service term is a fixed 720-hour interval stored in UTC. A report covering seven named local dates is a different interval and can span a daylight-saving transition. Name both concepts accurately. Use half-open intervals [start, end) consistently, and compare against one authoritative server time for each decision. Never expire the underlying purchased diamond balance because the trial or service expired.

2.6 Trial Tests

Before/at/after boundary, DST, existing cohort, activation retry, same operation recreated, legitimate unrelated owner on shared network, union join/leave, ownership transfer, permanent asset purchased during trial, cancellation before conversion, delayed reminder, and an overnight tournament spanning expiry. Test simulated clocks in isolation; do not wait 30 real days or change the production clock to certify this path.

8. Phase 3: Authoritative Quotes, Checkout, And Exactly-Once Charging

3.1 Quote

Server computes current supported products, catalog version, scope, period, capacity, existing overlapping rights, bundle credits, union coverage, valid comparator adjustment, and trial waiver. Persist a short configurable quote lifetime and rule/context hash. The browser sends intent and selection, never authoritative amount.

Display amount in diamonds with optional nominal dollar reference, term dates, what is included, payer, refund/cancellation terms, and renewal choices. An expired quote or changed material ownership/capacity must be requoted without a surprise higher debit. Preserve an accepted locked quote under its documented validity policy.

Price Calculation And Allocation Order

Resolve actual pre-existing rights and scope before constructing the payable basket. Remove genuinely included lines; apply eligible owned-component/unused-term credits; apply valid commercial discounts; apply the verified whole-basket comparison ceiling; then apply an eligible operator trial waiver to the covered operating lines. Persist each step, the reason and evidence version. A sponsor is a payer, not a price discount. Earned diamonds are funding, not another subtraction from the invoice.

Specify a deterministic whole-diamond allocation of any basket-level reduction across lines, such as proportional allocation with a stable largest-remainder tie-break. Total line allocations must equal the accepted total exactly. Persist those allocations for refunds and upgrades. No line may become negative and no stacking path may turn a service waiver into transferable value. A partly owned bundle must not count a trial license as a paid component credit.

A current, valid quote may retain its accepted price version for its published validity interval. A security revocation, ownership change, unsupported capability or material coverage conflict may invalidate it; a harmless roster change within the same purchased capacity should not cause endless quote churn. Define the material context hash narrowly. A new catalog price must never silently replace the amount on an accepted purchase.

3.2 Atomic Purchase

The accepted purchase uses a stable idempotency key and immutable request hash. Validate session/role/payer, quote state, scope and availability; serialize against the authoritative wallet and conflicting entitlement operation using the project's lock order; check available balance after all existing holds; then commit the canonical debit, exact supply treatment, purchase receipt, entitlement and required durable notification/fulfillment record together.

A database transaction must not wait for an external payment/report/email provider while holding financial locks. A notification transport failure is not permission for the browser to attempt another charge. Reuse the existing outbox and consumer pattern.

Three Independent Duplicate Barriers

Protect all three layers: request identity, quote consumption, and business entitlement identity. Request-key protection alone does not stop a customer from submitting the same quote with a new key, or two servers from renewing the same scope/period with different keys. Serialize/uniquely link quote consumption to one purchase and prevent duplicate effective scope/period or asset grants using the object contracts above.

Choose a lock order compatible with every existing wallet, custody, lot and sponsorship writer that can race this flow. Document the conflict graph rather than prescribing a conflicting new global order. Use fine-grained payer/scope/mandate locks, deterministic ordering for multiple supported payers, bounded lock time and indexed lookups. Do not lock every club or the entire diamond register for one purchase. On deadlock or serialization failure, retry the entire transaction with the same business identity and a bounded retry policy; never retry only the debit or invent a new receipt key.

Inside the serialized transaction, recheck current actor/mandate, quote material context, coverage and available funds. Capture the expected canonical lot allocation, execute the single debit, prove actual lot deltas and the exact journal-linked register row, insert/amend rights and the purchase receipt, and persist required follow-up. Where existing triggers perform these steps, verify them rather than duplicating their writes. A failure after debit but before any mandatory proof must roll the complete new operation back.

3.3 Retry And Unknown Outcome

Same key/same payload returns the original receipt and entitlement. Same key/different payload refuses. A network timeout is ambiguous: recover the original intent/receipt before sending any new purchase. Multiple tabs, double taps, two servers, app/web overlap and retries after restart must not debit twice. Protect purchase identity with actual database uniqueness, not only a client-disabled button.

The response contract must separate original_total_diamonds, charged_this_attempt, purchase_id, delivery_status, entitlement_status, is_replay and the timestamp/version of any balance shown. A successful replay of an earlier 700-diamond purchase means original total 700 and attempt debit 0; it does not mean the purchase was free. Normalize existing helpers that return duplicate_reference as a recoverable existing result only after matching the original payload and receipt.

For receipt recovery, authenticate the requester and authorize access to the original receipt before returning it. A consumed quote that is now expired, a later catalog retirement or a revoked current club role must not make a previously committed purchase disappear. Return the original authorized receipt with the present entitlement state, without regranting revoked rights or performing a new charge. Fresh quote validity and present scope authorization apply to an uncommitted purchase, not to pretending an already committed payment never happened.

The receipt is immutable transaction evidence; a current wallet balance is a separate authorized read and may have changed since the purchase. Recovering a receipt after ownership transfer must not grant the former owner fresh data access or permission to spend again. Unknown network outcomes remain pending until read or resolved by the same identity.

3.4 Availability And Failed Delivery

An unsupported capability, expired permission, insufficient funds, invalid report interval or missing asset fails before debit. For an export/render job that must complete later, show paid/pending and track a durable delivery obligation. A permanent failure produces a linked refund exactly once; a retry cannot create both a refund and a duplicate successful paid job without an explicit re-purchase.

Use a generation/fencing token for each asynchronous fulfillment attempt. Publish the output only if the job is still current and the entitlement permits delivery. A completion racing a permanent-failure refund must choose one valid terminal result transactionally. Retrying a cancelled/refunded job cannot silently restore the paid entitlement. External transports are at-least-once where applicable; achieve one committed local effect and deduplicated delivery, not a fictional guarantee that the internet sends every message exactly once.

Exit: actual funds and actual scoped access move together with a recoverable receipt. A mock wallet animation or inserted order row alone fails acceptance.

9. Phase 4: Renewals, Upgrades, Downgrades, And Lifecycle Continuity

4.1 Diamond Renewal Authorization

Auto-renewal is optional and explicitly accepted in diamonds, with a product/scope, period, maximum charge, payer, next deadline, and cancellation control. A new catalog version cannot silently exceed accepted authorization. Material price increases require prospective notice and the required customer acceptance; keep previously accepted periods unchanged.

The canonical business period and quote dates define recurrence. Do not add a cash subscription in Stripe or an automatic card top-up behind the scenes. Existing diamond purchase rails remain separate voluntary purchases. Low diamond balance is not permission to bill a credit card.

4.2 Durable Due-Date Owner

Use the existing server-owned durable execution pattern. A renewal obligation persists with its entitlement/version and expected state. A named running consumer owns due work, rehydrates on startup, and processes with bounded concurrency and backoff. Do not add a recurring cron repair, browser timer authority, or an autonomous agent to charge accounts.

At the deadline, revalidate authorization, price version, payer, current coverage, cancellation, and available funds. Serialize the renewal and extension so duplicate events cannot extend twice or charge twice. A failed or cancelled renewal stays a visible nonpaid/attention state; do not report it as active paid access.

Delayed Renewals And Restart Recovery

Never infer an unlimited backbilling mandate from an old renewal timestamp. After an outage or lapse, do not loop through every missed period, charge each, and give the owner expired access. The mandate must specify its actual authorized period and any finite lateness treatment. Recommended default for a material lapse: mark attention required and obtain acceptance of a new prospective interval, instead of accumulating historical software debt.

For a short delayed execution within an explicitly accepted continuity policy, record the original due period, actual debit time, retained service coverage and why that one delayed charge is permitted. The next deadline must derive from the accepted contract, not from the number of queue retries. Cancellation or mandate revocation before a new charge wins unless that exact purchase already committed; in the latter case show the receipt and applicable refund policy. Never charge merely because a top-up arrived after the mandate was cancelled.

A due-work notification can wake the existing service; it is not the durable obligation. An in-memory timeout, an unowned queue, or a promise to execute after a serverless HTTP response is not sufficient. The actual consumer, its restart path, leases, attempt/version checks and failed-work visibility must be wired and tested. Reuse existing process ownership rather than creating a new billing daemon or scheduler by default.

4.3 Insufficient Funds Without Destructive Lockouts

Notify the correct owner/authorized sponsor with the amount, deadline, current obligations and safe options. Preserve withdrawals, records, already accepted events and settlement. Prospective optional purchases/admission follow the valid funded entitlement or separately approved bounded credit policy. Do not mint diamonds, make customer balances negative merely to collect a software fee, raid prizes, or add undeclared fees.

No-lockout does not mean unlimited unfunded new operation forever. Publish the distinction between continued fulfillment of existing obligations and admission of new paid operation. Implement whatever finite grace/credit terms are actually approved; do not create a hidden permanent free tier or an automatic debt contract.

Accepted-Event Continuation Is Not An Unlimited Table License

Use Prompt 1's authoritative accepted-event identity and frozen published rules, not a boolean on a permanent table template. A parent multi-day event accepted with valid access retains its committed stages, qualified players and required completion/refund paths. Legitimate registration within that event's already published window follows the accepted contract; new unrelated events or a later expansion of the commercial scope are new admissions.

Cash-game continuity follows the existing session/hand admission contract and safe boundaries. Do not cut a hand, disconnect players, trap cash-out, or misuse an indefinitely open table as authorization for unlimited future paid operation. Resolve the exact prospective-action boundary in the shared contract and test it. An operator fee check must never sit in the betting-action/payout critical path. No new anti-drift or billing lockout is authorized by this distinction.

4.4 Prorated Upgrades

Quote the unused-time difference or another explicitly published credit formula using exact period boundaries and integer rounding. Lock the old entitlement and quote; charge once and atomically replace/amend capacity. Do not cancel all existing access while awaiting an upgrade. Credit component entitlements already owned to avoid duplicate coverage. Reused rounding residues and repeated upgrades cannot exploit free unlimited capacity or create extra charges.

Compute remaining value from the relevant actual net paid rights and their remaining coverage, not an undiscounted list price when the original buyer received a bundle or comparison reduction. Preserve source line allocation and any prior credit/refund. Quote the complete replacement or incremental right clearly so the owner never pays twice for time already purchased.

Persist exact rational time/value calculations and a deterministic whole-diamond rounding rule. Track the cumulative amendment basis so splitting an upgrade into many tiny steps cannot repeatedly obtain free capacity from rounding or create more refund value than was paid. Test direct upgrade versus equivalent staged upgrades, discounted original access, midperiod union coverage, and boundary timestamps. No new intermediate rate becomes live without a valid catalog version.

4.5 Downgrade, Pause, And Cancellation

Cancellation disables future renewal, not the paid current period. Downgrades apply at the next effective boundary and show unresolved roster/hosting needs before acceptance. Never delete excess members or cancel live tournaments to fit a smaller tier. An inactive operation may retain records without receiving a permanent free operating product.

Define a fair, versioned treatment for unused sponsored/overlapping rights and service failures. Do not invent a universal refund promise; implement the actual displayed policy and any applicable mandatory rights. Chargeable periods, delivered content, discounts and provenance must reconcile with the original receipt.

4.6 Trial Boundary Clarification

All operator-service charges remain zero within the trial. An authorization for post-trial renewal can be recorded early, but the service debit must not occur before its paid period begins. An unrelated personal asset purchase may still follow its existing personal-store contract; do not relabel required owner features as personal to bypass the waiver. Existing permanent purchases remain intact.

10. Phase 5: Union Coverage, Sponsorship, And Earned Diamonds

5.1 Who Earns And Who Pays

Read the actual host/owner settlement logic. Union-hosted Diamond Spins settle to the union owner; standalone activity settles to the standalone owner under the recorded implementation. A club owner inside a union cannot spend those proceeds by implication. Sponsorship is an explicit authorization to pay for the club, not a reassignment of all economic rights.

Record service recipient, payer, authorization actor, earned-fund source attribution if used, scope, period and original purchase. Ownership changes after a purchase do not rewrite who paid or the original settlement recipient.

5.2 Sponsorship Contract

Support union payment of its back office, selected affiliated club capacity, reporting/tool rights not already included, and expressly selected assets. Include per-club and total diamond limits, effective start/end, revocation for future purchases, and whether a club may authorize its own remainder. A sponsor cannot be silently enrolled because it has a large balance.

The same entitlement is paid once. When a standalone paid club joins a covering union, detect overlapping remaining entitlement and apply the specified credit to the responsible original payer/purchase. On departure, preserve already paid access according to the agreement and quote future access prospectively. Do not charge a full period twice.

Purchased Coverage Quantity And Affiliation Are Different

Preserve the candidate price of 1,000 diamonds per covered affiliated club per thirty days, but sell a disclosed coverage quantity and interval. Adding an affiliation row does not itself authorize spending more of an owner's diamonds. Assign named clubs to the purchased coverage under current eligibility. Increasing purchased quantity requires a quote/authorization; replacing a covered club must end the old assignment before the new one takes effect and cannot create simultaneous extra coverage.

An active union back-office entitlement includes the stated report rights, not individual club roster capacity by implication. If a club joins a union that bought only back office, its standalone capacity purchase is not a duplicate and must not automatically be refunded. Credit only genuinely overlapping paid rights, with the actual original payer and net amount. Temporary trial coverage and permanent asset ownership are separate dimensions.

Enforce the sponsor's total and per-club budget against committed charges plus any valid outstanding reservations under a shared serialized budget check. Two club admins cannot both spend the same final 1,000 diamonds of sponsor authorization. Quote creation alone should not reserve funds indefinitely; use short, explicit holds only when actually required and authorized, with durable expiry/release ownership.

Recommended first-release scope is one authorized payer per purchase. A sponsor can buy a club's whole entitlement or separate nonoverlapping lines/periods. Do not silently charge the club owner's remainder when the sponsor lacks funds. True split-payer checkout is an optional extension only if required by the accepted product, and then requires both mandates, sorted compatible wallet locking, exact line allocation, one atomic purchase, and payer-specific refunds. Do not implement split payment through two independent best-effort debits.

Revocation prevents future uncommitted sponsor spending; it does not revoke a club's already paid rights automatically. A refund returns to the entitled original payer, not whoever currently owns the club. Whether a refund releases a period budget is an explicit mandate rule; it must not automatically trigger another purchase or restore revoked authority.

5.3 Apply Available Settled Earnings

The perk can be presented as “Settled Earnings Can Help Cover Operating Purchases.” Owners pay from their existing canonical spendable balance under authorization. The actual accounting still consumes eligible purchased lots FIFO before promotional balance under the recorded rule. Do not promise an earned-first debit, change that priority, or label an untraceable receipt as paid exclusively from Spins.

A cost-coverage dashboard may compare qualifying settled earnings with operating costs, clearly marked as an explanation of potential out-of-pocket offset. Where exact source attribution is not present, show the comparison without inventing lot provenance. Earnings already spent or reserved elsewhere cannot be counted again as presently available funding. Actual paid amount is not reduced a second time by the displayed coverage benefit.

Pending positive custody is informational. Negative pending obligations, applicable frozen funds and other canonical holds affect availability under their established rules; do not subtract a holding twice if it has already left the wallet. Positive-credit settlement of existing diamond debts also affects the amount that becomes spendable. Preserve those contracts rather than borrowing from them to make fee coverage appear complete.

Implement optional operating earmarks only if the canonical wallet/reservation model supports them. One diamond cannot simultaneously back a prize, an operating reservation, and a personal purchase. Use one consistent lock order and release/reserve protocol. Do not create a second parallel wallet that disagrees with the Mint supply ledger.

5.4 Preserve Spins And Chip Obligations

Do not change wheel odds, entry choices, Double Down rules, reward costs, owner consent, Promo-first chip payments, main-bank funding, Mint issuance, daily settlement schedule, or negative backing in order to improve fee coverage. Operator support is funded by existing available earnings or voluntary diamond purchases, not by forcing additional player participation.

Update agreement language only to accurately disclose existing custody timing and the separately accepted fee authorization. Version new consent; preserve original accepted text, version, owner and time. A former consent cannot be rewritten to manufacture permission to deduct operating fees.

5.5 Coverage Readout

Show gross selected operating prices, valid discounts, waived trial charges, net actual paid charges, available balance, and any additional diamonds required for an accepted new purchase. Separately show a clearly labeled settled-earnings cost-coverage comparison or genuinely evidenced source allocation. Do not present a comparison as an accounting debit priority or subtract it twice. Pending earnings, existing debt offsets and obligation reserves need distinct labels. Do not claim total business profit from a single-currency statement.

Example carried from the proposal: a 100-member club with capacity 700 + report pack 700 + insurance module 200 totals 1,600 diamonds per selected 30-day period. A cover 100 and felt 350 add 450 as separate asset purchases. If 900 diamonds are actually available in the canonical wallet for that purchase, another 700 available diamonds are needed. A separate comparison showing 900 diamonds of settled earnings covering part of the cost is not a claim that FIFO consumed those earnings first. These are illustrative amounts, not the user's current account totals or an earnings forecast.

11. Phase 6: Reports, Assets, And Fulfillment

6.1 Detailed Export Purchases

Reuse existing report generation and permissions. Quote exact data period and included fields. Capture the authoritative reporting watermark/version so regenerated exports explain subsequent legitimate corrections without rewriting ledger history. Large exports use existing bounded jobs with progress and a durable result identity.

A successful report entitlement allows currently authorized staff to retrieve the purchased interval without a new debit. Recheck both paid/trial coverage and data authorization at generation and retrieval. A former payer can retain their payment receipt without retaining the club's private report data.

A previously issued bearer signed URL may remain usable until its expiry; do not promise instantaneous revocation merely because the application removed a role. Where immediate revocation is required, use the existing authenticated retrieval/proxy design or another proven revocable mechanism. Otherwise use a short disclosed expiry and non-public storage. Files already downloaded cannot be remotely withdrawn by changing a permission row. Do not claim otherwise.

A union's payment does not grant access to a club's pre-affiliation history or to unrelated private club/Agent/player details. Apply the effective data-visibility contract separately from the commercial coverage interval, including after affiliation or ownership changes. Retained historical access for a former union must be explicitly authorized, not assumed.

Report Interval And Delivery Contract

Persist exact [data_start, data_end) boundaries, the selected IANA report time zone, report schema/version and source watermark. Seven named local reporting dates can be 167, 168 or 169 hours across daylight-saving changes; that is not an incorrect 720-hour operator-license term. A corrected report can advance its source watermark without rewriting the original underlying financial records.

Purchased-period coverage is interval-based, not a price on a button. The selected seven-day and thirty-day products must avoid charging again for an already covered period and correctly handle a final partial week. A report query cannot extend its paid coverage just by changing client parameters. An overlapping union reporting entitlement may reduce a quote only where it actually conveys the same authorized report scope.

Treat generation as a bounded, paginated snapshot job. Record row-count/control totals and whether the snapshot is complete. An empty valid report is different from a failed query or truncated export. A late success after cancellation/refund must not publish under a retired job generation.

Sanitize exported user-controlled strings against spreadsheet formula injection when producing CSV/XLSX, preserve exact numeric units, and prevent arbitrary external URLs from becoming server-side fetch instructions in a custom export. Only add security controls relevant to the actual existing report/upload mechanism, not a new unrelated import product.

6.2 Asset Entitlements

Map catalog products to actual assets and actual consumers. A successfully paid asset must be usable on the advertised club/player scope and survive reload, another device, ownership transfer under its terms, and future software deployment. No broken file path, unsupported format, or unimplemented renderer may be sold as fulfilled.

Preserve current artwork, personal purchases and Lifetime/VIP benefits. Do not duplicate an entitlement merely because a club and a player can view the same design. Model the scope explicitly. Bundle credits must reference actual component purchases and cannot be replayed for repeated discounts.

Record a stable asset/license ID and its supported content version or integrity reference. Existing club-owned rights follow the club under their terms; personal artwork does not automatically become a transferable club asset. Refund, trial expiry or content retirement should select a lawful owned/default fallback at a safe UI boundary without corrupting the table state. A repaired asset file should not force a second purchase.

When crediting a bundle, use only eligible actual paid component value for the same beneficiary/license, less previous returns or credits. No credit for temporary trial access, an asset owned by a different person, or a component already credited into another bundle. Preserve a deterministic credit allocation and enforce it atomically with the new entitlement.

6.3 Insurance Access

Gate only the prospective software module/configuration under its accepted commercial terms. Existing insurance offers and accepted liabilities continue through settlement after a term ends. Never debit a player's diamond wallet for a club module renewal, silently increase insurance premium/edge, or let a software-access failure erase an accepted payout obligation. Do not conflate EV Cashout and insurance entitlements without an explicit product definition.

6.4 Refunds And Adjustments

An operator-service refund returns the authorized part of the original net diamond debit through a canonical reverse operation. It is not a refund of a diamond-pack card purchase, a chip conversion, a player prize, or a new reward. Persist the original receipt/line, payer, original allocation, approved refundable amount, reason, request identity, returned rights and exact-value transaction kind. Never call a provider fiat refund merely because an owner returned a report or software license.

Full/partial returns, credits for genuine overlap, failed delivery and any original diamond-pack reversal must be reconciled without duplicate recovery or duplicate reimbursement. A trial waiver has no paid principal to refund. Ordinary service refunds plus already applied value credits are bounded by the original line's permitted remaining return; independently authorized compensation is a separate funded reason, not an inflation of that return.

A positive refund through the recorded canonical credit path can settle valid existing diamond_debts before increasing the visible spendable balance. Report gross returned diamonds, debt settlement where applicable, and net wallet increase separately. Do not bypass that policy by manually editing the wallet; do not tell the owner the gross amount became available when some settled an existing debt.

Refunds must bypass earn multipliers and be classified/registered as exact reversals. Test users with VIP multipliers and every relevant transaction-kind rule. The word \_refund in a new string is not proof of exactness. Recover duplicate-reference results by matching the original refund receipt rather than creating another key.

For each new commerce debit, retain sufficient operation-linked purchase-lot allocation to restore the appropriate remaining provenance on reversal. Coordinate with the actual canonical lot/refund and provider-reversal rules. Do not decrement consumed lots based on a guessed historical FIFO reconstruction, restore a frozen/refunded original acquisition as freely spendable, or count one reversal twice. If the original source was transferred/earned and its historical provenance is not represented, use the existing authorized treatment and report the limitation; do not invent a purchased-cash claim.

The refund, required lot change, exact canonical journal/register proof, relevant entitlement amendment and notification/fulfillment change commit or roll back together. A refund cannot credit the new club owner when a different original payer supplied the diamonds. Account deletion must preserve a durable payee/receipt obligation through the approved retention/tombstone process rather than cascading financial history away.

A maximum-balance or positive incoming-settlement headroom limit must not silently discard an owed refund. Preserve a visible, durable pending refund obligation and use the existing authorized resolution path. Do not exceed the canonical numeric range, invent a second wallet, or convert the refund to cash without authority.

Only the returned purchase's rights are amended. Other overlapping paid rights remain valid. A refund racing successful asynchronous delivery or another partial refund must serialize by original purchase/line and choose a valid outcome with cumulative amounts checked. Cancellation of a future renewal is not a refund of current access.

Preserve existing legitimate provider chargeback and debt treatment. No direct profiles.diamonds write, manual balancing adjustment, reward multiplier, erasure of old receipts, or restoration of already settled player overpayments is authorized by this service-refund work.

12. Phase 7: Operator UI And Commercial Administration

7.1 Placement And Visual Preservation

Use existing club/union administration and wallet/marketplace navigation. Proposed owner surface name: “Club And Union Diamond Costs” or the established equivalent. Do not add a second cashier or global header redesign. Follow approved matte bronze/blue/black styling, Title Case, readable amounts, and mobile-safe dialogs.

7.2 Owner Experience

The interface must show current scope/payer, trial expiry, active paid entitlements and capacities, next renewal and authorization ceiling, available/reserved/pending diamonds, selected services, price/version, included items, comparison adjustment when verified, and receipts. The purchase confirmation must distinguish one-time assets from time-limited capacity and reporting intervals.

Owners can inspect costs before enabling a feature, cancel future renewal, request/receive the actual refund-policy treatment, adjust sponsorship, and locate their records. Never show a green success state before the authoritative receipt. On timeout, show recovery of the existing purchase instead of offering another blind charge.

7.3 Authorized Price Management

Create/reuse an internal authorized catalog editor with draft -> validated -> published -> retired versions, effective dates, supported capabilities, proof of the publisher's authority, scope/currency/term checks, and audit history. Prices already accepted cannot mutate in place. This is normal product administration, not an extra human-only GitHub release gate.

Use current owner-approved values when known. Mark candidate defaults and unresolved benchmark claims honestly. No background competitor scraper is authorized to change prices or charge accounts. Comparison review can be an on-demand operational process using recorded evidence; do not create autonomous agents/watchers to maintain it.

Price Publication And Buying Permission

Record separate decisions for catalog publication, a verified comparative marketing claim, and customer authorization to pay. A published candidate price requires the assignment's actual commercial authority and validated unit/terms; it does not need a newly invented release label. A customer charge additionally requires their mandate. A 20%-cheaper badge additionally requires a current matched comparator. Passing any one of these is not proof of the other two.

Do not silently turn unknown comparison data into a zero price or disable every unrelated SKU. Keep unresolved rates or scope-specific provider constraints explicit. Where exact capacity/report/asset rights are not yet known, finish the common checkout and keep only that unsupported offering unavailable until its terms are established.

7.4 Accessibility And Truthfulness

Test the actual interfaces at 320, 375, 390, 430, 768, 1024, 1440 and applicable wider/landscape sizes. Include keyboard navigation, focus management, long club names, currencies/large balances, zero balance, trial state, pending settlement, insufficient funds, sponsorship changes, quote expiry, and completed/refunded purchases. Do not imply a free cash prize, guaranteed profit, universal cheapest price, or certification that has not been verified.

7.5 Performance, Cache Safety, And Operating Visibility

Extend existing modules and indexes rather than adding a distributed billing architecture without need. Index the actual receipt key, quote consumption, effective scope/period, payer/sponsor budget, original refund line, and due-job state/time. Scope uniqueness by tenant/beneficiary where appropriate. Review query plans on representative isolated data; no full-history scan, global supply aggregation, or cross-tenant lock should be added to every quote/debit.

Cache catalog and entitlement read projections only with explicit versions and tenant keys. Billing mutations always revalidate authority and material current state on the server. A cached paid badge is not permanent access and a stale negative cache must not hide a just-purchased entitlement indefinitely. Publish committed revisions and use bounded catch-up on reload, account switch, rejoin and relevant events. Avoid one price or entitlement read per poker action or every open table.

Measure payment success/ambiguity, duplicate-suppressed attempts, pending fulfillment age, due-renewal lag, refund age, sponsorship utilization and accounting postcondition failures using first-party observability. Keep actual net paid diamonds separate from retries, waivers, proposed quotes and refunds. Exclude controlled fixtures from commercial adoption/revenue metrics without removing their financial qualification evidence.

Read-only checks can compare new commerce receipts to canonical journals, required Mint rows, lots and effective rights at a coherent snapshot/watermark. They produce discrepancies and evidence, not automatic money-moving corrections. Do not treat a momentarily inconsistent multi-query snapshot as proven drift or add a corrective cron. Global historical finance repairs stay with their existing owner.

Store bounded PII-minimized operational evidence with retention and redaction. Do not put wallets, auth tokens, signed download URLs or private report contents into public client logs or benchmark examples. Financial/authorization history needs approved durable retention, not casual cleanup of old request keys that reopens replay attacks.

7.6 Explicit, Testable Owner Copy

Use copy that describes actual state: “700 Diamonds For 30 Days”, “Original Charge: 700 Diamonds; Charged On This Retry: 0”, “Trial Ends [Exact Local Date/Time]”, “Renewal Not Completed”, “Report Paid, Preparing Download”, and “Refund: 200 Diamonds; Applied To Existing Debt: 50; Added To Available Balance: 150”. These are examples, not a requirement to introduce unrelated UI labels.

Avoid “unlimited” without a validated operating envelope, “permanent” for a temporary trial asset, “free club” for an earnings-covered paid license, “profit” for only net diamonds, and “20% cheaper everywhere” without qualified evidence. The nominal dollar equivalent must not look like a separate cash subscription or a redemption offer. Keep currently supported languages and accessibility patterns; do not turn billing into a brand redesign.

13. Phase 8: Security, Economic, And Failure Qualification

Test ID

Required Scenario And Result

D01

Trial activation replay returns one grant; no duplicate trial or diamond issuance.

D02

Every included operator SKU has zero actual debit before trial expiry, including direct API requests.

D03

Post-trial first purchase charges exactly the accepted amount and creates one correct scoped entitlement.

D04

Double-click, two tabs, app/web, two servers and lost response all recover the original purchase.

D05

Same idempotency key with altered item, period, amount, payer or scope refuses.

D06

Unconsumed stale/expired quote, catalog update, capability withdrawal and changed role/owner cause no surprise debit. Authorized recovery of a previously committed purchase still returns its original receipt without regranting rights.

D07

Insufficient available balance after existing reserves fails the new purchase without disturbing prize obligations.

D08

Race between a spin prize/negative settlement hold and an operating purchase respects one wallet lock/reservation contract.

D09

Renewal authorization, cancellation, boundary, restart and duplicate wake charge/extend once or not at all.

D10

Price increase above accepted renewal ceiling does not auto-charge.

D11

Upgrade proration, repeated upgrade, rounding, downgrade and overlap credit reconcile to original periods/receipts.

D12

Union sponsors covered clubs once; unrelated clubs cannot use its budget; join/leave and ownership transfer preserve attribution.

D13

Included union reports do not produce additional club-report charges.

D14

Re-downloading a purchased interval or asset creates no new debit; revoked staff lose future authorized download access.

D15

Paid asynchronous export failure is visible and produces the permitted linked refund exactly once.

D16

Bundle discounts cannot be replayed or exceed price; asset ownership survives supported devices/reloads.

D17

Full/partial refund, provider reversal and credit do not mint excess diamonds or revoke unrelated rights.

D18

Original buyer, service scope, catalog version, benchmark evidence and amount are immutable/auditable.

D19

Direct helper access, client-price spoofing, guessed UUID, stale session, edited user metadata and cross-tenant reads are rejected.

D20

Wallet/supply/journal conservation holds for purchase, waiver, refund, sponsor payment, held funds and settlement.

D21

A trial/renewal ending during a cash hand, an insurance offer, a tournament or an overnight stage does not strand accepted obligations.

D22

New unpaid discretionary operations are handled by the published funding/admission policy without blanket lockouts or a hidden permanent free tier.

D23

Personal VIP/Lifetime, existing player prices, diamond purchases, chip conversion, rake, BBJ and agent distributions do not regress.

D24

Every user-visible price matches the authoritative quote; feature absence is not reported as a successful purchase.

D25

Equivalent basket comparison includes bundled features, dates, authorized discounts, whole-pack cash requirement and evidence status.

D26

Unknown comparator/zero-priced service does not produce a fabricated 20%-cheaper badge.

D27

Trial reminders, receipts and failure notices are queued durably and deduped; provider acknowledgment is not claimed as device delivery.

D28

Old client/new DB and new client/old engine compatibility is safe; billing failure cannot control the next poker action.

D29

Legacy 100-diamond club-creation row cannot create an accidental hidden fee; preflight/mutation eligibility matches the resolved product rule.

D30

Current package bonus diamonds do not change nominal catalog valuation, duplicate revenue recognition, or supply reconciliation.

D31

Submit the same quote with different request keys in parallel. One purchase consumes the quote; all valid recoveries name that same purchase and cannot double grant.

D32

Submit different quotes for the same renewal period or permanent asset concurrently. The business-identity/coverage invariant prevents duplicate payment or overlapping duplicate ownership.

D33

Force lot-write failure in an isolated database after the helper has counted a partial allocation. Strict commerce postconditions detect missing actual writes and roll back debit, rights, receipt and follow-up.

D34

Force the register-follow trigger to catch an insertion failure. The new commerce transaction detects the missing required linked Mint row and rolls back, without adding a second burn or globally changing rule modes.

D35

Existing correctly linked registration is replayed. The verifier accepts the exact matching row, rejects a conflicting row, and does not interpret a helper's no-op boolean as proof of failure or success by itself.

D36

Refund to users with multipliers of 1 and greater than 1. Gross refunded diamonds equal the authorized original amount exactly; new transaction-kind mapping cannot turn a refund into a boosted reward.

D37

Mixed purchased/promotional/earned balances follow existing eligible FIFO. Cost-coverage UI does not change allocation order, double subtract earned coverage, or invent attribution to particular spins.

D38

Refund with pre-existing legitimate diamond debt. Statement shows gross refund, separate debt settlement and actual net wallet increase; no manual policy bypass or lost value.

D39

Service refund races a reversal of its funding diamond acquisition. Original source/remaining value is linked; no double reimbursement, duplicated collection or restored invalid purchased principal.

D40

Same original line receives simultaneous partial refunds. Cumulative returns/credits stay within its net refundable paid allocation and each entitlement adjustment is correct.

D41

A billing refund name ending \_refund is not in the exact-value path. Qualification fails until all multiplier, classification, origin, budget, lot and debt semantics are correct.

D42

Sponsor attempts a debit through an end-user context, a spoofed owner ID or a merely SECURITY DEFINER wrapper. No mandate bypass; the actual supported trusted route authorizes and spends only the correct payer's funds.

D43

Two clubs concurrently spend the remaining sponsor budget. Committed charges plus valid reservations never exceed total or per-club authorization.

D44

Sponsor is revoked, lacks funds or leaves the union before commit. No fallback debit to an unconsenting club owner, and no transfer of the old payer's obligations to a new owner.

D45

Joining a union with back office only does not refund unrelated standalone capacity. Only genuinely overlapping covered paid rights receive the agreed original-payer credit.

D46

Add, replace or remove a covered union club midperiod. Affiliation alone never debits; covered quantity/interval and assignment history stay within the accepted purchase.

D47

Select a thirty-day module or add trial coverage near trial end. The original trial end remains unchanged; no repeat or extended free term and no clipped legitimate independent-operator offer.

D48

Trial artwork expires while a player is at a table. Temporary rights do not become permanent paid ownership; a safe fallback preserves gameplay, existing purchases and owner source assets.

D49

Renewal worker resumes after multiple missed periods. It does not charge all expired periods or create unaccepted historic debt; the accepted finite lateness/new-period contract is followed.

D50

Cancellation races a due renewal or a late wallet top-up. Only a purchase already committed under valid authority can stand; cancellation disables later spending and does not terminate the paid current period.

D51

Clock boundaries cross daylight saving. Fixed 720-hour service access and local-date report intervals keep their distinct exact meanings; no gap, double charge or premature trial ending.

D52

A permanent table/template or distant empty tournament is presented as accepted gameplay. It cannot create unlimited post-expiry access; genuine existing funded participant/stage obligations retain continuity.

D53

A qualified multi-day final resumes after operator expiry, including legitimate already-published registration rules. Completion is preserved; expanding to new unrelated events still needs valid prospective authorization.

D54

Upgrade from a discounted/comparison-adjusted original right, directly and in several steps. Net paid remaining value, cumulative rounding and returned credits remain exact and cannot generate free unlimited capacity.

D55

Basket discount, comparison adjustment, overlap credit and trial waiver combine. Deterministic line allocation sums to the accepted total, never goes negative, and produces correct partial-refund limits.

D56

A trial-owned, differently owned or previously credited asset is offered as bundle credit. It is rejected or credited only to the actual permitted remaining paid value and beneficiary.

D57

Acquire overlapping seven-day, thirty-day and union report coverage in different orders. Queries cannot extend rights outside the paid interval; repeated covered output does not charge again.

D58

New union sponsor requests pre-affiliation or unrelated club data. Financial coverage does not bypass event-time and current data-visibility controls.

D59

Role revocation after a report URL was issued. Test the actual proxy/revocation mechanism or bounded signed-URL expiry; never claim already downloaded copies can be recalled.

D60

Export jobs contain hostile spreadsheet-leading strings, very long names, invalid ranges or incomplete pages. Output is safe, bounded and accurately labeled complete/failed rather than silently truncated.

D61

Successful export generation races cancellation/refund and an old worker retry. Only the current generation can finalize delivery; a refunded job cannot resurrect paid access.

D62

Reinstall, Restore, device switch and different-account login encounter the same diamond-pack transaction. No duplicate consumable grant; eligible rights and canonical balance recover only to the verified account.

D63

Operator license expires while the account still owns purchased diamonds. Currency remains subject to its valid existing terms and is not expired or confiscated with the service.

D64

Wallet is near its maximum with positive pending Spins settlement. New credit/refund respects incoming headroom and preserves an owed refund as a visible recoverable obligation when immediate credit is impossible.

D65

Frozen/refunded/arena-reserved lot quantities exist. New commerce does not treat unavailable provenance as promotional funds or consume one holding twice.

D66

Benign within-tier roster changes occur between quote and commit. Material context validation remains correct without endless requotes; genuine owner/coverage/capability changes invalidate safely.

D67

Old client/new catalog or stale feature endpoint tries to purchase operator capacity as a personal eight-hour feature. Original semantics are preserved or unsupported purchase refused without surprise debit.

D68

Receipt replay returns an attempt cost of zero and an old balance snapshot. UI retains original price, displays no new charge, and reads any current balance separately.

D69

Deadlock, serialization failure or process loss occurs around the atomic transaction. Whole-operation bounded retry uses the same business identity; no isolated debit retry or new key.

D70

Unrelated owners purchase concurrently. Fine-grained locks and indexed lookups preserve concurrency; no new global Mint/supply lock or full-history per-checkout scan.

D71

A reconciliation reader races active journal changes. It uses a coherent snapshot/watermark and correct currency/reserve identity, reports evidence, and performs no corrective write.

D72

An email/push/report provider stalls or sends duplicate/out-of-order responses. Financial commit does not wait on it; durable owned follow-up remains deduplicated and its actual delivery state is visible.

D73

Serverless request exits, worker lease expires or a second worker takes over. Durable renewal/fulfillment obligations retain a real consumer and old generations cannot publish stale results.

D74

Catalog editor attempts to mutate an accepted price or publish an unverified universal-savings badge. Immutable accepted terms and separate catalog/customer/marketing authority are enforced.

D75

Legal owner deletion/transfer occurs with paid rights or an owed refund. Receipts and payee identity survive through the approved retention path; no cascade erases obligations or gives a new owner another payer's refund.

D76

Quote/debit inputs exceed supported integer, period, quantity or cart bounds. Validation refuses safely and no overflow or fractional-diamond rounding creates value.

D77

Controlled fixtures, zero-waiver receipts and repeated attempts appear in metrics. They do not inflate actual paid customers, cash revenue or collected diamond totals.

D78

Rollback disables new purchases while fulfillment/refunds are pending. Delivered paid rights and accepted gameplay remain; durable completion/refund consumers retain their obligations.

D79

Restore-shaped recovery brings back older jobs/request state. Stable identities and canonical receipt/source evidence prevent repeated debit, refund, sponsorship reservation or external acquisition grant.

D80

Final installed-path acceptance maps each offered SKU to its current quote, payer, term, charge/waiver, rights, data visibility, test and release evidence. Unavailable offerings and unresolved claims are not labeled complete.

Use isolated real PostgreSQL transactions and two-connection races, not just mocked database calls or string searches. Exercise crash windows before/after debit, entitlement, journal, outbox and fulfillment state. Verify actual constraints and privileges. Do not stress-test customer balances or make production purchases solely to obtain test evidence.

14. Phase 9: Economic And Distribution Readiness

Measure actual infrastructure, storage, report generation, payment acquisition costs, support and trial consumption against the candidate tariff. Distinguish cash received for diamond purchases from subsequent transfer and consumption of already issued diamonds. A source-of-funds dashboard is not a financial statement, a statement of legally redeemable value, or a guarantee of profitability. Do not infer cash revenue or liability recognition from the name of a journal class; preserve service-period, source acquisition, refund and actual provider facts for the authorized finance policy. Do not label every circulation step as new revenue.

Model typical and high-load configurations, roster-to-concurrency ratios, union coverage, report usage, package bonuses, support incidents, trial costs and comparison adjustments. No invented per-table certification, margin, conversion rate or customer revenue. If required cost and competitive ceiling conflict, document the tradeoff rather than introduce hidden fees, change odds, or raid game funds.

Verify the actual platform's distribution/payment eligibility and published terms before enabling newly monetized functionality. Existing Stripe/RevenueCat code does not prove provider approval of the business. Review current official Apple/Google/payment rules for the actual product; do not disguise gambling-related functionality as generic software to evade them. Do not introduce a new payment processor or paid external service unless actually authorized. Do not present a jurisdictional legal conclusion from the name “diamonds” or “play credits.”

Track scope-specific readiness. A missing external approval or unavailable evidence should block only the affected activation, not all independent engineering. Never fabricate a legal/RNG/security certificate or a passing provider approval.

Storefront And Channel Acceptance Matrix

Record the supported web/native channels, countries/storefronts and actual payment-provider approvals relevant to selling and spending these diamonds. Verify current official rules instead of treating an older runbook as present legal or store authority. Do not assume an operator-facing product is automatically exempt as enterprise software, that every region uses the same external-purchase rules, or that changing a product name changes its regulated activity.

Apple's current guidance says purchased in-app currency may not expire. Keep that distinct from the expiry of a thirty-day service bought with it. Current platform rules also govern how paid digital access is obtained and presented. Do not add an automatic cash subscription or unsupported external-purchase link while implementing diamond renewals. Use the existing supported diamond acquisition flow for that channel.

Restore/account recovery uses the canonical verified purchase and account ledger. A previously consumed diamond-pack store transaction cannot grant another pack merely because the customer reinstalls, presses Restore, switches devices, or signs into another app account. Restore eligible durable rights under their actual platform rules; rehydrate consumable balances from the authenticated server record. Verify real provider transaction identity, environment (test/live), account binding, refunds and duplicate/out-of-order events. A client success callback is not a settled diamond purchase.

This assignment may repair a directly blocking account-linking or acquisition integration defect, but it does not authorize a new processor or broader account migration without actual scope. Provider failure affects the relevant new acquisition or charge; it must not erase already accepted game obligations.

15. Phase 10: Migration, Rollout, And Actual Charging

10.1 Qualify And Install

Reserve new migration IDs through the current repo mechanism. Add compatible tables/functions/indexes/policies only after inventory. Reuse canonical writers and constraints. Test clean installation plus upgrade-shaped fixtures with historical purchases, VIP/Lifetime, existing operators, pending Spins custody and sponsorship changes. Do not edit installed migrations or rely on a merged file as proof of installation.

Read back exact installed definitions, grants, trigger states, unique indexes and catalog versions after applying through the approved route. Preserve live data and recover ambiguous operations by identity. No broad backfill that charges old operators or rewrites history.

Maintain expand/validate/enable compatibility: install compatible contracts first, qualify and read back them, deploy the correct readers/writers, then activate only the matching catalog/capability version. No old client can buy an eight-hour personal feature that now pretends to mean a thirty-day club license. If a legacy entry point remains callable, it must retain its original semantics or safely refuse the unsupported new operation.

Backfill existing paid rights only from proven source receipts with a stable migration key; do not turn old free configuration or a stored list price into a historical sale. Trial-cohort grants must be prospective and replay-safe. Preserve source lineage, preexisting permanent assets and older consumer compatibility. Rollback does not delete the evidence needed to explain purchases made before it.

10.2 Rollout States

Use explicit system readiness and catalog publication states. Shadow quotes/non-billable validation are a temporary verification stage, not the final product and not a permanent free model. After qualification, publish the authorized catalog and activate the prospective trial cohort through a recorded effective event. Deploy working purchase/renewal paths with all eligibility and consent enforcement.

At initial launch all eligible operators may correctly incur zero operator charges because their trial has just started. That is correct activation, not proof paid collection is already occurring. Prove post-trial charging with isolated simulated-time tests and observe real receipts only as genuine authorized customer activity happens. Do not wait 30 days to finish engineering or fake live revenue to claim completion.

Publish a channel/scope activation matrix that distinguishes catalog visible, quote available, trial enrolled, paid checkout enabled for eligible consenting operators, renewal consumer running, and genuine live paid activity observed. Early real operators may correctly all be in their free month. This is not permission to enable mock-only charging or to fabricate a receipt. Product acceptance must include installed-path wiring and isolated real transaction proof; the absence of real customer purchases is stated separately.

10.3 Release

Follow the shared release map: Club Arena client static publisher, World Hub Vercel only for its changed API code, exact database installation, and engine route only for actual engine changes. Most operator UI/catalog work should not require a poker-engine restart; a financial check does not itself make it an engine activation. Preserve all required tests and accepted-event dependencies.

Record PR, tested head, protected merge, installed migration/catalog version, publisher/provider run, actual selected runtime/build identity and affected behavior. Never copy a client bundle into World Hub or create a parallel billing publisher. Do not treat a successful page screenshot as a proof of exact-once diamond charging.

10.4 Safe Recovery

The rollback plan must distinguish disabling new purchases/renewals from revoking already delivered paid entitlements. Do not erase orders, refunds or liabilities. Pending valid fulfillment and refunds continue through their durable owners. Preserve existing gameplay and accepted-event continuation. A failed release uses the existing recovery route; do not restart the healthy engine to repair a billing page.

A database restore or failover can resurrect older pending jobs and client retry requests. Preserve stable business IDs and a documented recovery boundary so replay cannot produce a second debit, refund or sponsorship reservation. Qualify restore-shaped recovery in isolation, including reconciliation against actual canonical records and any relevant external provider identity. Do not assume a green health endpoint proves these interrupted operations resolved.

16. Phase 11: Required Final Evidence And Acceptance

Deliver:

Exact catalog/SKU/term/capacity list with proposed/published status and authority, included products, and price evidence.

Commercial state diagram and real source/function/table/permission map.

Trial/renewal/upgrade/sponsorship/refund policies and tests, including accepted-event continuity.

Canonical diamond and supply reconciliation proof for all new transaction kinds, with no chip/rake/BBJ drift.

All D01-D80 applicable test evidence, raw commands/results, exact revisions and controlled fixtures; every omitted case needs a specific scope justification, never a blanket skip.

Screenshots and functional proof of owner/union checkout, trial expiry, cost statements, sponsorship, export/asset fulfillment, and error recovery.

Migration/privilege/catalog installation readback, PR/merge/build/provider identities and actual live release evidence.

Competitor comparison worksheet/evidence register with matched periods, scope, currencies, rates, unknowns and corrections. Do not replace the original research workbook with unmarked invented data.

A list of actual unresolved decisions, external approvals or access constraints, with the exact impacted item and next action.

Final status explicitly separating built, tested, installed, published, trial activated, paid path qualified, and actual live paid receipts observed.

The R2 strict-boundary evidence: measured operation-linked lot deltas, exact Mint rows, exact-value refund/debt treatment, and rejection tests for caught helper failures. Record any directly blocking canonical fix and its narrow scope.

A compatibility and recovery matrix covering personal feature consumers, storefront/account restore, original payer rights, lapsed renewals, accepted-event continuation and restore-shaped duplicate prevention.

Completion means the working diamond commerce and trial system is delivered through real authoritative paths, does not charge twice, preserves existing economy/game obligations, and advertises only what is established. Do not stop at a catalog migration, a disabled UI, an unresolved generic checkout stub, “pushed,” or “ready for another agent.”

Appendix A: Read-Only Intake Queries

Use only a currently available authorized SQL route. Confirm the schema first. These queries inspect definitions/configuration, not customer spending, and never invoke a gameplay or purchase function. Function bodies can contain legacy sensitive literals: redact before retaining evidence. Do not dump environment values or customer payment details.

Connector result behavior matters. During R2, a call containing multiple SELECT statements returned only the last result. Use one composite SELECT per transaction as below, or separate calls. Record an observation timestamp and the actual returned coverage; never claim earlier SELECT outputs were read when the tool omitted them.

A.1 Definitions And Installed Trigger Metadata

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT jsonb_build_object(
'observed_at_utc', now(),
'definitions', (
SELECT jsonb_agg(jsonb_build_object(
'name', p.proname,
'identity_arguments', pg_get_function_identity_arguments(p.oid),
'definition', pg_get_functiondef(p.oid)
) ORDER BY p.proname, p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f'
AND p.proname IN (
'fn_get_club_creation_eligibility',
'fn_create_club_atomic_membership_impl',
'fn_purchase_feature_v2', 'deduct_diamonds',
'add_diamonds_to_balance', 'fn_ca_consume_purchase_lots',
'fn_ca_register_diamond_journal_row',
'fn_ca_diamond_register_follows_journal',
'fn_ca_diamond_journal_origin',
'fn_diamond_spin_wallet_reserve'
)
),
'triggers', (
SELECT jsonb_agg(jsonb_build_object(
'table', c.relname, 'trigger', t.tgname,
'enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid)
) ORDER BY c.relname, t.tgname)
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
AND (c.relname = 'diamond_transactions'
OR (c.relname = 'profiles' AND t.tgname ~\* '(diamond|spin|mint)'))
)
) AS definition_review;
COMMIT;

Split the named functions into bounded batches if the tool truncates the result. The existence or body of a function does not prove its callers, grants, installed application integration or all affected accounting modes; inspect those separately. SECURITY DEFINER requires particular authorization/grant/search-path review, not automatic permission to expose it.

A.2 Public Product Configuration

Run only after confirming these tables/columns exist in the current schema:

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT jsonb_build_object(
'observed_at_utc', now(),
'features', (
SELECT jsonb_agg(jsonb_build_object(
'feature', feature, 'diamonds', diamond_cost, 'usage_type', usage_type
) ORDER BY feature)
FROM public.feature_pricing
WHERE feature IN (
'club_creation', 'rabbit_hunt', 'time_bank_seconds', 'throwable',
'show_stack_bb', 'offline_protection', 'auto_time_bank',
'emoji_pack', 'tag_pack'
)
),
'packages', (
SELECT jsonb_agg(jsonb_build_object(
'package', package_key, 'diamonds', diamonds,
'bonus_diamonds', bonus_diamonds,
'price_usd', price_usd, 'active', active
) ORDER BY price_usd, package_key)
FROM public.diamond_packages
),
'bridge_rates', (
SELECT jsonb_agg(diamonds_per_chip) FROM public.ca_bridge_rate
)
) AS product_configuration_review;
COMMIT;

No result or no matching name is not proof a feature is absent; trace wrappers, renamed objects, current source callers and migration history. Do not query unrelated customer balances or write a fixture into production to fill an evidence gap. The original dated readings remain historical, even when their values match a fresh read.

Appendix B: Research And Internal References

Internal R2 source roots (not deployment proofs):

https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/tree/a759cf82e3b153f3ad583f0349de8868b444cf6f

Previous Club Arena evidence baseline: 374ec5cae20380ade08a1e5339b8ae09fe999d8d

https://github.com/Smarter-Poker/Smarter-Poker-World-Hub/tree/cee7a6ef6491a52501525ca27b2acd600385a87d

Use the source map and current policies in these repos. The archived September 2 diamond audit is not the current state; later price, Mint, native purchase and settlement work exists. Current function readbacks are required.

R2 live-definition evidence: September 22, 2026, 13:26:09Z (personal purchase/debit and creation eligibility), 13:26:51Z (enabled journal/profile triggers), 13:27:01Z (lot consumption, register trigger and Spin reserve), 13:27:12Z (canonical credit and Mint registration), 13:28:13Z (origin classification, package/feature configuration and lot columns). Read-only introspection only; no exercised purchase, fault injection or deployed UI certification. The accompanying SOURCE_EVIDENCE_REGISTER.json records the exact covered objects and limitations.

Public evidence sources, reverify before a price claim:

Official PokerBROS FAQ: https://pokerbros.net/en/faq.

PokerBROS US packages: https://apps.apple.com/us/app/pokerbros-your-poker-app/id1463376042.

X-Poker US packages: https://apps.apple.com/us/app/x-poker-holdem-omaha-ofc/id1534470447 (the competitor product name is not permission to add OFC).

PPPoker-USA packages: https://apps.apple.com/us/app/pppoker-usa-holdem-omaha/id1554633611; regional caveat applies.

ClubGG US products: https://apps.apple.com/us/app/clubgg-poker/id1529839330.

ClubGG club levels: https://help.clubgg.com/article/Payment-Management---Club-Level---FAQ.

ClubGG report currency help: https://help.clubgg.com/article/Club-Administration---Diamonds.

ClubGG official union product: https://www.clubgg.com/unions, re-read September 22, 2026.

Poker Now official pricing: https://www.pokernow.com/subscription/plus, re-read September 22, 2026.

Operator-reported app costs: https://thepokeragent.com/create-poker-club/; not an official current checkout.

Historical PPPoker tier guide: https://worldpokerdeals.com/blog/how-to-create-your-own-pppoker-club.

Pokerrrr official Gold store: https://store.pokerrrrapp.com/; reported hosting review: https://www.pokerlistings.com/poker-sites/pokerrrr.

Independent union offers: https://topunion.club/; not app-vendor universal fees.

Self-hosted licenses: https://briggsoft.com/pmavens_buy.htm.

Free-management comparator: https://www.pokerstars.com/poker/home-games/.

Suprema official listing: https://apps.apple.com/us/app/suprema-poker/id1583176410.

Historical UPoker walkthrough: https://somuchpoker.com/news/how-to-create-your-own-online-poker-club-on-pppoker-pokerbros-or-upoker.

Current official distribution guidance: https://developer.apple.com/app-store/review/guidelines/, https://support.google.com/googleplay/android-developer/answer/9877032, https://stripe.com/legal/restricted-businesses.

Current Google Play digital-payments guidance: https://support.google.com/googleplay/android-developer/answer/9858738; evaluate the actual region/channel and product, not a blanket exemption.

PostgreSQL 17 isolation and locks: https://www.postgresql.org/docs/17/transaction-iso.html and https://www.postgresql.org/docs/17/explicit-locking.html; R2 re-read September 22, 2026. Retry whole failed transactions under stable business identity.

Stripe webhook event semantics: https://docs.stripe.com/webhooks; R2 re-read September 22, 2026. Existing diamond acquisition callbacks require verified, duplicate-safe handling; not a new operator cash subscription.

Apple guideline sections 3.1.1 and applicable multi-platform/channel exceptions: purchased currency lifetime and actual acquisition/display rules must be checked separately from time-limited software access. R2 re-read September 22, 2026.

The included competitor workbook preserves further SKU/package detail and its original evidence qualifications. Do not treat public marketing statements as audited operational guarantees or a license for real-money activity.

Appendix C: Integration Contracts And Completion Checklist

C.1 Required Actual Wiring Map

Before marking the corresponding phase complete, fill the existing checkpoint with the real source module, API/RPC signature, grant/role, database record, durable consumer, client reader and test that implement each row. These are required mapping categories, not new filenames or duplicate tables prescribed by this prompt.

Operation

Required End-To-End Link

Activate trial

Owner activation -> authoritative eligibility/scope policy -> one timed grant -> zero-fee capability reads -> visible expiry.

Quote

Selection -> current catalog/coverage/comparator -> immutable server quote -> exact diamond confirmation.

Buy

Accepted quote/mandate -> one atomic canonical debit/lot/register proof -> receipt/right -> committed UI update.

Renew

Accepted mandate/period -> durable due owner -> current authority/funds check -> one extension or clear attention result.

Upgrade

Current paid right -> actual remaining-value quote -> credited amendment -> correct new capacity.

Sponsor

Effective mandate/budget -> one payer's checkout -> beneficiary entitlement -> original-payer receipt/refund.

Export

Purchased data interval plus current data access -> snapshot job -> scoped output -> authorized retrieval.

Refund

Original allocated charge -> permitted unreversed return -> exact canonical gross/debt/net movements -> affected-right update.

Continue accepted event

Accepted gameplay identity -> frozen continuation contract -> completion/settlement despite operator expiry, without authorizing new unrelated operation.

Recover

Stable operation/version -> current receipt/job/ledger read -> resume/replay/resolve without another economic effect.

C.2 Required Assertions At The New Commerce Boundary

The authoritative accepted diamond amount equals the immutable sum of paid line allocations; temporary trial waivers create no debit or Mint issuance.

One consumed quote has one purchase; one request identity has one payload; one business renewal/asset/right is not purchased twice under different request keys.

Payer authorization is current and distinct from the beneficiary's data/ownership permissions.

Available balance respects actual existing reservations, frozen provenance, debt treatment and integer headroom without counting the same holding twice.

Required actual lot movements, canonical journal entries and Mint registrations match the operation before new purchase/refund commit.

No new refund/credit type receives a VIP earn multiplier. Refund principal and source treatment remain linked to the original net charge.

No external provider, report renderer or push service is called while financial locks are held. Its required work is durably owned afterward.

No old consumer interprets a zero retry debit as a free original purchase, personal session access as club capacity, or a paid report as unrestricted cross-club data permission.

Failed/lapsed renewal does not generate unapproved accumulated historical debt. Cancellation affects future authorization, not already paid rights.

Existing balances, prior paid benefits, accepted events, payouts, cash-outs and audit records survive expiry, partial failure and release recovery.

C.3 Commercial Facts That Must Not Be Invented

Candidate rates are not automatically current owner-confirmed prices; exact competitor rates are not known where the evidence register says unknown or reported. No exact capacity promise, external approval, independent certificate, supported split-payer policy, tax treatment, global cheapest claim, cash-redemption right, or profit forecast follows merely from this document.

Publish the actual validated allowed catalog and accurately scoped claims. Record any remaining material item-specific decision and keep executing independent approved work. Do not use uncertainty about one optional item as an excuse to leave the entire commerce implementation stubbed or to wait for an unrelated workstream.

C.4 Final Revision And Handoff Integrity

Preserve this complete revised specification in the actual task evidence location with its revision/hash, plus the maintained traceability register, architecture decisions, raw qualified test results and installed-state evidence. Do not append this revision below the original prompt as two competing instructions. The companion product prompt is unchanged in this package; coordinate its existing shared interface rather than silently rewriting its assignment.

At completion, list all phases 0-11 with their actual state, D01-D80 applicability/results, each unresolved scoped blocker, current PR/migration/runtime identities and the exact next action. Tests, documentation, implementation, installed trial activation and observed genuine paid revenue remain different claims.

Final Execution Instruction

Start Phase 0, preserve the existing economy and product boundaries, implement the complete server-authoritative diamond purchase lifecycle, qualify it under failure and concurrency, publish through the established routes, and verify actual installed behavior. Keep candidate rates, confirmed owner decisions, verified competitor comparisons, accepted customer authorizations and real paid receipts distinct. No OFC, no cash subscriptions, no permanent free tier, no table-hour tariff, no hidden fees, no double charges, no invented profitability, and no changes to gameplay economics to make the model work.
