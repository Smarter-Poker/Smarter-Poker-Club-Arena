# Diamond Phases 3 Through 5 Recheck

Status: In Progress. World Hub Lobby Image Excluded By Dan.

## Confirmed Phase 4 Gap

Production `send_wallet_diamond_transfer` still matches the recorded Phase 4 source MD5 `17fbc7ff2a9176d3cca3f94d91721292`. It checks `auth.uid()` at entry but does not call the existing `fn_caller_session_is_live`. The configured Data API pre-request hook governs server actor/lease headers and returns for ordinary unmarked browser requests; it does not validate user sessions. A signed JWT naming a revoked session therefore reaches this monetary writer.

The scoped correction will call the existing session guard before profile locks or receipt access. No new auth system, wallet path, fee, or compensating transaction is introduced.

`DiamondWalletTransfer.tsx` currently clears its saved request for all SQLSTATE 42501, 22023 and P0001 errors (send error branch around lines 120-129). A session refusal can occur while retrying an earlier committed transfer whose response was lost. Clearing that request would discard its replay identity. The client will clear only an explicitly identified refusal that occurs after the writer proves no previous receipt exists; session and ambiguous failures must retain the exact request.

## Source Review

Phase 3 custody adapter and all five applied migration sources are unchanged since their verified release. Its balance refresh and shell changes are the audited Phase 4 profile event subscription and Phase 5 shared navigation/wallet integration.

Phase 4 runtime files and transfer migration are unchanged since release. Phase 5 shell differs only in the separately committed Diamond card chassis/countdown update; preserve that approved work and inspect current entry behavior. No World Hub lobby image work belongs to this recheck.

## Open Verification

- Reproduce revoked-session and response-loss behavior in isolation, apply and test the scoped correction.
- Verify production custody contracts, ACL/RLS, retirement and balances without changing player funds.
- Verify actual frontend, World Hub and engine source ancestry and authenticated routes.
- Publish this correction and final evidence through branch push, agent-open-pr and autopilot.

Phase 6 increment PR #4070 is merged as `81e4c6daefa47f6b6883596f3b62d2d3498e195a`. Its normal engine deployment is already active; no duplicate dispatch or forced restart is needed.

## Targeted Repair Validation

- The old production transfer body was reproduced in the isolated Phase 4 database: an authenticated JWT with no live session could commit a fixture transfer. That negative control ran inside a rolled-back transaction.
- The forward migration reuses the deployed live-session helper at the existing authentication check. A source hash prerequisite prevents replacing an independently changed writer. Receipt ordering, money accounting, RLS and authenticated-only execute grants are preserved.
- All 37 SQL assertions passed: the existing 28 transfer/custody/concurrency assertions plus the negative control and eight session/refusal/replay assertions. Missing, revoked, expired and malformed sessions leave profiles, journals and receipts unchanged. A fresh live session retrieves the original receipt without another transfer.
- The new client regression failed against the old component (five existing tests passed). After narrowing the definitive-refusal branch, all six tests passed. A lost response followed by session refusal preserves the original request across remount and reauthentication.
- Authenticated Diamond entry was checked in a new verification tab: automatic membership, pre-release message, available balance 494,465 and in-play 0; no chip management rail or footer.
- Release ordering: publish the client retry fix before applying the new database guard, so older client error handling does not discard unresolved transfer identities.
- Production migration, final published ancestry and remaining live route acceptance are still open. No production balances or seats were mutated.
