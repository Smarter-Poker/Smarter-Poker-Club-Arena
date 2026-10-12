# 2026-10-05 Timeout and reconnect upgrade, client finish

Follows `2026-10-04-timeout-and-reconnect-audit-client.md`. Client change:
uses engine behaviour that is already live (RESYNC, requestSnapshot). No
engine dependency.

## The banner says when the device is offline

With `navigator.onLine === false` the reconnect ladder waits on the
browser's `online` event, not on the table. `labelFor` takes the offline
verdict and, for `reconnecting` and `failed` only, says "You Are Offline.
Reconnecting When Your Connection Returns". The banner follows
`navigator.onLine` and the `online`/`offline` events. Sign-in and access
verdicts still outrank it; the reconnect behaviour is unchanged.

## A foreground resume in the native app resyncs the table

The transports resync on `pageshow`/`visibilitychange`, which the Capacitor
shell does not guarantee on return from the background; `appStateChange`
only resumed audio. The shell now dispatches `NATIVE_RESUME_EVENT`
(`src/lib/nativeResume.ts`) on the foreground edge and both EngineStateClient
classes handle it exactly as a `pageshow`: a live link runs its bounded
RESYNC probe, a dead one the single-flight reconnect path.

## An action whose answer was lost is checked before the bar returns

`ACTION_NOT_DELIVERED` includes a first send that executed with its response
lost. `submitActionWithToast` now asks the engine for its state once
(`requestSnapshot`) and waits, bounded at 2.5 s, for that snapshot before
reporting and reverting (`src/lib/awaitEngineState.ts`). The revert already
hands nothing back once the engine's decision has moved on, so a landed
action stays landed.

## Already done: the client failsafe fold

The client-side expired-turn fold was removed on 2026-10-04 and is pinned by
`tests/unit/theEngineOwnsAnExpiredTurn.test.ts`; nothing to remove.

## Tests

- `tests/the-table-says-when-the-device-is-offline.test.tsx`
- `tests/engine-state-client-recovery.test.ts` (four cases added)
- `tests/a-lost-answer-is-checked-before-the-bar-returns.test.ts`

## Not verified

Not published; not exercised on a device or in a browser. The TablePage
wait is pinned by source and the helper by unit test, not by a mounted page.
