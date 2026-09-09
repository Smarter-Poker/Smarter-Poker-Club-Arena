# Phase 9: financial reconnect and refresh ownership

## Findings and repair

The engine financial channel is push-only. ChannelHub.addConnection registers
its authenticated socket without sending a financial snapshot. A page read
can therefore miss changes before the first open as well as during a reconnect.
Browser online, pageshow, and visibility recovery reset the retry count, so a
reopened connection passes through connecting. useRealtimeFinancials wrongly
classified that status as an initial connection and skipped BALANCE_UPDATED.
The hook now invalidates on every connected transition. Pong traffic does not
create another transition or another refresh.

Following that event into its consumers exposed two more lost-update paths.
CashierPage used a cacheable loadBalances call even for confirmed changes, so
its 30-second cache could ignore recovery. That callback now forces a read.
The wallet store previously coalesced a forced refresh into any older pending
read. It now retains an invalidation and runs one trailing snapshot for a burst
of events. Changes arriving during that snapshot request another trailing read.
An invalidated snapshot cannot briefly publish its stale result. Normal mount
calls still share one request and retain the existing cache and loading policy.

Both displayed balance stores now retire stale responses. useGlobalBalanceSync
checks the latest request, effect lifetime, and current account before writing
totalChips. The wallet store's active load record owns publication and loading
cleanup; a reset or different account retires it and its queued refresh.
Unknown or failed reads continue to preserve the last known balance.

## Wiring and scope

CashierPage and PlayerWalletPage mount useRealtimeFinancials. Both consume
BALANCE_UPDATED. App mounts GlobalBalanceSync for the shared chip display.
loadBalances is the existing triple-wallet display reader. No additional
socket, polling timer, database migration, or financial mutation was added.
Diamond reads, ledger writes, game timing, and engine authority are unchanged.

## Reproducible verification

- Before the hook and global-store repair: 10 failed, 8 passed across the two
  regression suites. The real EngineChannelClient runs against a fake socket;
  the hook and its lifecycle are real, with deferred authoritative read results.
- Before the wallet-store repair: 4 failed, 5 passed in walletStoreCoalescing.
  Failures cover a lost trailing invalidation, a second change during recovery,
  a response after reset, and a response from a previous account.
- After repairs: 144 tests passed across 8 focused suites, including existing
  transport refusal/recovery, unknown-balance, cache and coalescing coverage.
  The Cashier callback is located structurally with the TypeScript parser and
  executed against the real store with a fresh cached balance.
- npx tsc --noEmit passed with no diagnostics.
- The final production build passed (13.48 seconds), with provenance
  a60cbac528d26847bc522eb27d470d34ab6b82ef and behind-main=0.
  An earlier build correctly refused a checkout that became one commit behind
  main. The interrupted rebase and its commits were preserved; the patch was
  transferred to a fresh isolated worktree. No hook or review was bypassed.
- Normal push gates passed: 29 direct tests, 2,837 related tests across 246
  files, and 226 source-reading checks across 11 files. No --no-verify was used.
- CI run 34323617873 passed TypeScript, production build, all four client test
  shards, and the CSS/component E2E job. Live Production E2E was skipped, so it
  does not establish authenticated production acceptance.
- PR3955 merged automatically at 2026-09-09 07:31:18 UTC as
  9a20a259ef888dc51262e17faa27c889a6c5ffe8. The four runtime files on main
  match the tested PR head exactly.

Physical iPad/PWA and authenticated live-player acceptance remain unverified.
The previously offered secure sign-in was cancelled; this phase does not retry
it or infer device success from automated tests or published bytes.

## Published release

Public and origin build-info were freshly read at 2026-09-09T07:40:30.169Z. Both served
9a20a259ef888dc51262e17faa27c889a6c5ffe8, built at 2026-09-09 07:37:03 UTC
by publisher run 34324555902. The previously queued run was superseded;
its cancellation was not treated as a release failure or deployment proof.

The actual public HTML references index-CelZsBvu-v6.js; its Cashier import
references CashierPage-BS24HlPQ-v6.js, which imports
useRealtimeFinancials-BBY34oep-v6.js. All four changed functions were parsed
from these served assets and compared to the tested build, preserving
identifier relationships, properties and literal values. All four matched.
Executing the served status callback in an isolated context produced exactly
two BALANCE_UPDATED events for first open and a reconnect through connecting.

Exact fresh URLs, timestamps, asset SHA-256 values, comparison results,
ancestry and publisher step evidence are stored in
`docs/audits/2026-09-09-realtime-phase9-publication.json`.
This establishes publication and automated behavior, with the authenticated
and physical-device acceptance limitation above still open.
