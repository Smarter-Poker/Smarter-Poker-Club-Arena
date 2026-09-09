# Diamond Phase 3: Verified Implementation, Production Cutover Pending

Updated September 9, 2026. This is not a phase-completion or publication claim.

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

## Open Release Gate

Read-only production preflight found one Arena setting, zero nonzero legacy balances, zero Diamond tables/tournaments, and no existing custody relation or reserved migration version. Automatic approval review rejected applying the exact production migration because it changes financial schema and wallet functions and retires the old RPCs; explicit approval of this cutover is required. No production DDL was applied. Do not bypass this rejection or publish dependent code before the database exists. After approval: apply through Supabase, record the actual migration version, run advisors and live read-only checks, publish through normal hooks/autopilot, verify the scheduled recovery and authenticated live UI, then close the phase gate.
