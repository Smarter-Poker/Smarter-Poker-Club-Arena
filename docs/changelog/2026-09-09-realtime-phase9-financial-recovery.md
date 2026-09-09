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
- Build, normal push gates, CI, merge, and served publication evidence are
  recorded when complete. An initial local build correctly refused a checkout
  that became one commit behind main; no guard was bypassed.

Physical iPad/PWA and authenticated live-player acceptance remain unverified.
The previously offered secure sign-in was cancelled; this phase does not retry
it or infer device success from automated tests or published bytes.
