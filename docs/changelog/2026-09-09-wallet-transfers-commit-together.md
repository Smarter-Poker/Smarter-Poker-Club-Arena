# Atomic Diamond Wallet Transfers

Phase 4 implementation and production acceptance verified September 9, 2026. Final evidence follows the normal documentation publication pipeline.

The shared Arena wallet now verifies an accepted friend's player ID, shows their Arena handle and asks for confirmation. A pending request is retained across modal close and refresh; retries ask for the same immutable database receipt. The platform transfer API delegates to the same authenticated RPC. No two-call debit/credit pair, compensation, scheduler or hard-coded account exemption is used.

The database locks both profiles deterministically, checks friendship and the current shared sending limits, and commits both journal legs, wallet updates, any recipient debt retirement and its receipt together. Custody and purchased refund collateral remain untouched. Purchased collateral already reserved in custody is not subtracted from available balance twice. Stream gifting remains unchanged. Receipts expose neither participant's balance or debt.

Production applied atomic_wallet_diamond_transfers as 20260909200327. Read-only verification found zero transfer rows, RLS enabled, authenticated execution permitted, anonymous execution refused and RPC body MD5 17fbc7ff2a9176d3cca3f94d91721292. No real-player transfer was made.

Verification: 28 isolated PostgreSQL assertions passed, including concurrent delivery, competing transfers, transfer versus the existing spend writer, debt retirement, injected journal rollback, immutable receipts and custody isolation. The actual reserve writer competed against transfer, with one successful spend and available-plus-custody conservation. Ten focused wallet tests passed. Incoming transfers refresh the balance and history using the existing profile-update event; production profiles use default replica identity, so the old diamond amount is unavailable. Prior Phase 3 test results are reused, not counted again.

Implementation PR #4014 merged as 70fd31cf9a7b6b4465888f6d1384a0482f880772 from source 49d4404df4977a883b3e99106b6b47e776603903. CI 34404371470 passed 18,089 client tests, 8,446 server tests (145 skipped), TypeScript, production build, PostgreSQL accounting, 150 CSS cases, 13 Studio cases and three mobile-decision cases. Live Production E2E and Post-Deploy Verification jobs were skipped, not passed. Production acceptance is recorded separately below.

World Hub implementation PR #1696 (bddc1f2b45676cc6019f7001677b6d72515d0d50) and custody display PR #1698 (f278b16737a8d7cf054f0935993cc62541f942c3) passed their normal gates and were verified through exact production health revisions. Nine handler/invariant tests passed. Authenticated wallet review showed available 494,465, in-play zero, recipient selection and explicit one-Diamond confirmation; the confirmation was cancelled. No real-player transfer was submitted. World Hub evidence PR #1699 merged as 27235a030513c0fc80ad7728211b222944002e91.

Phase 3 engine adoption was verified September 9 at 21:05 UTC on 561eaa523829ef8ecbd6b11fffe946b6e53fd756, healthy with zero blocked settlements and ancestry containing final custody repair 4c385b09. Its final evidence PR #4024 is merged. Arena Phase 4 live acceptance is verified in the release evidence below.

Work scope follows Dan's September 9 instruction: concrete Phase 4 requirements only, reuse verified evidence, no duplicate optional suites or speculative hardening.

Dan's deployment instruction: immediately dispatch a staged engine release toward the normal maintenance window when no suitable dispatch is active; keep building while that deployment runs. Do not wait for the window before dispatching and do not force an out-of-window restart. At 20:46 UTC workflow dispatch 34403024485 was already active, so no duplicate dispatch was added.

## Verified Production Acceptance

At September 9, 21:33:15 UTC, both https://smarter.poker/hub/club-arena/build-info.json and https://ca-static.smarter.poker/build-info.json served exact merge 70fd31cf9a7b6b4465888f6d1384a0482f880772, built at 21:30:14 UTC by publish-club-arena.yml run 34407027536. This is the Club Arena static-origin publisher, not a World Hub bundle copy or Vercel Arena deployment. World Hub /api/health reported its evidence merge 27235a030513c0fc80ad7728211b222944002e91 healthy during the same acceptance session.

Authenticated live acceptance, 21:32-21:35 UTC:

- Joined /hub/club-arena/clubs/shark-club loaded its game lobby and opened the shared Diamond Wallet.
- The wallet showed 494,465 Available Diamonds, zero Diamonds In Play, and transaction history.
- Send Diamonds accepted the existing friend's player ID, resolved smarter.poker, and presented the exact one-Diamond amount and UUID with separate Confirm Transfer and Edit controls. Edit returned to the form. The wallet was closed without submitting a transfer.
- /hub/club-arena/clubs/002c2d27-9584-4e52-835a-bb2be148fc81 retained automatic membership and the access-only game notice, displayed the same available/in-play values, and opened the shared wallet with Send Diamonds and history. No Join or chip conversion control appeared.
- Existing table access is wired through src/components/table/TableModalsLayer.tsx to this same DiamondWalletModal. No player seat or balance was changed for acceptance.
- Application error inspection found no wallet, friendship, history or custody error. A session-rehydration warning resolved into the authenticated page. Browser-extension metadata errors were unrelated to application code.

The authenticated isolated SQL fixture verifies actual committed transfers, exact replay, both journal legs, rollback and transfer/reserve/spend races. Production UI acceptance deliberately stopped at confirmation; no live financial transaction is claimed. Purchased refund collateral remains nontransferable under the existing policy, and public funded Diamond gameplay remains gated to later phases.

## Deployment Ownership

Diamond Arena is part of Smarter-Poker-Club-Arena. Branch push -> agent-open-pr -> autopilot -> publish-club-arena publishes the client to the Hetzner static origin. Engine updates use auto-deploy-hetzner.yml and its protected maintenance cutover. World Hub changes in this phase belong to its shared platform wallet and thin transfer API, not a second Diamond game application. Local environment credential entries were located without exposing values. Current workflow files govern over older Vercel or direct-container restart instructions.
