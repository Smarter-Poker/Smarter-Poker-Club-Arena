# Daily Missions Phase 7 — Production Certification

## What Changed

- Added an opt-in, serial production certification that creates one reserved temporary player and drives the deployed Daily Missions UI through cold load, reroll, streak-freeze purchase, realtime completion, claim-all settlement, alert disconnect recovery, injected network failure recovery, and mobile keyboard/accessibility checks.
- Added exact-once assertions for reroll, freeze, and claim reward ledgers, including replaying the captured claim request UUID against the authenticated production RPC.
- Added a Page Object for deterministic Daily Missions authentication and navigation with role-based locators and condition-based waits.
- Extended the prefix-guarded temporary-account cleanup to remove and verify mission, notification, push outbox, wallet, idempotency, diamond, and chip-ledger residue before hard-deleting the Auth identity.
- Added an online `wallet_credit_idempotency(user_id)` index after the first real cleanup exposed a player-scoped receipt scan timing out in production.
- Moved the reward-settlement dialog into a document-body portal and removed pointer events from decorative card chrome so fixed global navigation cannot intercept confirmation or Continue controls.
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
