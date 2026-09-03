# Problem 025 — HTTP 429 Rate-Limit Rejecting Legitimate Human Actions

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena (server)
**Date Found:** 2026-04-17 (live E2E, hero table on production)
**Date Fixed:** 2026-04-17 (commit b556640, Hetzner redeploy via AG)
**Severity:** MAJOR — renders table unplayable from a user's perspective
**Status:** FIXED in production — live double-tap repro pending

## Deploy verification (2026-04-17)

AG pulled `main` into `/opt/club-arena` on `178.156.160.206` (the live path — the
`/srv/club-arena-server` path from BUG 022's note does not exist on this VPS;
that memo was wrong about the current layout). Fresh compile, new image
`695480030fa8`. Post-restart: `uptime 20s`, `activeTables 1`, `totalHandsDealt 58`.
Binary check inside container: `dist/index.js:2654: const RATE_LIMIT_MS = 250;`.
`.env` (`TEST_TABLE_ID`, `MAINTENANCE_MODE`) untouched.

## Discovery

Dan on `/hub/club-arena/table/59938155-...`, his turn, pre-action not armed, active FOLD / CALL / RAISE panel visible. Tapped Call. UI surfaced an `ActionErrorToast` reading "Server error (429)". Retried — same toast. Took over screen, confirmed via screenshot: action panel buttons are wired, click events bubble to document (`bubbled: true` in DOM probe), and the server genuinely returned HTTP 429.

## Root cause

`server/src/index.ts:3140` — rate limiter set to **100ms per player**:

```ts
const RATE_LIMIT_MS = 100; // Minimum ms between action submissions per player
```

`checkRateLimit(userId)` rejects with 429 if `now - lastAction < 100`. Two places can submit within that window:

1. **Human double-tap** — iOS taps land 50–120ms apart routinely when the user is nervous or the UI is laggy
2. **Pre-action useEffect race** — client-side pre-action executor (`TablePage.tsx:4894`) fires `handleFold/handleCheck/handleCall` on a 100ms `setTimeout` after it becomes hero's turn. If the server has already executed the pre-action internally (`ServerTableEngine.ts:3566`) and the client's subsequent `/action` POST lands before the `currentPlayerSeat` broadcast invalidates the useEffect dependencies, the POST hits an empty rate-limit slot → 200 (OK) then a second human click 100ms later → 429.

Client side already has a 300ms `actionLockRef` debounce in every handler, so client-initiated double-fires are suppressed. The server limit was simply too aggressive for the intended input cadence.

## Fix (shipped this session, pending Hetzner redeploy)

Raised `RATE_LIMIT_MS` from 100 → 250ms. At 4 actions/sec max the limiter still blocks bot/script abuse while accommodating human double-taps and pre-action/real-action transitions.

```ts
const RATE_LIMIT_MS = 250; // BUG 025 — raised from 100ms (too tight for humans)
```

Compiles clean (`npx tsc --noEmit` in `server/` → exit 0). Requires Hetzner redeploy.

## Follow-up (not shipped)

- **BUG 026** — `cleanupStaleData()` should never wipe `table_seats` (see 022 follow-up).
- **Stretch** — the client pre-action useEffect is redundant with the server-side `preActionEngine.executePreAction` (`ServerTableEngine.ts:3566`). Keeping both is defense in depth, but introduces the race described above. Long-term: remove the client-side execution and rely solely on server's internal pre-action handling, then let the normal broadcast advance the UI.

## Verification plan (post-deploy)

1. Confirm `/health` uptime resets (new SHA).
2. Play 5 hands on test table; intentionally double-tap Call at ≤150ms gap; expect 0 toasts.
3. Arm a pre-action (Fold), let turn arrive, confirm single engine-side execution (no 429, no double-processing).
4. Telemetry check: `rate_limit_rejections_total` metric should stay flat or drop to near-zero over 1 hour of normal play.

## Related

- BUG 022 — Hetzner engine fleet recovery; TEST_TABLE_ID env-var pattern
- BUG 024 — Pre-action bar visual-feedback gap (CSS-only, separate)
