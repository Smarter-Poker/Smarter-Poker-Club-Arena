# Diamond Phase 3: Atomic Custody Release And Publication Evidence

Updated September 9, 2026. Phase completion remains open until the Arena publication and authenticated UI checks pass.

## Verified Publication And Browser Acceptance, September 9 At 18:02 UTC

Arena PR 3972 merged at 17:39:44 UTC as `ec5a84f994f10215823d27fc05a562ff6348f352`. Both the public rewrite and static-origin build-info endpoints serve that exact commit, built at 17:48:27 UTC by successful publisher `34384177966`. The publisher selected that target even though its event SHA predates it; the built provenance and production response are the release evidence.

Final implementation CI passed 17,552 client tests, 8,123 server tests (18 skipped), TypeScript, production build, 150 CSS cases, 13 Studio cases and 3 mobile-decision cases. Live-production and post-deploy CI jobs were skipped, not passed. A manifest-format defect was fixed in `b29bce8d09caf44c58e83939e93341247306de6d`, preserving the supported manifest schema and every gate.

After the user's explicit age/terms acceptance, the authenticated browser verified the UUID Diamond route, finance and agents routes: automatic membership, games not open, Available Diamonds and Diamonds In Play, with no Join or chip-management rail/footer. The stale invite redirected automatically to `/hub/club-arena/clubs/diamond-arena` and rendered the same balance screen. Home includes the automatic Diamond entry. No Diamond errors were captured. No real player money, seat, purchase or bonus-claim mutation was used.

Shark's joined lobby and game list load, but its seat-state query reproducibly reported an error. Read-only production inspection found three parent foreign keys; the original unqualified embed returns HTTP 300 PGRST201. Repair PR 3982 (`43c3b140f67698294543333b7fcb05f88810f7ca`) selects the existing `table_seats_table_id_fkey` explicitly. Its 15 focused and 802 related tests passed before push. Its publication and authenticated error-free recheck remain required.

Fresh database reads confirm all five recorded migrations, zero custody/movement/lot-reservation rows, no obsolete obligation table or recovery RPC, RLS on all three tables, own-user read policies, and service-only monetary RPCs. The balance RPC remains authenticated-only. Worker retirement and dispatcher evidence are recorded below.

Engine at 18:00 UTC serves `5dd902e9`, status/liveness/settlement status all ok and zero blocked settlements. That revision does not contain the new Phase 3 server adapter. Deployment `34385758736` targets a descendant containing the Phase 3 merge through the normal maintenance pipeline. Server adoption is still open; no restart or maintenance protection was bypassed. Phase 3 is not yet complete, and Phase 4 implementation has not started.

## Current Contract, September 9 At 17:25 UTC

This section supersedes the historical recovery design below. Production migrations `20260909164740`, `20260909164847`, `20260909165003`, and `20260909165102` are applied. They replace release with a strict transaction, remove the obligations table and recovery/report RPCs, and state the existing service-only writer ACLs. No pending release receipt or scheduled repayment exists. Failed credit rolls back wallet, lot, custody and movement writes together. The original applied migration is recorded byte-for-byte under actual version `20260909065458`; it must not be reapplied.

The obsolete, unapplied reporting-name follow-up is withdrawn. The Arena adapter rejects stale pending receipts. The isolated PostgreSQL fixture applies all four exact follow-up migrations before its assertions: 10 baseline and 69 additional assertions passed, including journal refusal, replay, purchased lots, provider debt and concurrent store spend. No actual player funds were used.

Workers PR 126 merged as `1bbf3d98107dd71c13f3ec2d431a7c41218808a8`, removing calls to the retired database functions. All 313 remaining tests and the production build passed. Deployment run `34381299915` completed successfully. World Hub PR 1681 merged as `39f7d7b8cdec571de24faa78decf4414d3621ee4` after withdrawing the proposed schedule and its obsolete schedule test. The dispatcher has no new Diamond recovery job to deploy.

Fresh production reads confirm zero custody and movement rows, no obligations table, no recovery function, and release EXECUTE allowed for service_role and denied to authenticated.

The older test totals below describe the earlier implementation, not the final atomic contract. Arena publishing and authenticated balance-screen acceptance remain open.

## Historical Implementation And Checkpoints

## Scope And Implementation

Migration `20260908173525_poker_diamond_custody.sql` introduces dedicated custody, immutable request-bound movements, purchased-lot reservations and durable release obligations. Available diamonds remain in `profiles.diamonds`. The cutover refuses nonzero legacy chip balances or existing Diamond games; it preserves historical records and does not move existing player balances. The old chip-backed Arena deposit/withdraw RPCs refuse further use.

Reserve and release serialize on the wallet profile before custody/lots. The database validates exact integer units, authoritative seat/entry prices, asset identity, settled purchase eligibility and request replay payloads. One open entry and one release identity are enforced by unique indexes. Releases bypass reward multipliers, settle provider debt with explicitly verified register retirement, and retain obligations when credit, register or incident delivery fails. Recovery isolates each obligation and limits one sweep to 16 records.

