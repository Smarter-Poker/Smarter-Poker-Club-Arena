# Daily Missions Phase 7 — Production Certification

## What Changed

- Added an opt-in, serial production certification that creates one reserved temporary player and drives the deployed Daily Missions UI through cold load, reroll, streak-freeze purchase, realtime completion, claim-all settlement, alert disconnect recovery, injected network failure recovery, and mobile keyboard/accessibility checks.
- Added exact-once assertions for reroll, freeze, and claim reward ledgers, including replaying the captured claim request UUID against the authenticated production RPC.
- Added a Page Object for deterministic Daily Missions authentication and navigation with role-based locators and condition-based waits.
- Extended the prefix-guarded temporary-account cleanup to remove and verify mission, notification, push outbox, wallet, idempotency, diamond, and chip-ledger residue before hard-deleting the Auth identity.
- Added an online `wallet_credit_idempotency(user_id)` index after the first real cleanup exposed a player-scoped receipt scan timing out in production.
- Added a service-role-only, certification-email-guarded cleanup RPC with a bounded extended statement window after the full production account graph exceeded the generic Auth Admin request timeout; its forward correction removes mission/reward rows in trigger-safe order before Auth and proves Auth, profile, and legacy identity rows are all gone.
- Moved the reward-settlement dialog into a document-body portal and removed pointer events from decorative card chrome so fixed global navigation cannot intercept confirmation or Continue controls.
- Reserved the live responsive Club Arena footer clearance at desktop and mobile widths so mission controls cannot sit underneath its navigation hit targets.
- Made the production journey center and geometry-check every page-level mission control above the fixed footer before activation, matching the scroll a player performs while preventing false navigation clicks.
- Split realtime certification into explicit channel-ready, server-revision, and client-vault assertions so a lost event cannot be misdiagnosed as a progress-trigger failure.
- Made the final telemetry gate require only unsampled mutation events; the cold-load receipt remains directly asserted while its intentionally 20%-sampled `dashboard_loaded` signal is treated as optional.
- Isolated the mission-alert contract from the unrelated app-level first-run push sheet, preventing its delayed modal from covering Claim All or requesting browser permission during certification.
- Wired the suite into the post-deploy production workflow so a spec that needs a real deployed page cannot silently become orphaned.

## Release Gate

The production certification is disabled unless `DAILY_MISSIONS_CERTIFICATION=1` and the service-role environment is present. CI enables it only after a successful production publish. Every fixture uses the reserved `ca-customization-cert-...@example.invalid` namespace; cleanup refuses any other account.

## Verification Contract

- One dashboard aggregate request on cold load within the production latency budget.
- Exactly one 10-diamond reroll receipt and one 5,000-diamond freeze receipt under double activation.
- Realtime vault opening without navigation after server-side progress completion.
- One claim RPC from double activation, one batch/credit receipt, and an idempotent replay response.
- Alert preference recovery without invoking browser notification permission.
- Visible network failure, successful explicit retry, no horizontal mobile overflow, 44px alert control, and correct roving-tab keyboard/ARIA behavior.
- Hard-delete plus zero-residue verification for the temporary production player.