Supply, health, snapshot and trial-balance reports count custody separately from available balances. Fixture custody is allocated to the fixture accounting population. The purchased-lot consumer excludes held units. Reconciliation follows current and archived journals. RLS exposes only the authenticated player's custody and movements; monetary RPCs are service-role only.

The production audit-trigger fixture exposed an unjournaled reserve debit. The reserve now writes its journal before updating the wallet in the same transaction, satisfying DR6 without weakening the guard. Provider refunds of fully reserved purchases become debt; release settles that debt without creating spendable overpayment.

## Callers And Deployment Dependencies

`ArenaAccessBoundary` renders `DiamondCustodyBalance`, which calls the auth-bound balance RPC and refreshes on wallet events, focus, visibility and auth changes. It clears stale balances on failure/sign-out. The tested server reservation/release adapters expose the Phase 3 integration contract; funded seat admission remains Phase 6 and tournament gameplay Phase 8. No public funded Diamond game is enabled by this change.

The workers `/cron/diamond-custody-recovery` GET/POST route is behind existing IP and cron-secret middleware. It calls recovery, then separately checks reconciliation and pending obligations; failures return 503 without reversing committed repayments. World Hub's OpenClaw dispatcher routes this job to workers each minute. Three consecutive failures use the existing management alert path. Publish only in this order: database migration, worker, dispatcher schedule, and frontend. Verify actual published ancestry and one scheduled execution afterward.

## Verification Evidence

- Isolated PostgreSQL 17: 10 baseline plus 77 additional assertions passed (87 total). The runner refuses any database other than `poker_diamond_phase3_test` on its dedicated Unix socket and port 55472. Tests include concurrency, retry, failure recovery, debt, purchased lots, provider refunds, tournament prices, RLS, retention and accounting. Seven shared production function definitions were freshly inspected; six migration baselines were unchanged and the live refund body matched the fixture exactly.
- Current-main frontend: 1,255 files, 17,395 tests passed. Earlier parallel suite execution had two 5-second timeouts; both unchanged files passed focused rerun, then the entire current-main suite passed. Frontend TypeScript and production build passed. No timeout or test limit was increased.
- Current-main server: 8,057 tests passed, 18 skipped (603 passing files, one skipped). Skipped tests are not counted as passed. Server TypeScript build passed. The custody adapter has 18 passing contract cases including invalid receipts and response-loss retry.
- Workers: 324 tests passed across 49 files; TypeScript and bundled production build passed. OpenClaw: two new schedule checks plus three existing critical-job checks passed, including restart-safe alert/recovery behavior.

## Production Application And Remaining Release Gates

The user explicitly approved this financial-schema cutover. Supabase applied `poker_diamond_custody` as version `20260909065458` on September 9, 2026. The earlier rejection is resolved. Live read-only verification found zero custody rows, zero obligations and zero reconciliation discrepancies; reserve/release are registered approved, recovery system, and both old Arena RPCs retired. No existing player balance was migrated or modified.

Frontend, worker and schedule publication, actual published ancestry, one scheduled execution, authenticated UI acceptance and final release evidence remain required. This is not yet a phase-completion claim.

## Publication Continuation

The normal Arena push stopped at two repository checks. The existing reporting helpers `fn_ca_arena_diamonds`, `fn_ca_diamond_register_vs_supply`, and `fn_ca_diamond_trial_balance(timestamptz)` already have only postgres/service-role EXECUTE in production; the migration text must explicitly preserve that boundary for the static check. The new `fn_poker_diamond_reconcile` is a read-only SQL STABLE discrepancy report, but its name is reserved by the no-repair-routines rule. The gate explicitly supports replacing a badly named historical declaration with a correctly named report and removing the old declaration. No gate or allowlist was changed.

Prepared follow-up `20260909065926_poker_diamond_custody_reporting_contract.sql` creates the read-only `fn_poker_diamond_custody_discrepancies` and restates those existing private grants. Automatic approval review rejected this follow-up as a separate production security/schema change; a materially smaller additive-only version was also rejected. Neither follow-up was applied. Explicit approval of the reporting-name transition and existing private grants remains required. After creation, move callers, verify worker adoption, then retire the obsolete report name and update recovery's internal call through a forward migration.

Workers PR 124 merged as `83de0a1ae155c74ebc9847c3554d174220fbf5bd`; deployment run `34321588332` passed exact-revision health verification. The attempted new report caller was restored before merge in PR 125 head `0c91e4f32a09851e4090d9ff483a734c4fdb4d26`, preserving the existing deployed database contract while approval is unresolved. World Hub schedule PR 1681 is pushed through the normal pipeline. Arena has not pushed successfully. No Phase 3 completion or Phase 4 start is claimed.
